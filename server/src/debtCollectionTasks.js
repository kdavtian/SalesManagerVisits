// "Հավաքագրիր պարտքը" (collect the debt): after every ERP sync, a sales rep gets
// an automatic task for their next visit to each of THEIR customers that is
// overdue with debt (Excel debt > 0 and its oldest unpaid invoice older than the
// customer's credit term, `customers.credit_term_days`, default 45; see debtAge.js).
//  - channels KF, CAS and OEM are skipped (owner's rule); CVO and PCO are
//    included: the task goes to the assigned rep, or to the sales director
//    (Martin) when the customer has no sales manager;
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
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { DEBT_AGE_LATERAL, overdueDebtSql, debtAgeDaysSql } from "./debtAge.js";

export const DEBT_TASK_TITLE = "Հավաքագրիր պարտքը";
export const REORDER_TASK_TITLE = "Հաճախորդը վաղուց չի պատվիրել՝ զանգահարիր կամ այցելիր";
const MAX_PER_REP = 15;
const COOLDOWN_DAYS = 14;

const SKIPPED_CHANNELS_SQL = `COALESCE(c.sales_channel, '') <> ALL(ARRAY['KF', 'CAS', 'OEM'])`;
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

const amd = (n) => `${Math.round(Number(n)).toLocaleString("en-US")} դր.`;

// A task created for a rep, for the single notification a run sends per rep.
function addTo(map, repId, entry) {
  const list = map.get(repId) ?? [];
  list.push(entry);
  map.set(repId, list);
}

async function insertAutoTask(kind, { title, creatorId, repId, customerId, today, itemText }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind)
       VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [title, creatorId, repId, customerId, today, kind]
    );
    if (rows[0] && itemText) await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, 0)", [rows[0].id, itemText]);
    await client.query("COMMIT");
    return rows[0]?.id ?? null;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Automatic task failed:", err.message);
    return null;
  } finally {
    client.release();
  }
}

// One notification per rep for everything a run created.
async function notifyReps(perRep) {
  for (const [repId, list] of perRep) {
    if (!list.length) continue;
    const title = list.length === 1 ? `Նոր առաջադրանք՝ ${list[0].label}` : `${list.length} նոր առաջադրանք`;
    await notifyUser(repId, "task_assigned", {
      title,
      body: `${list.slice(0, 3).map((x) => x.customer).join(", ")}${list.length > 3 ? "…" : ""}`,
      url: list.length === 1 ? `/#/tasks?open=${list[0].taskId}` : "/#/tasks",
    }).catch((err) => console.error("Automatic task notification failed:", err.message));
  }
}

