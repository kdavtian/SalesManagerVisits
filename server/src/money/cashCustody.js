// Cash still in someone's hands (payments redesign, release 3, owner 2026-11-02). The old rule was "status = pending", so a payment the
// Excel already shows (approved automatically from the ERP sync) dropped out of the rep's hand-over while the notes were still in his
// pocket. Now: not rejected, and not yet received by a person (a person's approval or the accountant's confirmed hand-over). Only
// payments from the cutover on: older ERP-approved ones are the archive and must not flood the hand-over cards and the custody alerts.
// `p` is the alias of payments.
export const CASH_IN_HAND_SQL = `(p.status = 'pending' OR (p.status = 'approved' AND p.approved_from_erp AND p.approved_by IS NULL
  AND p.payment_date >= (SELECT payments_cutover FROM app_settings WHERE id = 1)
  AND NOT EXISTS (SELECT 1 FROM users hu WHERE hu.id = p.current_holder_id AND hu.role = 'accountant')))`;
