// Automatic tasks of the operations control (Vaghinak's name on them): small helpers shared by the jobs and routes.
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { yerevanToday } from "../utils/yerevanDate.js";

// Who is shown as the creator: a sales director, else the CEO, else an admin (same rule as debtCollectionTasks.js).
export async function systemCreatorId(db = pool) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE status = 'active' AND role IN ('sales_director', 'ceo', 'admin')
     ORDER BY CASE role WHEN 'sales_director' THEN 0 WHEN 'ceo' THEN 1 ELSE 2 END, id LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

export async function usersWithRole(role, db = pool) {
  const { rows } = await db.query("SELECT id FROM users WHERE role = $1 AND status = 'active' ORDER BY id", [role]);
  return rows.map((r) => r.id);
}

// One open task per (kind, assignee, customer). Returns the new task id, or null when one is already open.
export async function createOpsTask({ kind, title, assigneeId, customerId = null, dueDate = yerevanToday(), dueIsNextVisit = false, items = [], notify = true, db = pool }) {
  const creatorId = await systemCreatorId(db);
  if (!creatorId || !assigneeId) return null;
  const { rows: existing } = await db.query(
    "SELECT id FROM tasks WHERE auto_kind = $1 AND assignee_id = $2 AND status = 'open' AND customer_id IS NOT DISTINCT FROM $3 LIMIT 1",
    [kind, assigneeId, customerId]
  );
  if (existing.length) return null;
  const insert = (creator) =>
    db.query(
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind)
       VALUES ($1, $2, $3, $4, $5, $7, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [title, creator, assigneeId, customerId, dueDate, kind, dueIsNextVisit]
    );
  let rows;
  try {
    ({ rows } = await insert(creatorId));
  } catch (err) {
    // The person picked as creator (or the assignee) was deleted between the pick and the insert (a team change at the same moment): pick again once.
    if (err.code !== "23503") throw err;
    const again = await systemCreatorId(db);
    if (!again || again === creatorId) return null;
    try {
      ({ rows } = await insert(again));
    } catch (err2) {
      if (err2.code === "23503") return null; // the assignee itself is gone: nothing to assign
      throw err2;
    }
  }
  const id = rows[0]?.id ?? null;
  if (!id) return null;
  for (const [i, text] of items.entries()) await db.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [id, String(text).slice(0, 300), i]);
  if (notify) {
    await notifyUser(assigneeId, "task_assigned", { title: `Նոր առաջադրանք՝ ${title}`.slice(0, 120), body: items[0] ? String(items[0]).slice(0, 140) : "", url: `/#/tasks?open=${id}` }).catch((err) => console.error("Ops task notification failed:", err.message));
  }
  return id;
}

// Closes the open tasks of a kind (the situation they asked about is gone).
export async function closeOpsTasks(kind, note, db = pool) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), completion_note = $2, updated_at = now()
     WHERE auto_kind = $1 AND status = 'open' RETURNING id`,
    [kind, note]
  );
  for (const r of rows) await db.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [r.id]);
  return rows.length;
}
