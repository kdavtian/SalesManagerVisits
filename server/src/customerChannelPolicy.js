import { pool } from "./db/pool.js";

// Derived customer portfolio semantics used throughout the Field Visits app:
// - competitor accounts remain COMPETITORS and never become Potential
// - every non-competitor without an ERP customer ID is Potential
// - linked accounts keep their real operational sales channel
// This middleware also keeps writes consistent so future records cannot drift.
export async function normalizeCustomerPortfolio(req, res, next) {
  const body = req.body ?? {};

  if (req.method === "POST") {
    const hasErpId = Boolean(String(body.erp_customer_id ?? "").trim());
    if (body.customer_tier !== "competitor" && !hasErpId) {
      body.customer_tier = "potential";
    }
    return next();
  }

  if (req.method === "PATCH" && Object.prototype.hasOwnProperty.call(body, "erp_customer_id")) {
    const nextErpId = String(body.erp_customer_id ?? "").trim();
    if (!nextErpId) {
      const { rows } = await pool.query("SELECT customer_tier FROM customers WHERE id = $1", [req.params.id]);
      if (rows[0]?.customer_tier !== "competitor") body.customer_tier = "potential";
    }
  }

  next();
}
