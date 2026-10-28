// "Հավաքագրիր պարտքը" (collect the debt): after every ERP sync, a sales rep gets
// an automatic task for their next visit to each of THEIR customers that is
// overdue with debt (Excel debt > 0 and its oldest unpaid invoice older than the
// customer's credit term, `customers.credit_term_days`, default 45; see debtAge.js).
//  - channels KF and CAS are skipped (owner's rule); customers nobody has to visit (SM B2B, CVO, PCO, OEM) get a CALL
//    task (task_kind call_customer, owner 2026-10-18) instead of a visit task: it goes to the assigned rep, or to the
//    sales director (Martin) when the customer has no sales manager;
//  - one open automatic task per customer (unique index, migration 102);
//  - after a rep closes one, no new one for the same customer for 14 days;
//  - when the debt is gone the open task is closed as done; when the debt is still there but
//    not overdue (older tasks created by the previous, cruder rule) it is cancelled;
//  - each rep gets ONE notification per run, not one per customer;
//  - at most MAX_PER_REP new tasks per rep per run (largest debts first), so
//    the first run does not bury a rep under dozens of tasks;
//  - the rep records the OUTCOME when closing it (paid / partial / promised on a
//    date / no answer / refused). While a promise date is in the future no new task
//    is created; when it has passed and the debt is still there, a new task is
//    created at once and the sales director is told the promise was broken.
// A second kind, `reorder_followup`, asks the rep to call or visit a customer who
// stopped ordering in their usual rhythm (see createReorderFollowupTasks).
import { bulletNames } from "../utils/bullets.js";
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { queueSyncNotice } from "../erp/syncNotifier.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { DEBT_AGE_LATERAL, overdueDebtSql, debtAgeDaysSql } from "./debtAge.js";

export const DEBT_TASK_TITLE = "Հավաքագրիր պարտքը";
export const REORDER_TASK_TITLE = "Հաճախորդը վաղուց չի պատվիրել՝ զանգահարիր կամ այցելիր";
// Customers nobody has to visit (owner, 2026-10-18): Vaghinak gives their rep a CALL task instead of a visit task.
export const CALL_CHANNELS = ["SM B2B", "CVO", "PCO", "OEM"];
export const isCallChannel = (channel) => CALL_CHANNELS.includes(String(channel ?? ""));
export const DEBT_CALL_TITLE = "Զանգահարիր՝ հիշեցրու պարտքի մասին";
export const REORDER_CALL_TITLE = "Զանգահարիր՝ հարցրու՝ պատվեր պետք է՞";
const MAX_PER_REP = 15;
const COOLDOWN_DAYS = 14;

// A real extract has hundreds of customers; fewer rows than this means an empty / test sync, so "this customer is
// not in the extract any more" proves nothing (see the drop-out rule in createDebtCollectionTasks).
const MIN_ERP_ROWS_TO_TRUST_ABSENCE = 20;

// The customer paid since the task was created: the workbook's last payment date, or a payment row in its cashflow
// (bank transfers reach the app ONLY this way). Uses the task (t), customer (c) and erp aliases of the UPDATE below.
const PAID_SINCE_TASK_SQL = `(COALESCE(erp.last_payment_date >= (t.created_at AT TIME ZONE 'Asia/Yerevan')::date, false)
  OR EXISTS (SELECT 1 FROM erp_cashflow_lines cf WHERE cf.erp_customer_id = c.erp_customer_id AND cf.amount_amd > 0
               AND cf.cashflow_date >= (t.created_at AT TIME ZONE 'Asia/Yerevan')::date))`;

// KF and CAS are never chased; OEM (like CVO, PCO and SM B2B) is chased by CALL tasks only (CALL_CHANNELS).
const SKIPPED_CHANNELS_SQL = `COALESCE(c.sales_channel, '') <> ALL(ARRAY['KF', 'CAS'])`;
// Overdue = the oldest unpaid invoice is older than the credit term (see debtAge.js).

// Who is shown as the creator of automatic tasks: a sales director, else the CEO, else an admin.
async function systemCreatorId(db) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE role IN ('sales_director', 'ceo', 'admin')
     ORDER BY CASE role WHEN 'sales_director' THEN 0 WHEN 'ceo' THEN 1 ELSE 2 END, id LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

