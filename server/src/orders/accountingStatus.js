export const ACCOUNTING_STATUSES = [
  "pending",
  "in_progress",
  "waybill_created",
  "partially_created",
  "exported_unsigned",
  "signed",
  "needs_attention",
  "cancelled",
];

// Order-level accounting status derived from its waybills' e-invoicing
// results. An order that still has lines without a waybill stays
// partially_created whatever the exported ones are doing.
export function nextStatusFromDocuments(current, docs) {
  if (current === "partially_created") return current;
  if (docs.length && docs.every((d) => d.einvoicing?.status === "signed")) return "signed";
  if (docs.length && docs.every((d) => d.einvoicing?.status)) return "exported_unsigned";
  return "waybill_created";
}

// Lily (and the accounting queue) may only be handed an order that management confirmed and nobody took back or cancelled: a draft is an
// order the warehouse sent back or a cancelled one; a submitted one is back in review. Expects the orders table aliased as `o`.
export const ORDER_LIVE_FOR_ACCOUNTING_SQL = "o.status IN ('confirmed', 'packed_stock_out', 'delivered', 'recorded') AND o.cancelled_at IS NULL";

// An order that leaves confirmed / packed (stock issue, cancellation, back to submitted): a request still waiting for Lily is withdrawn in the
// same UPDATE, so she is never handed it. A document already being made or made is left alone (a person deals with it).
export const WITHDRAW_WAITING_REQUEST_SQL = "accounting_status = CASE WHEN accounting_status IN ('pending', 'needs_attention') THEN 'cancelled' ELSE accounting_status END";

// The accounting statuses in which Lily is making, or has made, a document from the order's lines: changing the lines then needs a person.
export const DOCUMENT_STARTED_STATUSES = ["in_progress", "waybill_created", "partially_created", "exported_unsigned", "signed"];
