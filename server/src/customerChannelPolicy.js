// Portfolio rule for newly-created customers:
// - competitors remain their own intelligence segment
// - every other customer without an ERP customer ID is Potential
// Existing data is normalized by migration 049.
export function normalizeCustomerPortfolio(req, res, next) {
  const body = req.body ?? {};
  const hasErpId = Boolean(String(body.erp_customer_id ?? "").trim());
  if (body.customer_tier !== "competitor" && !hasErpId) body.customer_tier = "potential";
  next();
}