// The sales director who receives CVO / PCO debt tasks that have no sales manager: the one named
// Martin if there is one, else the first sales director.
async function martinId(db) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE role = 'sales_director'
     ORDER BY (name ILIKE '%martin%' OR name ILIKE '%մարտին%') DESC, id LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

// The task title in plain words (owner, 2026-10-24/25): the rep sees BOTH facts -- how old the oldest unpaid invoice is, and how many days the
// customer is past the credit term -- so they can talk to the customer properly:
// "Հավաքագրիր 2,420,000 դր պարտքը (94 օրվա հաշիվ, ժամկետից 49 օր ուշացում), վերջին վճարումը արվել է 23.10.2026-ին"
const amdPlain = (n) => `${Math.round(Number(n)).toLocaleString("en-US")} դր`;
const dmy = (d) => {
  const [y, m, day] = String(d).slice(0, 10).split("-");
  return `${day}.${m}.${y}`;
};
export function debtTaskTitle({ call, debt, daysOpen, termDays = 45, lastPayment, promiseBroken }) {
  let age = "";
  if (daysOpen != null) {
    const late = daysOpen - termDays;
    age = late > 0 ? ` (${daysOpen} օրվա հաշիվ, ժամկետից ${late} օր ուշացում)` : ` (${daysOpen} օրվա հաշիվ)`;
  }
  const paid = lastPayment ? `, վերջին վճարումը արվել է ${dmy(lastPayment)}-ին` : "";
  const head = call ? `Զանգահարիր՝ հիշեցրու ${amdPlain(debt)} պարտքի մասին` : `Հավաքագրիր ${amdPlain(debt)} պարտքը`;
  return `${head}${age}${paid}${promiseBroken ? " · խոստումը չի կատարվել" : ""}`;
}

// A task created for a rep, for the single notification a run sends per rep.
function addTo(map, repId, entry) {
  const list = map.get(repId) ?? [];
  list.push(entry);
  map.set(repId, list);
}

async function insertAutoTask(kind, args, retried = false) {
  const { title, creatorId, repId, customerId, today, itemText, taskKind = null } = args;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind, task_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
      [title, creatorId, repId, customerId, today, taskKind !== "call_customer", kind, taskKind]
    );
    if (rows[0] && itemText) await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, 0)", [rows[0].id, itemText]);
    await client.query("COMMIT");
    return rows[0]?.id ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    // A foreign-key error: the person picked as "creator" (or the rep / customer) was deleted while the run was going
    // (seen in CI: another test file deleted the sales director this run had just picked). Pick the creator again once;
    // if it still fails the task is simply skipped until the next run.
    if (err.code !== "23503" || retried) {
      console.error("Automatic task failed:", err.message);
      return null;
    }
  } finally {
    client.release();
  }
  const fresh = await systemCreatorId(pool);
  return fresh && fresh !== creatorId ? insertAutoTask(kind, { ...args, creatorId: fresh }, true) : null;
}

// One notification per rep for everything a run created.
async function notifyReps(perRep) {
  for (const [repId, list] of perRep) {
    if (!list.length) continue;
    const title = list.length === 1 ? `Նոր առաջադրանք՝ ${list[0].label}` : `${list.length} նոր առաջադրանք`;
    await notifyUser(repId, "task_assigned", {
      title,
      body: bulletNames(list.map((x) => x.customer), 3),
      url: list.length === 1 ? `/#/tasks?open=${list[0].taskId}` : "/#/tasks",
    }).catch((err) => console.error("Automatic task notification failed:", err.message));
  }
}

async function notifyBrokenPromises(director, broken) {
  if (!broken.length || !director) return;
  await notifyUser(director, "task_assigned", {
    title: `Վճարման խոստումը չի կատարվել՝ ${broken.length}`,
    body: bulletNames(broken, 3),
    url: "/#/tasks",
  }).catch((err) => console.error("Broken-promise notification failed:", err.message));
}

