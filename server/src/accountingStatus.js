// Order-level accounting status derived from its waybills' e-invoicing
// results. An order that still has lines without a waybill stays
// partially_created whatever the exported ones are doing.
export function nextStatusFromDocuments(current, docs) {
  if (current === "partially_created") return current;
  if (docs.length && docs.every((d) => d.einvoicing?.status === "signed")) return "signed";
  if (docs.length && docs.every((d) => d.einvoicing?.status)) return "exported_unsigned";
  return "waybill_created";
}