export async function createDebtCollectionTasks(now = new Date(), { notify = true } = {}) {
  const today = yerevanToday(now);
  // 1) Close open automatic tasks whose debt is gone or no longer overdue.
  const { rows: closed } = await pool.query(
    `UPDATE tasks t SET
       status = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 THEN 'cancelled' ELSE 'done' END,
       completed_at = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 THEN NULL ELSE now() END,
       completion_note = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 THEN 'Վճարման ժամկետը դեռ չի լրացել (Excel)' ELSE 'Պարտքը մարվել է (Excel)' END,
       outcome = CASE WHEN COALESCE(erp.debt_amd, 0) > 0 THEN NULL ELSE 'paid' END,
       updated_at = now()
     FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id ${DEBT_AGE_LATERAL}
     WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.status = 'open'
       AND NOT ${overdueDebtSql("$1::date")} AND erp.erp_customer_id IS NOT NULL
     RETURNING t.id`,
    [today]
  );

  const perRep = new Map();
  const creatorId = await systemCreatorId(pool);
  if (!creatorId) return { created: 0, closed: closed.length, perRep };

  // 2) New tasks: overdue debtors, no open task, no recent task, no promise still running.
  const director = await martinId(pool);
  const { rows: found } = await pool.query(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.sales_channel,
            CASE WHEN u.role IN ('sales_manager', 'sales_director') THEN u.id END AS rep_id,
            erp.debt_amd, COALESCE(${debtAgeDaysSql("$2::date")}, erp.days_since_payment) AS days_open,
            (SELECT to_char(t.promise_date, 'YYYY-MM-DD') FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.outcome = 'promised'
             ORDER BY t.created_at DESC LIMIT 1) AS last_promise_date
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     ${DEBT_AGE_LATERAL}
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     WHERE ${overdueDebtSql("$2::date")} AND ${SKIPPED_CHANNELS_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection'
           AND (t.status = 'open'
                OR t.promise_date >= $2::date
                OR (t.promise_date IS NULL AND t.created_at > now() - ($1 || ' days')::interval)))
     ORDER BY erp.debt_amd DESC`,
    [COOLDOWN_DAYS, today]
  );
  // Customers without a sales manager only get a task if they are CVO / PCO -- then it goes to the sales director.
  const candidates = found
    .map((c) => ({ ...c, rep_id: c.rep_id ?? (["CVO", "PCO"].includes(c.sales_channel) ? director : null) }))
    .filter((c) => c.rep_id);

  let created = 0;
  const broken = [];
  const counts = new Map();
  for (const cand of candidates) {
    if ((counts.get(cand.rep_id) ?? 0) >= MAX_PER_REP) continue;
    const days = cand.days_open == null ? "" : ` · ${cand.days_open} օր առանց վճարման`;
    const promiseBroken = Boolean(cand.last_promise_date) && cand.last_promise_date < today;
    // No checklist item: ticking it would close the task without recording the outcome.
    const title = `${DEBT_TASK_TITLE}՝ ${amd(cand.debt_amd)}${days}${promiseBroken ? " · խոստումը չի կատարվել" : ""}`;
    const taskId = await insertAutoTask("debt_collection", {
      title, creatorId, repId: cand.rep_id, customerId: cand.customer_id, today, itemText: null,
    });
    if (!taskId) continue;
    created++;
    counts.set(cand.rep_id, (counts.get(cand.rep_id) ?? 0) + 1);
    addTo(perRep, cand.rep_id, { taskId, customer: cand.customer_name, label: DEBT_TASK_TITLE });
    if (promiseBroken) broken.push(cand.customer_name);
  }

  // A broken promise is also reported to the sales director.
  if (broken.length && director) {
    await notifyUser(director, "task_assigned", {
      title: `Վճարման խոստումը չի կատարվել՝ ${broken.length}`,
      body: `${broken.slice(0, 3).join(", ")}${broken.length > 3 ? "…" : ""}`,
      url: "/#/tasks",
    }).catch((err) => console.error("Broken-promise notification failed:", err.message));
  }

  if (notify) await notifyReps(perRep);
  return { created, closed: closed.length, perRep, broken: broken.length };
}

// Customers who ordered regularly (>= 4 orders, usual gap 7-90 days) and are now well past
// their rhythm get a "call or visit" task for their rep -- but only when no credit term is
// exceeded: no overdue debt and no credit-limit breach (owner's rule, 2026-10-10).
const REORDER_COOLDOWN_DAYS = 30;
const REORDER_MAX_PER_REP = 10;
export async function createReorderFollowupTasks(now = new Date(), { notify = true } = {}) {
  const today = yerevanToday(now);
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
            CASE WHEN u.role IN ('sales_manager', 'sales_director') THEN u.id END AS rep_id,
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
         SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'reorder_followup'
           AND (t.status = 'open' OR t.created_at > now() - ($2 || ' days')::interval))
     ORDER BY ($1::date - st.last_order) - st.median_gap DESC`,
    [today, REORDER_COOLDOWN_DAYS]
  );
  const candidates = found
    .map((c) => ({ ...c, rep_id: c.rep_id ?? (["CVO", "PCO"].includes(c.sales_channel) ? director : null) }))
    .filter((c) => c.rep_id);
  let created = 0;
  const counts = new Map();
  for (const cand of candidates) {
    if ((counts.get(cand.rep_id) ?? 0) >= REORDER_MAX_PER_REP) continue;
    const taskId = await insertAutoTask("reorder_followup", {
      title: REORDER_TASK_TITLE, creatorId, repId: cand.rep_id, customerId: cand.customer_id, today,
      itemText: `Սովորաբար պատվիրում է ~${cand.usual_gap} օրը մեկ, վերջին պատվերը ${cand.days_since} օր առաջ էր`,
    });
    if (!taskId) continue;
    created++;
    counts.set(cand.rep_id, (counts.get(cand.rep_id) ?? 0) + 1);
    addTo(perRep, cand.rep_id, { taskId, customer: cand.customer_name, label: REORDER_TASK_TITLE });
  }
  if (notify) await notifyReps(perRep);
  return { created, perRep };
}

// Both kinds, ONE notification per rep.
export async function runAutoTasks(now = new Date()) {
  const debt = await createDebtCollectionTasks(now, { notify: false });
  const reorder = await createReorderFollowupTasks(now, { notify: false });
  const merged = new Map();
  for (const m of [debt.perRep, reorder.perRep]) for (const [rep, list] of m) for (const e of list) addTo(merged, rep, e);
  await notifyReps(merged);
  return { debt: debt.created, reorder: reorder.created };
}