export async function createDebtCollectionTasks(now = new Date(), { notify = true } = {}) {
  const today = yerevanToday(now);
  // 1) Close open automatic tasks whose debt is gone or no longer overdue. DONE (paid) when the debt is gone, or when
  //    the customer paid since the task was created (a bank transfer clearing the overdue invoices while newer
  //    in-term ones remain); CANCELLED only when the debt is still there and nobody paid anything (older tasks
  //    created by the previous, cruder rule).
  const { rows: closed } = await pool.query(
    `UPDATE tasks t SET
       status = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 AND NOT ${PAID_SINCE_TASK_SQL} THEN 'cancelled' ELSE 'done' END,
       completed_at = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 AND NOT ${PAID_SINCE_TASK_SQL} THEN NULL ELSE now() END,
       completion_note = CASE WHEN COALESCE(erp.debt_amd, 0) = 0 THEN 'Պարտքը մարվել է (Excel)'
                              WHEN ${PAID_SINCE_TASK_SQL} THEN 'Ժամկետանց պարտքը մարվել է (Excel)'
                              ELSE 'Վճարման ժամկետը դեռ չի լրացել (Excel)' END,
       outcome = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 AND NOT ${PAID_SINCE_TASK_SQL} THEN NULL ELSE 'paid' END,
       updated_at = now()
     FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id ${DEBT_AGE_LATERAL}
     WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.status = 'open'
       AND NOT ${overdueDebtSql("$1::date")} AND erp.erp_customer_id IS NOT NULL
     RETURNING t.id`,
    [today]
  );

  // The workbook extract REPLACES the whole customer table on every sync: a customer whose debt is fully paid and who
  // has no recent orders simply drops out of it. Such a customer has no row to compare with, so the rule above never
  // saw them and their task stayed open for ever (customer 10167, 2026-10-15). Absent from a real extract = paid up.
  const { rows: droppedOut } = await pool.query(
    `UPDATE tasks t SET status = 'done', completed_at = now(), completion_note = 'Պարտքը մարվել է (Excel-ի ցանկում հաճախորդն այլևս չկա)', outcome = 'paid', updated_at = now()
     FROM customers c
     WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.status = 'open'
       AND c.erp_customer_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM erp_customer_data e WHERE e.erp_customer_id = c.erp_customer_id)
       AND (SELECT count(*) FROM erp_customer_data) >= $1
     RETURNING t.id`,
    [MIN_ERP_ROWS_TO_TRUST_ABSENCE]
  );
  closed.push(...droppedOut);

  // Management decided this account is disputed / with lawyers / written off: no automatic chasing (Operations control).
  const { rows: onHold } = await pool.query(
    `UPDATE tasks t SET status = 'cancelled', completion_note = 'Ղեկավարության որոշում՝ պարտքի հավաքագրումը դադարեցված է', updated_at = now()
     FROM debt_decisions d
     WHERE t.customer_id = d.customer_id AND d.decision IN ('dispute', 'legal', 'write_off') AND t.auto_kind = 'debt_collection' AND t.status = 'open'
     RETURNING t.id`
  );
  closed.push(...onHold);

  const perRep = new Map();
  const creatorId = await systemCreatorId(pool);
  if (!creatorId) return { created: 0, closed: closed.length, perRep };

  // 2) New tasks: overdue debtors, no open task, no recent task, no promise still running.
  const director = await martinId(pool);
  const { rows: found } = await pool.query(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.sales_channel,
            CASE WHEN u.role IN ('sales_manager', 'sales_director') AND u.status = 'active' THEN u.id END AS rep_id,
            fc.force_collect, erp.debt_amd, COALESCE(c.credit_term_days, 45) AS term_days, to_char(erp.last_payment_date, 'YYYY-MM-DD') AS last_payment_date, COALESCE(${debtAgeDaysSql("$2::date")}, erp.days_since_payment) AS days_open,
            (SELECT to_char(t.promise_date, 'YYYY-MM-DD') FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.outcome = 'promised'
             ORDER BY t.created_at DESC LIMIT 1) AS last_promise_date
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     ${DEBT_AGE_LATERAL}
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM debt_decisions d WHERE d.customer_id = c.id AND d.decision = 'collect') AS force_collect) fc
     WHERE ${overdueDebtSql("$2::date")}
       AND (${SKIPPED_CHANNELS_SQL} OR fc.force_collect)
       AND NOT EXISTS (SELECT 1 FROM debt_decisions dd WHERE dd.customer_id = c.id AND dd.decision IN ('dispute', 'legal', 'write_off'))
       AND NOT EXISTS (
         SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND (t.auto_kind = 'debt_collection' OR t.task_kind = 'collect_debt')
           AND (t.status = 'open'
                OR t.promise_date >= $2::date
                OR (t.promise_date IS NULL AND t.created_at > now() - ($1 || ' days')::interval)))
     ORDER BY erp.debt_amd DESC`,
    [COOLDOWN_DAYS, today]
  );
  // Customers without a sales manager only get a task if they are in a call channel (SM B2B / CVO / PCO / OEM) or are
  // forced -- then it goes to the sales director.
  const candidates = found
    .map((c) => ({ ...c, rep_id: c.rep_id ?? (isCallChannel(c.sales_channel) || c.force_collect ? director : null) }))
    .filter((c) => c.rep_id);

  let created = 0;
  const broken = [];
  const counts = new Map();
  for (const cand of candidates) {
    if ((counts.get(cand.rep_id) ?? 0) >= MAX_PER_REP) continue;
    const promiseBroken = Boolean(cand.last_promise_date) && cand.last_promise_date < today;
    // No checklist item: ticking it would close the task without recording the outcome.
    const call = isCallChannel(cand.sales_channel);
    const title = debtTaskTitle({ call, debt: cand.debt_amd, daysOpen: cand.days_open, termDays: cand.term_days, lastPayment: cand.last_payment_date, promiseBroken });
    const taskId = await insertAutoTask("debt_collection", {
      title, creatorId, repId: cand.rep_id, customerId: cand.customer_id, today, itemText: null, taskKind: call ? "call_customer" : null,
    });
    if (!taskId) continue;
    created++;
    counts.set(cand.rep_id, (counts.get(cand.rep_id) ?? 0) + 1);
    addTo(perRep, cand.rep_id, { taskId, customer: cand.customer_name, label: call ? DEBT_CALL_TITLE : DEBT_TASK_TITLE });
    if (promiseBroken) broken.push(cand.customer_name);
  }

  // A broken promise is also reported to the sales director (by the caller when notify is false).
  if (notify) {
    await notifyBrokenPromises(director, broken);
    await notifyReps(perRep);
  }
  return { created, closed: closed.length, perRep, broken: broken.length, brokenNames: broken, director };
}

// Customers who ordered regularly (>= 4 orders, usual gap 7-90 days) and are now well past
// their rhythm get a "call or visit" task for their rep -- but only when no credit term is
// exceeded: no overdue debt and no credit-limit breach (owner's rule, 2026-10-10).
const REORDER_COOLDOWN_DAYS = 30;
const REORDER_MAX_PER_REP = 10;
export async function createReorderFollowupTasks(now = new Date(), { notify = true } = {}) {
  const today = yerevanToday(now);
  // The customer ordered again, but through the workbook (accountant / direct order), not through the app: the app's
  // own order hook never fires for those, so close the task from the ERP order lines.
  const { rows: ordered } = await pool.query(
    `UPDATE tasks t SET status = 'done', completed_at = now(), completion_note = 'Ավտոմատ՝ պատվեր է ստացվել (Excel)', updated_at = now()
     FROM customers c
     WHERE t.customer_id = c.id AND t.auto_kind = 'reorder_followup' AND t.status = 'open' AND c.erp_customer_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM erp_order_lines l WHERE l.erp_customer_id = c.erp_customer_id
                     AND l.order_date >= (t.created_at AT TIME ZONE 'Asia/Yerevan')::date AND COALESCE(l.qty, 0) > 0 AND COALESCE(l.revenue_amd, 0) > 0)
     RETURNING t.id`
  );
  if (ordered.length) await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = ANY($1)", [ordered.map((r) => r.id)]);
  const perRep = new Map();
  const creatorId = await systemCreatorId(pool);
  if (!creatorId) return { created: 0, perRep };
  const director = await martinId(pool);
  const { rows: found } = await pool.query(
    `WITH days AS (
       SELECT erp_customer_id, order_date FROM erp_order_lines
       WHERE order_date >= $1::date - 400 GROUP BY erp_customer_id, order_date
     ), gaps AS (
       SELECT erp_customer_id, order_date, order_date - LAG(order_date) OVER (PARTITION BY erp_customer_id ORDER BY order_date) AS gap FROM days
     ), stats AS (
       SELECT erp_customer_id, MAX(order_date) AS last_order, COUNT(gap) AS n_gaps,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap
       FROM gaps WHERE gap IS NOT NULL GROUP BY erp_customer_id
     )
     SELECT c.id AS customer_id, c.name AS customer_name, c.sales_channel,
            CASE WHEN u.role IN ('sales_manager', 'sales_director') AND u.status = 'active' THEN u.id END AS rep_id,
            ROUND(st.median_gap)::int AS usual_gap, ($1::date - st.last_order)::int AS days_since
     FROM customers c
     JOIN stats st ON st.erp_customer_id = c.erp_customer_id
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     ${DEBT_AGE_LATERAL}
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     WHERE st.n_gaps >= 3 AND st.median_gap BETWEEN 7 AND 90
       AND ($1::date - st.last_order) > GREATEST(st.median_gap * 1.5, st.median_gap + 7)
       AND ($1::date - st.last_order) <= 365
       AND ${SKIPPED_CHANNELS_SQL}
       AND NOT (erp.erp_customer_id IS NOT NULL AND ${overdueDebtSql("$1::date")})
       AND (c.credit_limit_amd IS NULL OR COALESCE(erp.debt_amd, 0) <= c.credit_limit_amd)
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at::date > st.last_order AND o.status <> 'draft')
       AND NOT EXISTS (
         SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND (t.auto_kind = 'reorder_followup' OR t.task_kind = 'make_order')
           AND (t.status = 'open' OR t.created_at > now() - ($2 || ' days')::interval))
     ORDER BY ($1::date - st.last_order) - st.median_gap DESC`,
    [today, REORDER_COOLDOWN_DAYS]
  );
  const candidates = found
    .map((c) => ({ ...c, rep_id: c.rep_id ?? (isCallChannel(c.sales_channel) ? director : null) }))
    .filter((c) => c.rep_id);
  let created = 0;
  const counts = new Map();
  for (const cand of candidates) {
    if ((counts.get(cand.rep_id) ?? 0) >= REORDER_MAX_PER_REP) continue;
    const call = isCallChannel(cand.sales_channel);
    const taskId = await insertAutoTask("reorder_followup", {
      title: call ? REORDER_CALL_TITLE : REORDER_TASK_TITLE, taskKind: call ? "call_customer" : null, creatorId, repId: cand.rep_id, customerId: cand.customer_id, today,
      itemText: `Սովորաբար պատվիրում է ~${cand.usual_gap} օրը մեկ, վերջին պատվերը ${cand.days_since} օր առաջ էր`,
    });
    if (!taskId) continue;
    created++;
    counts.set(cand.rep_id, (counts.get(cand.rep_id) ?? 0) + 1);
    addTo(perRep, cand.rep_id, { taskId, customer: cand.customer_name, label: call ? REORDER_CALL_TITLE : REORDER_TASK_TITLE });
  }
  if (notify) await notifyReps(perRep);
  return { created, perRep };
}

// Both kinds, ONE notification per rep. After an ERP sync (viaSync) the lines join the sync's single
// combined notification (syncNotifier.js) instead of a notification of their own.
export async function runAutoTasks(now = new Date(), { viaSync = false } = {}) {
  const debt = await createDebtCollectionTasks(now, { notify: false });
  const reorder = await createReorderFollowupTasks(now, { notify: false });
  const merged = new Map();
  for (const m of [debt.perRep, reorder.perRep]) for (const [rep, list] of m) for (const e of list) addTo(merged, rep, e);
  if (viaSync) {
    for (const [repId, list] of merged) {
      if (!list.length) continue;
      queueSyncNotice({
        type: "task_assigned",
        userIds: [repId],
        text: list.length === 1 ? `Նոր առաջադրանք՝ ${list[0].customer}` : `${list.length} նոր առաջադրանք`,
        url: list.length === 1 ? `/#/tasks?open=${list[0].taskId}` : "/#/tasks",
        title: list.length === 1 ? `Նոր առաջադրանք՝ ${list[0].label}` : `${list.length} նոր առաջադրանք`,
        order: 3,
      });
    }
    if (debt.brokenNames?.length && debt.director) {
      queueSyncNotice({ type: "task_assigned", userIds: [debt.director], text: `Վճարման խոստումը չի կատարվել՝ ${debt.brokenNames.length}`, url: "/#/tasks", order: 4 });
    }
  } else {
    await notifyBrokenPromises(debt.director, debt.brokenNames ?? []);
    await notifyReps(merged);
  }
  return { debt: debt.created, reorder: reorder.created };
}

