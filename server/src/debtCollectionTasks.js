// "Հավաքագրիր պարտքը" (collect the debt): after every ERP sync, a sales rep gets
// an automatic task for their next visit to each of THEIR customers that is
// overdue with debt (Excel debt > 0 and no payment for longer than the
// customer's credit term, `customers.credit_term_days`, default 45).
//  - channels KF, CAS and OEM are skipped (owner's rule); CVO and PCO are
//    included: the task goes to the assigned rep, or to the sales director
//    (Martin) when the customer has no sales manager;
//  - one open automatic task per customer (unique index, migration 102);
//  - after a rep closes one, no new one for the same customer for 14 days;
//  - when the debt is gone (or no longer overdue) the open task is closed;
//  - each rep gets ONE notification per run, not one per customer;
//  - at most MAX_PER_REP new tasks per rep per run (largest debts first), so
//    the first run does not bury a rep under dozens of tasks.
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";

export const DEBT_TASK_TITLE = "Հավաքագրիր պարտքը";
const MAX_PER_REP = 15;
const COOLDOWN_DAYS = 14;

const SKIPPED_CHANNELS_SQL = `COALESCE(c.sales_channel, '') <> ALL(ARRAY['KF', 'CAS', 'OEM'])`;
const OVERDUE_DEBT_SQL = `erp.debt_amd > 0 AND (erp.days_since_payment IS NULL OR erp.days_since_payment > COALESCE(c.credit_term_days, 45))`;

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

export async function createDebtCollectionTasks(now = new Date()) {
  // 1) Close open automatic tasks whose debt is gone or no longer overdue.
  const { rows: closed } = await pool.query(
    `UPDATE tasks t SET status = 'done', completed_at = now(), completion_note = 'Պարտքը մարվել է (Excel)', updated_at = now()
     FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection' AND t.status = 'open'
       AND NOT (${OVERDUE_DEBT_SQL}) AND erp.erp_customer_id IS NOT NULL
     RETURNING t.id`
  );

  const creatorId = await systemCreatorId(pool);
  if (!creatorId) return { created: 0, closed: closed.length };

  // 2) New tasks: overdue debtors of sales managers, no open / recent automatic task.
  const director = await martinId(pool);
  const { rows: found } = await pool.query(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.sales_channel,
            CASE WHEN u.role IN ('sales_manager', 'sales_director') THEN u.id END AS rep_id,
            erp.debt_amd, erp.days_since_payment
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     WHERE ${OVERDUE_DEBT_SQL} AND ${SKIPPED_CHANNELS_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'debt_collection'
           AND (t.status = 'open' OR t.created_at > now() - ($1 || ' days')::interval))
     ORDER BY erp.debt_amd DESC`,
    [COOLDOWN_DAYS]
  );
  // Customers without a sales manager only get a task if they are CVO / PCO -- then it goes to the sales director.
  const candidates = found
    .map((c) => ({ ...c, rep_id: c.rep_id ?? (["CVO", "PCO"].includes(c.sales_channel) ? director : null) }))
    .filter((c) => c.rep_id);

  const today = yerevanToday(now);
  const perRep = new Map();
  let created = 0;
  for (const cand of candidates) {
    const list = perRep.get(cand.rep_id) ?? [];
    if (list.length >= MAX_PER_REP) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind)
         VALUES ($1, $2, $3, $4, $5, true, 'debt_collection')
         ON CONFLICT DO NOTHING RETURNING id`,
        [DEBT_TASK_TITLE, creatorId, cand.rep_id, cand.customer_id, today]
      );
      if (rows[0]) {
        const days = cand.days_since_payment == null ? "" : ` · ${cand.days_since_payment} օր առանց վճարման`;
        await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, 0)", [rows[0].id, `Պարտք՝ ${amd(cand.debt_amd)}${days}`]);
        list.push({ taskId: rows[0].id, customer: cand.customer_name });
        created++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Debt collection task failed:", err.message);
    } finally {
      client.release();
    }
    perRep.set(cand.rep_id, list);
  }

  // 3) One notification per rep.
  for (const [repId, list] of perRep) {
    if (!list.length) continue;
    await notifyUser(repId, "task_assigned", {
      title: list.length === 1 ? `Նոր առաջադրանք՝ ${DEBT_TASK_TITLE}` : `${list.length} նոր առաջադրանք՝ ${DEBT_TASK_TITLE}`,
      body: list.length === 1 ? list[0].customer : `${list.slice(0, 3).map((x) => x.customer).join(", ")}${list.length > 3 ? "…" : ""}`,
      url: list.length === 1 ? `/#/tasks?open=${list[0].taskId}` : "/#/tasks",
    }).catch((err) => console.error("Debt task notification failed:", err.message));
  }
  return { created, closed: closed.length };
}
