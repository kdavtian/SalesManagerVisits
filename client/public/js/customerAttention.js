// The "needs attention" strip under the customer card's heading (owner, 2026-11-03): at most three short chips -- overdue debt, unpaid
// orders, no visit for N days -- so what to act on is the first thing seen. Nothing is shown for a customer who needs nothing. Each chip
// opens the screen where it is solved (data-attn: "overdue" and "unpaid" open the orders / payments sheets, "visit" the check-in).
import { t } from "./i18n.js";
import { escapeHtml, formatAmd } from "./util.js";

const DAY = 86400000;

export function attentionItems(customer) {
  const items = [];
  const summary = customer.debt_summary;
  if (summary && Number(summary.overdue_amd) > 0) items.push({ key: "overdue", text: `${t("attn_overdue_debt")}: ${formatAmd(Number(summary.overdue_amd))}`, level: "red" });
  if (summary && Number(summary.unpaid_orders) > 0) items.push({ key: "unpaid", text: t("attn_unpaid_orders").replace("{n}", summary.unpaid_orders), level: "amber" });
  // a customer who is never visited (the office, head-office channels) has no visit rhythm to miss
  const every = Number(customer.visit_frequency_days) || 0;
  if (customer.requires_visit !== false && every > 0 && customer.customer_tier !== "competitor") {
    const last = customer.last_visit_at ? new Date(customer.last_visit_at).getTime() : NaN;
    const days = Number.isFinite(last) ? Math.floor((Date.now() - last) / DAY) : null;
    if (days !== null && days > every) items.push({ key: "visit", text: t("attn_no_visit").replace("{n}", days), level: "amber" });
  }
  return items;
}

export function attentionStripHtml(customer) {
  const items = attentionItems(customer);
  if (!items.length) return "";
  return `<div class="cd-attention" role="status">${items
    .map((i) => `<button type="button" class="cd-attn cd-attn-${i.level}" data-attn="${i.key}">${escapeHtml(i.text)}</button>`)
    .join("")}</div>`;
}

// handlers: { overdue(), unpaid(), visit() }
export function bindAttention(container, handlers) {
  container.querySelectorAll("[data-attn]").forEach((b) => b.addEventListener("click", () => handlers[b.dataset.attn]?.()));
}
