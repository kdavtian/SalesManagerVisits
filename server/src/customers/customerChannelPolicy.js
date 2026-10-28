// Portfolio rule for newly-created customers:
// - competitors remain their own intelligence segment
// - every other customer without an ERP customer ID is Potential; asking for Bronze / Silver / Gold without one is refused with a clear
//   message instead of silently saving Potential (owner, 2026-10-24: "if user chooses gold, bronze or silver ERP customer id should be mandatory")
// Existing data is normalized by migration 049.
export function normalizeCustomerPortfolio(req, res, next) {
  const body = req.body ?? {};
  const hasErpId = Boolean(String(body.erp_customer_id ?? "").trim());
  if (!hasErpId && ["bronze", "silver", "gold"].includes(body.customer_tier)) {
    return res.status(400).json({ error: "ERP customer ID is required for Bronze, Silver and Gold customers" });
  }
  if (body.customer_tier !== "competitor" && !hasErpId) body.customer_tier = "potential";
  next();
}
