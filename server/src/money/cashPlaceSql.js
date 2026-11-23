// What shared/cashPlace.js needs about a payment, as SQL for any query over `payments p`: add CASH_PLACE_JOINS after the FROM / JOINs,
// CASH_PLACE_SELECT to the column list, then addCashPlace(row) puts `cash_place` = { place, name, to } on the row (and removes nothing).
// The office desk: a desk an accountant holds, also when the CEO holds it with her (owner, 2026-11-02): cash there is at the office.
import { cashPlace } from "../shared/cashPlace.js";

// "this person's cash is on the office desk": a CASH desk he holds together with an accountant
export const officeDeskSql = (holderIdSql) => `EXISTS (SELECT 1 FROM cash_desk_holders mine JOIN cash_desk_holders other ON other.account_id = mine.account_id
          JOIN cash_accounts desk ON desk.id = mine.account_id AND desk.kind = 'cash'
          JOIN users au ON au.id = other.user_id AND au.role = 'accountant' WHERE mine.user_id = ${holderIdSql})`;
export const CASH_PLACE_SELECT = `cph.role AS holder_role, cph.name AS holder_name, cpt.name AS handoff_to_name,
  ${officeDeskSql("p.current_holder_id")} AS on_office_desk,
  (p.approved_by IS NOT NULL AND p.approved_by = p.current_holder_id) AS holder_approved,
  ((p.payment_date AT TIME ZONE 'Asia/Yerevan')::date < (SELECT payments_cutover FROM app_settings WHERE id = 1)) AS before_cutover`;
export const CASH_PLACE_JOINS = `LEFT JOIN users cph ON cph.id = p.current_holder_id
  LEFT JOIN cash_handoffs cpo ON cpo.id = p.pending_handoff_id LEFT JOIN users cpt ON cpt.id = cpo.to_user_id`;

export function addCashPlace(row) {
  row.cash_place = cashPlace(row);
  return row;
}
