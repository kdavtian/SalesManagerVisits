// Tasks outlive the person who is deleted (owner, 2026-10-29: "the tasks remain"). tasks.creator_id and tasks.assignee_id are ON DELETE
// CASCADE, so deleting an account used to delete every task that person created or was given, without a word: the automatic debt and
// reorder tasks name the oldest sales director as their creator, so deleting that one account would have emptied the whole task list.
// Before a user row is deleted (DELETE /api/users/:id, the test-user purge) their tasks pass to the next manager: an active sales director
// first, then the CEO, then an admin (the same order the automatic tasks use, src/money/debtCollectionTasks.js systemCreatorId).
// Runs inside the caller's transaction; returns who received them and how many, or null when nobody else can take them.
export async function handOverTasks(client, userId) {
  const { rows } = await client.query(
    `SELECT id FROM users WHERE id <> $1 AND role IN ('sales_director', 'ceo', 'admin')
     ORDER BY (status = 'active') DESC, CASE role WHEN 'sales_director' THEN 0 WHEN 'ceo' THEN 1 ELSE 2 END, id LIMIT 1`,
    [userId]
  );
  const heir = rows[0]?.id;
  if (!heir) return null;
  const created = await client.query("UPDATE tasks SET creator_id = $2 WHERE creator_id = $1", [userId, heir]);
  // the tasks the person was given, open and closed: open ones stay to be done, closed ones keep the history (completed_by is SET NULL)
  const assigned = await client.query("UPDATE tasks SET assignee_id = $2, updated_at = now() WHERE assignee_id = $1", [userId, heir]);
  return { heir, created: created.rowCount, assigned: assigned.rowCount };
}
