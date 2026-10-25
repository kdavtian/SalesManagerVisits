// Desktop Home (owner, 2026-10-25): instead of repeating the sidebar menu as tiles, management sees the company's numbers, each one a link to the page where it is
// dealt with. Phones keep the tiles (the block is hidden below 1024 px by CSS and not even requested there).
import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { loadWithCache } from "../listCache.js";
import { state } from "../state.js";

export const KPI_ROLES = ["admin", "ceo", "operations_director", "sales_director", "accountant"];
export const wantsKpis = () => KPI_ROLES.includes(state.user.role) && window.matchMedia?.("(min-width: 1024px)").matches;

const fill = (text, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), text);
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

function tile({ href, label, value, sub, tone = "", extra = "" }) {
  return `<a class="card home-kpi${tone ? ` home-kpi-${tone}` : ""}" href="${href}">
    <span class="home-kpi-label">${escapeHtml(label)}</span>
    <span class="home-kpi-value">${value}</span>
    <span class="home-kpi-sub">${sub}</span>
    ${extra}
  </a>`;
}

function html(k) {
  const s = k.sales;
  const delta = s.prev_mtd_amd > 0 ? Math.round(((s.mtd_amd - s.prev_mtd_amd) / s.prev_mtd_amd) * 100) : null;
  const trend = delta == null ? "" : `<span class="${delta >= 0 ? "trend-up" : "trend-down"}">${delta >= 0 ? "&#8593;" : "&#8595;"} ${fill(t("kpi_vs_last"), { pct: `${delta >= 0 ? "+" : ""}${delta}` })}</span>`;
  const lastMonth = fill(t("kpi_last_month"), { amount: formatAmd(s.prev_month_amd) });
  const bar = s.prev_month_amd > 0 ? Math.min(100, Math.round((s.mtd_amd / s.prev_month_amd) * 100)) : 0;
  const o = k.orders;
  const waiting = o.to_confirm + o.to_pack + o.to_deliver;
  return `
    <h2 class="section-title section-title-tight">${t("kpi_title")}</h2>
    <div class="home-kpi-grid">
      ${tile({
        href: "#/sales",
        label: t("kpi_sales"),
        value: escapeHtml(formatAmd(s.mtd_amd)),
        sub: `${trend}<span class="muted">${escapeHtml(lastMonth)}</span>`,
        extra: `<span class="home-kpi-bar" aria-hidden="true"><span style="width:${bar}%"></span></span>`,
      })}
      ${tile({
        href: "#/debt-balances",
        label: t("kpi_debt"),
        value: escapeHtml(formatAmd(k.debt.total_amd)),
        sub: `<span class="${k.debt.overdue_amd > 0 ? "trend-down" : "muted"}">${escapeHtml(fill(t("kpi_debt_sub"), { overdue: formatAmd(k.debt.overdue_amd), n: fmt(k.debt.customers) }))}</span>`,
        tone: k.debt.overdue_amd > 0 ? "warn" : "",
      })}
      ${tile({
        href: "#/payments",
        label: t("kpi_unrec"),
        value: escapeHtml(formatAmd(k.payments.not_in_excel_amd)),
        sub: `<span class="${k.payments.not_in_excel_count ? "trend-down" : "muted"}">${escapeHtml(fill(t("kpi_unrec_sub"), { n: fmt(k.payments.not_in_excel_count), p: fmt(k.payments.pending_approval) }))}</span>`,
        tone: k.payments.not_in_excel_count ? "warn" : "",
      })}
      ${tile({
        href: "#/orders",
        label: t("kpi_orders"),
        value: fmt(waiting),
        sub: `<span class="muted">${escapeHtml(waiting ? fill(t("kpi_orders_sub"), { a: fmt(o.to_confirm), b: fmt(o.to_pack), c: fmt(o.to_deliver) }) : t("kpi_none"))}</span>`,
      })}
      ${tile({
        href: "#/tasks",
        label: t("kpi_tasks"),
        value: fmt(k.tasks.open),
        sub: `<span class="${k.tasks.overdue ? "trend-down" : "muted"}">${escapeHtml(k.tasks.overdue ? fill(t("kpi_tasks_sub"), { n: fmt(k.tasks.overdue) }) : t("kpi_none"))}</span>`,
        tone: k.tasks.overdue ? "warn" : "",
      })}
    </div>`;
}

// Home repaints itself (cache first, then the live answer) and its slot is a new element each time: both paints share one request,
// and whatever slot is current gets the numbers.
const recent = { at: 0, run: null, slot: null, last: null };

function paintInto(slot, k) {
  if (!slot?.isConnected) return;
  slot.innerHTML = html(k);
  slot.hidden = false;
}

// A failure leaves the block empty (the rest of Home is not affected).
export async function renderHomeKpis(slot) {
  if (!slot || !wantsKpis()) return;
  recent.slot = slot;
  if (recent.last) paintInto(slot, recent.last);
  if (recent.run && Date.now() - recent.at < 3000) return;
  recent.at = Date.now();
  try {
    recent.run = loadWithCache(`home-kpis:${state.user.id}`, () => api.dashboardKpis(), (k) => {
      recent.last = k;
      paintInto(recent.slot, k);
    });
    await recent.run;
  } catch {
    if (!recent.last) slot.hidden = true;
  }
}
