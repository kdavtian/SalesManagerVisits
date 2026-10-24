// Potential Customer classification (owner, 2026-10-24): level 1-4 + reasons + history, and the counterfeit-products restriction.
// Manual levels are the primary system; a future automatic 0-100 score would sit next to them (columns on customers, see migration 142).
import { pool } from "./db/pool.js";

export const POTENTIAL_LEVELS = [1, 2, 3, 4];
// 1 No potential, 2 Low, 3 Real, 4 High
export const POTENTIAL_REASONS = [
  "counterfeit", "own_import", "competitor_loyal", "price_mismatch", "small_volume", "not_interested", "no_decision_maker", "payment_issue",
  "no_demand_now", "high_potential", "active_interest", "negotiating", "ready_first_order", "other",
];
export const COUNTERFEIT_REASON = "counterfeit";
// Follow-up priority (owner): high first ... no potential last; "not assessed" sits after real potential.
export const POTENTIAL_PRIORITY_SQL = `CASE c.potential_level WHEN 4 THEN 1 WHEN 3 THEN 2 WHEN 2 THEN 4 WHEN 1 THEN 5 ELSE 3 END`;

export class PotentialError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function cleanPotentialInput(b = {}) {
  const level = Number(b.level);
  if (!POTENTIAL_LEVELS.includes(level)) throw new PotentialError("Choose the potential level (1-4)");
  const reasons = [...new Set((Array.isArray(b.reasons) ? b.reasons : []).map(String))];
  if (!reasons.length) throw new PotentialError("Choose at least one reason");
  if (reasons.some((r) => !POTENTIAL_REASONS.includes(r))) throw new PotentialError("Unknown reason");
  const other = typeof b.reason_other === "string" ? b.reason_other.trim().slice(0, 300) : "";
  if (reasons.includes("other") && !other) throw new PotentialError("Explain the \"Other\" reason");
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) || null : null;
  const date = b.next_followup_date ? String(b.next_followup_date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PotentialError("Bad follow-up date");
  let volume = null;
  if (b.expected_volume_l !== undefined && b.expected_volume_l !== null && b.expected_volume_l !== "") {
    volume = Number(b.expected_volume_l);
    if (!(volume >= 0) || volume > 1e7) throw new PotentialError("Bad expected volume");
  }
  return { level, reasons, other: reasons.includes("other") ? other : null, note, date, volume, hasDate: b.next_followup_date !== undefined, hasVolume: b.expected_volume_l !== undefined };
}

// Sets level + reasons (+ optional follow-up date / expected volume) and writes history when the level or the reasons changed.
// Ticking the counterfeit reason raises the restriction; it stays until a manager resolves it.
// What a person last used for each level. "Other" needs its own text and "counterfeit" starts a restriction, so neither is ever pre-ticked.
const REMEMBERABLE = (r) => r !== "other" && r !== COUNTERFEIT_REASON;

export async function getReasonMemory(userId) {
  const { rows } = await pool.query("SELECT level, reasons FROM user_potential_reason_memory WHERE user_id = $1", [userId]);
  return Object.fromEntries(rows.map((r) => [r.level, r.reasons.filter(REMEMBERABLE)]));
}

export async function setPotential(customerId, userId, body) {
  const v = cleanPotentialInput(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [cur] } = await client.query("SELECT id, customer_tier, potential_level, potential_reasons, potential_reason_other, counterfeit_flag FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
    if (!cur) throw new PotentialError("Customer not found", 404);
    if (cur.customer_tier !== "potential") throw new PotentialError("Only potential customers have a potential level");
    const sameReasons = JSON.stringify([...cur.potential_reasons].sort()) === JSON.stringify([...v.reasons].sort()) && (cur.potential_reason_other ?? null) === v.other;
    const changed = cur.potential_level !== v.level || !sameReasons;
    const raiseCounterfeit = v.reasons.includes(COUNTERFEIT_REASON) && !cur.potential_reasons.includes(COUNTERFEIT_REASON) && !cur.counterfeit_flag;
    const sets = ["potential_level = $2", "potential_reasons = $3", "potential_reason_other = $4", "potential_updated_at = now()", "potential_updated_by = $5"];
    const params = [customerId, v.level, v.reasons, v.other, userId];
    if (v.hasDate) sets.push(`next_followup_date = $${params.push(v.date)}`);
    if (v.hasVolume) sets.push(`expected_volume_l = $${params.push(v.volume)}`);
    if (raiseCounterfeit) sets.push("counterfeit_flag = true", "counterfeit_resolved_at = NULL", "counterfeit_resolved_by = NULL", "counterfeit_resolved_comment = NULL");
    await client.query(`UPDATE customers SET ${sets.join(", ")} WHERE id = $1`, params);
    if (changed || v.note) {
      await client.query(
        `INSERT INTO customer_potential_history (customer_id, kind, old_level, new_level, reasons, reason_other, note, changed_by) VALUES ($1, 'level', $2, $3, $4, $5, $6, $7)`,
        [customerId, cur.potential_level, v.level, v.reasons, v.other, v.note, userId]
      );
    }
    if (raiseCounterfeit) {
      await client.query(`INSERT INTO customer_potential_history (customer_id, kind, new_level, changed_by) VALUES ($1, 'counterfeit_set', $2, $3)`, [customerId, v.level, userId]);
    }
    await client.query(
      `INSERT INTO user_potential_reason_memory (user_id, level, reasons) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, level) DO UPDATE SET reasons = EXCLUDED.reasons, updated_at = now()`,
      [userId, v.level, v.reasons.filter(REMEMBERABLE)]
    );
    await client.query("COMMIT");
    return { changed, counterfeit_flag: raiseCounterfeit || cur.counterfeit_flag };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function resolveCounterfeit(customerId, userId, comment) {
  const text = typeof comment === "string" ? comment.trim().slice(0, 500) || null : null;
  const { rows: [cur] } = await pool.query("SELECT counterfeit_flag, potential_level FROM customers WHERE id = $1", [customerId]);
  if (!cur) throw new PotentialError("Customer not found", 404);
  if (!cur.counterfeit_flag) throw new PotentialError("There is no unresolved counterfeit-product flag on this customer", 409);
  await pool.query(
    "UPDATE customers SET counterfeit_flag = false, counterfeit_resolved_at = now(), counterfeit_resolved_by = $2, counterfeit_resolved_comment = $3 WHERE id = $1",
    [customerId, userId, text]
  );
  await pool.query(`INSERT INTO customer_potential_history (customer_id, kind, new_level, note, changed_by) VALUES ($1, 'counterfeit_resolved', $2, $3, $4)`, [customerId, cur.potential_level, text, userId]);
}

export async function potentialHistory(customerId) {
  const { rows } = await pool.query(
    `SELECT h.id, h.kind, h.old_level, h.new_level, h.reasons, h.reason_other, h.note, h.changed_at, u.name AS changed_by_name
     FROM customer_potential_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.customer_id = $1 ORDER BY h.changed_at DESC, h.id DESC`,
    [customerId]
  );
  return rows;
}
