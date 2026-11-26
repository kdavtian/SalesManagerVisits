// Gaps and targets (owner, 2026-11-26): per product line, the litres a month our customers could use (volume potential) minus what they
// buy from us (ERP, volumeActuals.js), and the shops with potential whose fresh shelf (<= 60 days) shows no genuine Castrol, with an action
// that gives their reps a visit task -- only when management taps it, never automatically.
import { pool } from "../../db/pool.js";
import { buildOpportunities } from "../../customers/volumeOpportunities.js";
import { notifyUser } from "../../shared/notifications.js";
import { bulletNames } from "../../utils/bullets.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { FIELD_REP_ROLE } from "../../field/visitCount.js";
import { SHELF_FRESH_DAYS } from "../../field/shelfData.js";
import { loadShelfRecords, shelfStateAt, brandsOn, CASTROL } from "./shelfShare.js";
import { assigneeAllowed } from "../../team/taskAssignees.js";

export const GAP_TASK_TITLE = "Առաջարկիր Castrol";
export const GAP_TASK_DAYS = 7;
export const MAX_TASKS = 200;
const round1 = (n) => Math.round(n * 10) / 10;

// Pure: per line totals from the opportunity rows (each with lines [{ line_id, potential, actual, gap, kg }]).
export function lineTotals(rows, lines) {
  const by = new Map();
  for (const r of rows) {
    for (const l of r.lines ?? []) {
      const t = by.get(l.line_id) ?? { line_id: l.line_id, customers: 0, potential: 0, actual: 0, gap: 0 };
      t.customers += 1;
      t.potential += l.potential;
      t.actual += l.actual;
      t.gap += l.gap;
      by.set(l.line_id, t);
    }
  }
  const info = new Map(lines.map((l) => [l.id, l]));
  return [...by.values()]
    .filter((t) => info.has(t.line_id))
    .map((t) => {
      const l = info.get(t.line_id);
      return { ...t, code: l.code, name_en: l.name_en, name_hy: l.name_hy, unit: l.unit, group_key: l.group_key, potential: round1(t.potential), actual: round1(t.actual), gap: round1(t.gap), share_pct: t.potential > 0 ? Math.round((t.actual / t.potential) * 100) : null };
    })
    .sort((a, b) => b.gap - a.gap || a.code.localeCompare(b.code));
}

// scopeUserId: a sales manager sees only their own customers (as the Opportunities report).
export async function marketGaps({ lineCode = null, now = new Date(), scopeUserId = null, db = pool } = {}) {
  const [opp, { rows: lines }] = await Promise.all([
    buildOpportunities({ query: {}, scopeUserId }, db),
    db.query("SELECT id, code, group_key, name_en, name_hy, unit, sort_order FROM volume_potential_lines"),
  ]);
  const line = lineCode ? lines.find((l) => l.code === lineCode) : null;
  const ids = opp.rows.map((r) => r.customer_id);
  const [records, { rows: open }, { rows: names }, { rows: reps }] = await Promise.all([
    ids.length ? loadShelfRecords({ since: new Date(now.getTime() - SHELF_FRESH_DAYS * 86400000), until: now, customerIds: ids, db }) : [],
    db.query("SELECT DISTINCT customer_id FROM tasks WHERE status = 'open' AND title LIKE $1 AND customer_id = ANY($2::int[])", [`${GAP_TASK_TITLE}%`, ids]),
    db.query("SELECT id, name, sales_channel FROM customers WHERE id = ANY($1::int[])", [ids]),
    // the reps a task can go to: active field reps (a shop of anybody else shows "No rep" and cannot be picked)
    db.query("SELECT id FROM users WHERE role = $1 AND status = 'active'", [FIELD_REP_ROLE]),
  ]);
  const activeRep = new Set(reps.map((r) => r.id));
  const state = shelfStateAt(records, now);
  const withTask = new Set(open.map((r) => r.customer_id));
  const channel = new Map(names.map((n) => [n.id, n.sales_channel]));
  const shops = [];
  let unknown = 0;
  for (const r of opp.rows) {
    const l = line ? r.lines.find((x) => x.line_id === line.id) : null;
    if (line && !(l?.potential > 0)) continue;
    const s = state.get(r.customer_id);
    // the Castrol group itself must have a fresh answer: a visit that recorded only the competitors says nothing about Castrol (review)
    if (!s || !Array.isArray(s.state.castrol)) {
      unknown += 1;
      continue;
    }
    if (brandsOn(s.state).has(CASTROL)) continue;
    shops.push({
      customer_id: r.customer_id,
      name: r.name,
      region: r.region,
      sales_channel: channel.get(r.customer_id) ?? null,
      rep_id: activeRep.has(r.rep_id) ? r.rep_id : null,
      rep_name: activeRep.has(r.rep_id) ? r.rep_name : null,
      potential: line ? l.potential : r.potential,
      gap: line ? l.gap : r.gap,
      castrol: s.state.castrol ?? [],
      shelf_at: new Date(s.at).toISOString(),
      open_task: withTask.has(r.customer_id),
    });
  }
  shops.sort((a, b) => b.potential - a.potential || a.customer_id - b.customer_id);
  return {
    window: opp.window,
    totals: opp.totals,
    lines: lineTotals(opp.rows, lines),
    line: line ? { code: line.code, name_en: line.name_en, name_hy: line.name_hy, unit: line.unit } : null,
    max_tasks: MAX_TASKS,
    shops,
    shops_without_shelf: unknown,
    fresh_days: SHELF_FRESH_DAYS,
  };
}

