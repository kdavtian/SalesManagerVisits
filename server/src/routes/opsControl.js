// Operations control (operations director's console): the numbers and decisions behind the business-process
// review of 2026-10-15. Every section answers: which decision, who takes it, which action follows.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canSetCreditTerms } from "../roles.js";
import { creditLimitSuggestions } from "../creditLimitSuggest.js";
import { DEBT_AGE_LATERAL, debtAgeDaysSql } from "../debtAge.js";
import { yerevanToday } from "../utils/yerevanDate.js";

export const opsControlRouter = Router();
opsControlRouter.use(requireAuth);

export const OPS_VIEW_ROLES = ["admin", "ceo", "operations_director", "sales_director", "accountant"];
const OPS_DECIDE_ROLES = ["admin", "ceo", "operations_director"];
const requireView = (req, res, next) => (OPS_VIEW_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const requireDecide = (req, res, next) => (OPS_DECIDE_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Only the CEO, an operations director or an admin can decide this" }));
opsControlRouter.use(requireView);

export const DEBT_DECISIONS = ["collect", "restructure", "dispute", "legal", "write_off"];

// ---- Legacy balances: old / hard debt, with management's decision per account ----
// A candidate = open debt that is mostly the opening balance, never paid, or whose oldest unpaid invoice is over
// 180 days old. Sorted by debt.
opsControlRouter.get("/legacy-balances", async (_req, res) => {
  const today = yerevanToday();
  const { rows } = await pool.query(
    `SELECT c.id AS customer_id, COALESCE(c.name, erp.customer_name) AS name, c.sales_channel, u.name AS rep_name,
            erp.debt_amd::float8 AS debt_amd, COALESCE(erp.balance0_amd, 0)::float8 AS balance0_amd,
            to_char(erp.last_payment_date, 'YYYY-MM-DD') AS last_payment_date, erp.days_since_payment,
            ${debtAgeDaysSql("$1::date")} AS oldest_unpaid_days,
            EXISTS (SELECT 1 FROM erp_order_lines l WHERE l.erp_customer_id = c.erp_customer_id) AS ever_ordered,
            COALESCE((SELECT SUM(l.revenue_amd) FROM erp_order_lines l WHERE l.erp_customer_id = c.erp_customer_id AND l.order_date >= $1::date - 90), 0)::float8 AS sales_90d_amd,
            d.decision, d.note, to_char(d.decided_at, 'YYYY-MM-DD') AS decided_on, du.name AS decided_by_name
     FROM customers c
     JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     ${DEBT_AGE_LATERAL}
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     LEFT JOIN debt_decisions d ON d.customer_id = c.id
     LEFT JOIN users du ON du.id = d.decided_by
     WHERE erp.debt_amd > 0
       AND (erp.last_payment_date IS NULL OR COALESCE(erp.balance0_amd, 0) >= erp.debt_amd * 0.5 OR ${debtAgeDaysSql("$1::date")} > 180)
     ORDER BY erp.debt_amd DESC
     LIMIT 300`,
    [today]
  );
  const items = rows.map((r) => ({
    ...r,
    debt_amd: Math.round(r.debt_amd),
    balance0_amd: Math.round(r.balance0_amd),
    sales_90d_amd: Math.round(r.sales_90d_amd),
    never_paid: r.last_payment_date === null,
    still_buying: r.sales_90d_amd > 0,
  }));
  const total = items.reduce((s, r) => s + r.debt_amd, 0);
  const undecided = items.filter((r) => !r.decision);
  res.json({
    total_amd: total,
    undecided_count: undecided.length,
    undecided_amd: undecided.reduce((s, r) => s + r.debt_amd, 0),
    items,
  });
});

opsControlRouter.put("/legacy-balances/:customerId", requireDecide, async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const decision = req.body?.decision;
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : null;
  if (decision === null) {
    await pool.query("DELETE FROM debt_decisions WHERE customer_id = $1", [customerId]);
    return res.status(204).end();
  }
  if (!DEBT_DECISIONS.includes(decision)) return res.status(400).json({ error: `decision must be one of ${DEBT_DECISIONS.join(", ")}` });
  const { rowCount } = await pool.query("SELECT 1 FROM customers WHERE id = $1", [customerId]);
  if (!rowCount) return res.status(404).json({ error: "Customer not found" });
  await pool.query(
    `INSERT INTO debt_decisions (customer_id, decision, note, decided_by, decided_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (customer_id) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
    [customerId, decision, note || null, req.user.id]
  );
  res.status(204).end();
});

// ---- Credit limits: customers without a limit (unlimited credit) ----
opsControlRouter.get("/credit-limits", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE credit_limit_amd IS NULL AND erp_customer_id IS NOT NULL AND erp_customer_id <> '10000' AND NOT COALESCE(checkin_for_all, false))::int AS without_limit,
            count(*) FILTER (WHERE credit_limit_amd IS NOT NULL)::int AS with_limit
     FROM customers`
  );
  const suggestions = await creditLimitSuggestions(pool);
  res.json({ ...rows[0], suggestions, can_apply: canSetCreditTerms(req.user.role) });
});

// Applies chosen limits, only to customers that still have NONE (never overwrites a limit someone set).
opsControlRouter.post("/credit-limits/apply", async (req, res) => {
  if (!canSetCreditTerms(req.user.role)) return res.status(403).json({ error: "Only the accountant or a director can set credit limits" });
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || !items.length || items.length > 1000) return res.status(400).json({ error: "items must be a list of 1 to 1000 entries" });
  for (const it of items) {
    const limit = Number(it?.limit);
    if (!Number.isInteger(Number(it?.customer_id)) || !Number.isFinite(limit) || limit < 0 || limit >= 1e13) return res.status(400).json({ error: "Every item needs a customer_id and a non-negative limit" });
  }
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("BEGIN");
    for (const it of items) {
      const { rowCount } = await client.query("UPDATE customers SET credit_limit_amd = $2 WHERE id = $1 AND credit_limit_amd IS NULL", [Number(it.customer_id), Math.round(Number(it.limit))]);
      if (rowCount) {
        applied++;
        await client.query("INSERT INTO customer_credit_limit_log (customer_id, old_limit, new_limit, changed_by) VALUES ($1, NULL, $2, $3)", [Number(it.customer_id), Math.round(Number(it.limit)), req.user.id]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ applied, skipped: items.length - applied });
});
