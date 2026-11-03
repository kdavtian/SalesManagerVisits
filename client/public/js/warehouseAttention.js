// The things that need the warehouse manager's attention, from the numbers of GET /api/warehouse/home: one list for his Home screen and
// for the count on his Home tab (badges.js). A separate file so the badge code does not pull the whole Home screen (and its styles) into
// the app's start-up.
import { t } from "./i18n.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));

export function attentionItems(h) {
  const items = [];
  if (h.to_pack.over_sla > 0) items.push({ level: "red", text: fill("ops_att_over_sla", { n: h.to_pack.over_sla }), to: "#/wh-pack" });
  if (h.to_pack.app > 0) items.push({ level: "amber", text: fill("ops_att_app", { n: h.to_pack.app }), to: "#/wh-pack" });
  if (h.shortage.products > 0) {
    const names = h.shortage.sample.map((r) => `${r.product_name} (${r.need}/${r.have})`).join(", ");
    items.push({ level: "red", text: fill("ops_att_shortage", { n: h.shortage.products, names }), to: "#/wh-pack?tab=product" });
  }
  if (h.packed.unrouted > 0) items.push({ level: "amber", text: fill("ops_att_unrouted", { n: h.packed.unrouted }), to: "#/wh-pack?tab=packed" });
  if (h.packed.over_sla > 0) items.push({ level: "red", text: fill("ops_att_deliver_over", { n: h.packed.over_sla }), to: "#/wh-pack?tab=packed" });
  if (h.stale_stops > 0) items.push({ level: "amber", text: fill("ops_att_stale", { n: h.stale_stops }), to: "#/delivery" });
  const sc = h.stock_count;
  if (sc && !sc.finished && sc.due > sc.counted) items.push({ level: "amber", text: fill("ops_att_stock_count", { n: sc.due - sc.counted }), to: "#/stock-count" });
  if (h.tasks.overdue > 0) items.push({ level: "amber", text: fill("ops_att_tasks", { n: h.tasks.overdue }), to: "#/tasks" });
  return items;
}