// The action: one open visit task per shop for its rep ("Offer Castrol", next visit, a week), never a second open one; only to a rep the
// caller may give tasks to (team/taskAssignees.js, as the Tasks screen); in one transaction, each shop locked while it is checked, so two
// taps at once cannot make two tasks; each rep is told once, after the commit, with the shop names.
// -> { created, already_open, no_rep, not_allowed, over_limit }
export async function createGapTasks({ customerIds, lineCode = null, user, isRequest = false, db = pool }) {
  const all = [...new Set((customerIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const ids = all.slice(0, MAX_TASKS);
  const result = { created: 0, already_open: 0, no_rep: 0, not_allowed: 0, over_limit: all.length - ids.length };
  if (!ids.length) return result;
  const line = lineCode ? (await db.query("SELECT name_hy FROM volume_potential_lines WHERE code = $1", [lineCode])).rows[0] : null;
  const title = line ? `${GAP_TASK_TITLE}՝ ${line.name_hy}` : GAP_TASK_TITLE;
  const due = new Date(`${yerevanToday()}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + GAP_TASK_DAYS);
  const dueDate = due.toISOString().slice(0, 10);
  const { rows: shops } = await db.query(
    `SELECT c.id, c.name, u.id AS rep_id
     FROM customers c LEFT JOIN users u ON u.id = c.assigned_manager_id AND u.role = $2 AND u.status = 'active'
     WHERE c.id = ANY($1::int[]) AND c.closed_at IS NULL ORDER BY c.id`,
    [ids, FIELD_REP_ROLE]
  );
  const allowed = new Map();
  const mayTask = async (repId) => {
    if (!allowed.has(repId)) allowed.set(repId, await assigneeAllowed(user, repId));
    return allowed.get(repId);
  };
  const made = new Map();
  const client = db === pool ? await pool.connect() : db;
  try {
    await client.query("BEGIN");
    for (const s of shops) {
      if (!s.rep_id) {
        result.no_rep += 1;
        continue;
      }
      if (!(await mayTask(s.rep_id))) {
        result.not_allowed += 1;
        continue;
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext('market_gap_task'), $1)", [s.id]);
      const { rowCount } = await client.query("SELECT 1 FROM tasks WHERE customer_id = $1 AND status = 'open' AND title LIKE $2", [s.id, `${GAP_TASK_TITLE}%`]);
      if (rowCount) {
        result.already_open += 1;
        continue;
      }
      await client.query(
        `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, is_request) VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [title, user.id, s.rep_id, s.id, dueDate, isRequest]
      );
      if (!made.has(s.rep_id)) made.set(s.rep_id, []);
      made.get(s.rep_id).push(s.name);
      result.created += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (client !== db) client.release();
  }
  for (const [repId, shopNames] of made) {
    if (repId === user.id) continue;
    notifyUser(repId, "task_assigned", { title: `Նոր առաջադրանքներ՝ ${title} (${shopNames.length})`, body: bulletNames(shopNames), url: "/#/tasks" }).catch((err) =>
      console.error("Gap task notification failed:", err.message)
    );
  }
  return result;
}
