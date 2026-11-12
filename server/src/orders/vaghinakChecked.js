// "Checked by Vaghinak" (owner, 2026-11-12): a delivered or recorded order whose photographed signed paper Vaghinak read and found matching --
// order number, total, the payment written on it against what the app recorded at delivery, both signatures (customers/aiBlankCheck.js). It
// gives the accountant extra assurance before marking the order Recorded; later, once Vaghinak proves accurate, it can record such orders.
//
// Only a verdict that can prove it counts:
//   * read by the current rules (ai_result.v >= 2) and after the order was delivered (ai_result.after_delivery), so the payment was compared;
//   * the paper names THIS order (its number), so last month's paper of the same basket cannot pass;
//   * a paper of one order: the read total still equals the order's current total (a correction after the check takes the chip away);
//   * no return requested / made on the order since (the paper no longer describes what the customer kept).
// `o` = orders alias. Every cast is guarded: bad JSON in one document never breaks the list.
export const VAGHINAK_CHECKED_SQL = `(o.status IN ('delivered', 'recorded')
  AND NOT EXISTS (SELECT 1 FROM order_returns vr WHERE vr.order_id = o.id AND vr.status IN ('requested', 'approved', 'done'))
  AND EXISTS (
  SELECT 1 FROM customer_files vf
  WHERE vf.order_ids @> ARRAY[o.id] AND vf.kind IN ('order_blank', 'signed_act') AND vf.ai_status = 'ok'
    AND CASE WHEN jsonb_typeof(vf.ai_result->'v') = 'number' THEN (vf.ai_result->>'v')::numeric >= 2 ELSE false END
    AND vf.ai_result->'after_delivery' = 'true'::jsonb
    AND (o.order_code IS NULL OR lower(btrim(COALESCE(vf.ai_result->'read'->>'order_number', ''))) = lower(btrim(o.order_code)))
    AND CASE
      WHEN cardinality(vf.order_ids) = 1 THEN
        CASE WHEN jsonb_typeof(vf.ai_result->'read'->'total_amd') = 'number'
             THEN abs((vf.ai_result->'read'->>'total_amd')::numeric - o.total_amd) <= 1 ELSE false END
      ELSE true
    END))`;
