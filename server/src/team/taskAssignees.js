// Who may give a task to whom (moved out of routes/tasks.js, 2026-11-26): used by the Tasks routes and the Market gaps action.
import { pool } from "../db/pool.js";
import { canCreateTasks, sendsRequests, taskAssigneeRoles, tasksAnyone } from "../shared/roles.js";

// Who the user may give a task to, as a condition on users alias u (owner, 2026-10-28): admin / CEO anyone; another task giver the
// people below them in Staff ("reports to"); the accountant's requests go to the sales director. A task giver without a Staff
// record keeps the old role rule (roles.js taskAssigneeRoles) until they are added there.
export async function assigneeSql(user, params) {
  if (tasksAnyone(user.role)) return "TRUE";
  if (!canCreateTasks(user.role)) return "FALSE";
  const conds = [];
  if (sendsRequests(user.role)) conds.push("u.role = 'sales_director'");
  const { rows } = await pool.query("SELECT 1 FROM staff_members WHERE user_id = $1", [user.id]);
  if (rows.length) {
    params.push(user.id);
    conds.push(`u.id IN ${subordinatesSql(`$${params.length}`)}`);
  } else if (!sendsRequests(user.role)) {
    const roles = taskAssigneeRoles(user.role);
    if (roles === null) conds.push("TRUE");
    else if (roles.length) {
      params.push(roles);
      conds.push(`u.role = ANY($${params.length})`);
    }
  }
  return conds.length ? `(${conds.join(" OR ")})` : "FALSE";
}

export async function assigneeAllowed(creator, assigneeId) {
  const params = [assigneeId];
  const where = await assigneeSql(creator, params);
  const { rows } = await pool.query(`SELECT 1 FROM users u WHERE u.id = $1 AND ${where}`, params);
  return rows.length > 0;
}

// User ids of everyone below the user ${me} in the Staff "reports to" tree, direct and indirect (UNION stops at a loop).
export const subordinatesSql = (me) => `(WITH RECURSIVE sub AS (
    SELECT s.id, s.user_id FROM staff_members s JOIN staff_members boss ON s.reports_to = boss.id WHERE boss.user_id = ${me}
    UNION SELECT s.id, s.user_id FROM staff_members s JOIN sub ON s.reports_to = sub.id)
  SELECT sub.user_id FROM sub WHERE sub.user_id IS NOT NULL)`;