// Why did (or did not) the automatic tasks appear? (owner, 2026-10-24: "he hasn't created any debt collection or visit tasks lately -- is it ok?")
// Every customer with an overdue debt is put in exactly ONE bucket, in the order the creator checks them, so the numbers add up.
export async function autoTaskDiagnostics(now = new Date()) {
  const today = yerevanToday(now);
  const { rows } = await pool.query(
    `SELECT c.sales_channel,
            CASE WHEN u.role IN ('sales_manager', 'sales_director') AND u.status = 'active' THEN u.id END AS rep_id,
            fc.force_collect,
            EXISTS (SELECT 1 FROM debt_decisions dd WHERE dd.customer_id = c.id AND dd.decision IN ('dispute', 'legal', 'write_off')) AS on_hold,
            EXISTS (SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND (t.auto_kind = 'debt_collection' OR t.task_kind = 'collect_debt') AND t.status = 'open') AS has_open,
            EXISTS (SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND (t.auto_kind = 'debt_collection' OR t.task_kind = 'collect_debt') AND t.promise_date >= $2::date) AS promise_running,
            EXISTS (SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND (t.auto_kind = 'debt_collection' OR t.task_kind = 'collect_debt')
                      AND t.promise_date IS NULL AND t.created_at > now() - ($1 || ' days')::interval) AS cooling
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     ${DEBT_AGE_LATERAL}
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM debt_decisions d WHERE d.customer_id = c.id AND d.decision = 'collect') AS force_collect) fc
     WHERE ${overdueDebtSql("$2::date")}`,
    [COOLDOWN_DAYS, today]
  );
  const buckets = { channel_skipped: 0, on_hold: 0, has_open: 0, promise_running: 0, cooling: 0, no_rep: 0, ready: 0 };
  const perRep = new Map();
  for (const r of rows) {
    if (!(r.sales_channel !== "KF" && r.sales_channel !== "CAS") && !r.force_collect) buckets.channel_skipped++;
    else if (r.on_hold) buckets.on_hold++;
    else if (r.has_open) buckets.has_open++;
    else if (r.promise_running) buckets.promise_running++;
    else if (r.cooling) buckets.cooling++;
    else if (!(r.rep_id || isCallChannel(r.sales_channel) || r.force_collect)) buckets.no_rep++;
    else {
      buckets.ready++;
      const key = r.rep_id ?? "director";
      perRep.set(key, (perRep.get(key) ?? 0) + 1);
    }
  }
  const capped = [...perRep.values()].reduce((n, c) => n + Math.max(0, c - MAX_PER_REP), 0);
  const [{ rows: last }, { rows: sync }] = await Promise.all([
    pool.query(
      `SELECT auto_kind, MAX(created_at) AS last_created, COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last_7_days,
              COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS last_30_days
       FROM tasks WHERE auto_kind IN ('debt_collection', 'reorder_followup') GROUP BY auto_kind`
    ),
    pool.query("SELECT at, workbook_modified_at FROM erp_sync_runs ORDER BY at DESC LIMIT 1"),
  ]);
  return {
    overdue_total: rows.length,
    ...buckets,
    capped_by_limit: capped,
    max_per_rep: MAX_PER_REP,
    cooldown_days: COOLDOWN_DAYS,
    last_sync_at: sync[0]?.at ?? null,
    workbook_modified_at: sync[0]?.workbook_modified_at ?? null,
    tasks: Object.fromEntries(last.map((l) => [l.auto_kind, { last_created: l.last_created, last_7_days: l.last_7_days, last_30_days: l.last_30_days }])),
  };
}
