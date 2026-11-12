// "Checked by Vaghinak" (owner, 2026-11-12): a delivered or recorded order whose signed paper (order blank or signed act) Vaghinak read and found
// matching -- order number, total, the payment written on it against what was collected, both signatures (customers/aiBlankCheck.js). It gives
// the accountant extra assurance before marking the order Recorded; later, once Vaghinak proves accurate, it can record such orders by itself.
//
// The verdict is about the paper as it was read: if the order was corrected afterwards (its total changed), the old "ok" no longer proves it, so
// the read total must still equal the order's current total (a paper of several orders must name this order's code instead). `o` = orders alias.
export const VAGHINAK_CHECKED_SQL = `(o.status IN ('delivered', 'recorded') AND EXISTS (
  SELECT 1 FROM customer_files vf
  WHERE vf.order_ids @> ARRAY[o.id] AND vf.kind IN ('order_blank', 'signed_act') AND vf.ai_status = 'ok'
    AND CASE
      WHEN cardinality(vf.order_ids) = 1 THEN
        CASE WHEN jsonb_typeof(vf.ai_result->'read'->'total_amd') = 'number'
             THEN abs((vf.ai_result->'read'->>'total_amd')::numeric - o.total_amd) <= 1 ELSE false END
      ELSE lower(btrim(COALESCE(vf.ai_result->'read'->>'order_number', ''))) = lower(btrim(COALESCE(o.order_code, '')))
    END))`;
