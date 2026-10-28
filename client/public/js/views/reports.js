import { api } from "../api.js";
import { escapeHtml, firstUseHintHtml, activateFirstUseHints, downloadFromUrl } from "../util.js";
import { t } from "../i18n.js";
import { periodLabel, periodKey, periodAria } from "../periodButtons.js";
import { icons } from "../icons.js";
import { REGION_LIST, regionLabelHy, CATEGORY_LIST, formatAmd, openInfoPopup } from "../util.js";
import { PERIOD_OPTIONS, TIER_OPTIONS, OUTCOME_OPTIONS, formatDate, formatDateOnly, periodTabsHtml, selectHtml, reportHeaderHtml, formatDateTime } from "./reports/common.js";
import { renderCustomerDebtReport } from "./reports/debt.js";
import { renderSalesBudgetReport, renderBrandVolumeReport, renderBrandAvailabilityReport, renderProductWishesReport } from "./reports/sales.js";
import { renderPaymentsReport, renderCashCustodyReport, renderCashReconciliationReport, renderDailyManagementReport } from "./reports/money.js";

if (typeof document !== "undefined" && !window.__reportPeriodTabs) {
  window.__reportPeriodTabs = true;
  document.addEventListener("click", (e) => {
    const tab = e.target.closest?.(".report-period-tabs [data-period-value]");
    if (!tab) return;
    const wrap = tab.closest(".report-period-tabs");
    const input = wrap.querySelector('input[type="hidden"]');
    const paint = (b, on, previous) => {
      b.classList.toggle("activity-tab-active", on);
      b.classList.toggle("period-prev", on && previous);
      b.setAttribute("aria-selected", String(on));
      if (b.dataset.base) {
        b.textContent = periodLabel(b.dataset.base, on && previous);
        b.setAttribute("aria-label", on ? periodAria(b.dataset.base, previous) : periodLabel(b.dataset.base));
      }
    };
    const base = tab.dataset.base;
    if (input.value === tab.dataset.periodValue || (base && input.value === periodKey(base, true))) {
      // the selected button: flip current <-> previous (a button without a previous, like "All", does nothing)
      if (!base) return;
      const previous = input.value !== base;
      input.value = periodKey(base, !previous);
      paint(tab, true, !previous);
    } else {
      wrap.querySelectorAll("[data-period-value]").forEach((b) => paint(b, b === tab, false));
      input.value = tab.dataset.periodValue;
    }
    tab.scrollIntoView?.({ inline: "center", block: "nearest", behavior: "smooth" });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// Reports is its own mini-router within one hash (#/reports) -- a list
// page when no report is selected, or one of the three report views when
// `r` is set in the query string. Kept in one file since the views share
// the same header/back-button chrome and filter-building conventions.
export async function renderReports(root, navigate, reportKey, { inPane = false } = {}) {
  // Desktop: the list on the left, the report on the right (reportsDesk.js draws the report through this same function).
  if (!inPane && window.matchMedia?.("(min-width: 1024px)").matches) {
    const { renderReportsDesk } = await import("../reportsDesk.js");
    return renderReportsDesk(root, navigate, reportKey, {
      groups: REPORT_GROUPS,
      iconFor: (key) => REPORT_ICONS[key] || icons.chart,
      renderReport: (pane, key) => renderReports(pane, navigate, key, { inPane: true }),
    });
  }
  if (reportKey === "new_customers") return renderNewCustomersReport(root, navigate);
  if (reportKey === "checkins") return renderCheckinsReport(root, navigate);
  if (reportKey === "weekly_scorecard") return (await import("./bizReports.js")).renderWeeklyScorecard(root, navigate);
  if (reportKey === "delivery_speed") return (await import("./bizReports.js")).renderDeliverySpeed(root, navigate);
  if (reportKey === "customer_pipeline") return (await import("./bizReports.js")).renderCustomerPipeline(root, navigate);
  if (reportKey === "unpaid_invoices") return (await import("./bizReports.js")).renderUnpaidInvoices(root, navigate);
  if (reportKey === "fuel_allowance") return (await import("./fuelReport.js")).renderFuelReport(root, navigate);
  if (reportKey === "orders_pipeline") return renderOrdersPipelineReport(root, navigate);
  if (reportKey === "brand_availability") return renderBrandAvailabilityReport(root, navigate);
  if (reportKey === "product_wishes") return renderProductWishesReport(root, navigate);
  if (reportKey === "payments") return renderPaymentsReport(root, navigate);
  // Payments (Excel) now lives on the Sales page as its Payments tab.
  if (reportKey === "erp_payments") return navigate("#/sales?tab=payments");
  if (reportKey === "cash_custody") return renderCashCustodyReport(root, navigate);
  if (reportKey === "cash_reconciliation") return renderCashReconciliationReport(root, navigate);
  if (reportKey === "customer_debt") return renderCustomerDebtReport(root, navigate);
  if (reportKey === "sales_budget") return renderSalesBudgetReport(root, navigate);
  if (reportKey === "product_liters") return (await import("./volumeReport.js")).renderVolumeReport(root, navigate);
  if (reportKey === "brand_volume") return renderBrandVolumeReport(root, navigate);
  if (reportKey === "daily_management") return renderDailyManagementReport(root, navigate);
  if (reportKey === "documents") return renderDocumentsReport(root, navigate);
  return renderReportsList(root, navigate);
}

const GENERATED_REPORT_TYPE_LABEL_KEY = {
  sales_director: "report_documents_type_sales_director",
  debt_receivables: "report_documents_type_debt_receivables",
  ceo_management: "report_documents_type_ceo_management",
};

async function renderDocumentsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_documents_name")}
      <div id="documents-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const listEl = container.querySelector("#documents-list");

  try {
    const docs = await api.listGeneratedReports();
    if (!docs.length) {
      listEl.innerHTML = `<p class="empty-state">${t("report_documents_empty")}</p>`;
      return;
    }
    // Grouped by report_date (already the API's primary sort) instead of one
    // flat list -- the bot typically pushes all 3 report types for the same
    // date together, so a flat list repeats that date on every single row
    // and only gets harder to scan as more days pile up. The heading carries
    // the date instead, once per group.
    let lastDate = null;
    listEl.innerHTML = docs
      .map((d) => {
        const dateHeading = d.report_date !== lastDate ? `<p class="list-group-heading">${formatDateOnly(d.report_date)}</p>` : "";
        lastDate = d.report_date;
        return `
      ${dateHeading}
      <a class="card report-row" href="/api/reports/documents/${d.id}/download" data-download="report-${d.id}">
        <strong>${t(GENERATED_REPORT_TYPE_LABEL_KEY[d.report_type] || d.report_type)}</strong>
        <span>${icons.download}</span>
      </a>`;
      })
      .join("");
    // Saved in place (share sheet / download), never by navigating the app
    // window to the file -- an installed PWA would have no way back.
    listEl.addEventListener("click", async (e) => {
      const link = e.target.closest("a[data-download]");
      if (!link) return;
      e.preventDefault();
      try {
        await downloadFromUrl(link.getAttribute("href"), link.dataset.download);
      } catch (err) {
        alert(err.message);
      }
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

async function renderReportsList(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("reports")}</h1></div>
      </div>
      ${firstUseHintHtml("reports_index", t("hint_reports_index"))}
      <div id="reports-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  activateFirstUseHints(container);
  const listEl = container.querySelector("#reports-list");

  try {
    const reports = (await api.listReports()).filter((r) => r.key !== "erp_payments");
    if (!reports.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_reports_available")}</p>`;
      return;
    }
    const byKey = new Map(reports.map((r) => [r.key, r]));
    const placed = new Set();
    const groupsHtml = REPORT_GROUPS.map(({ id, keys }) => {
      const items = keys.map((k) => byKey.get(k)).filter(Boolean);
      items.forEach((r) => placed.add(r.key));
      return reportGroupHtml(id, items);
    });
    const rest = reports.filter((r) => !placed.has(r.key));
    if (rest.length) groupsHtml.push(reportGroupHtml("other", rest));
    listEl.innerHTML = groupsHtml.join("");
    listEl.querySelectorAll(".report-list-card").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/reports?r=${el.dataset.key}`));
    });
    // The one-line explanation of each report lives behind its own "!"
    // instead of a 3-4 line paragraph on every row (the list was ~2,700 px
    // tall at 390 px; now every report is one 56 px row).
    listEl.querySelectorAll("[data-report-info]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = byKey.get(btn.dataset.reportInfo);
        if (r) openInfoPopup(`<h3>${escapeHtml(t(r.nameKey))}</h3><p>${escapeHtml(t(r.descriptionKey))}</p>`);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

// The list used to be a flat run of 19 cards with a long description each.
// Grouped by the decision they support (owner: fewer rows, less scrolling);
// the server already hides what a role may not see, empty groups vanish.
const REPORT_GROUPS = [
  { id: "management", keys: ["daily_management", "weekly_scorecard", "sales_budget", "product_liters", "brand_volume"] },
  { id: "money", keys: ["customer_debt", "unpaid_invoices", "payments", "cash_custody", "cash_reconciliation"] },
  { id: "orders", keys: ["orders_pipeline", "delivery_speed", "customer_pipeline", "new_customers", "brand_availability", "product_wishes"] },
  { id: "team", keys: ["checkins", "fuel_allowance"] },
  { id: "documents", keys: ["documents"] },
];

function reportGroupHtml(id, items) {
  if (!items.length) return "";
  return `
    <h2 class="section-title report-group-title">${t(`reports_group_${id}`)}</h2>
    <div class="report-group">
      ${items
        .map(
          (r) => `
        <div class="report-item">
          <button type="button" class="report-list-card" data-key="${r.key}">
            <span class="report-list-icon">${REPORT_ICONS[r.key] || icons.chart}</span>
            <strong>${t(r.nameKey)}</strong>
            <span class="report-item-chevron" aria-hidden="true">${icons.chevronRight}</span>
          </button>
          <button type="button" class="settings-hint-icon report-item-info" data-report-info="${r.key}" aria-label="${t("more_info")}">!</button>
        </div>`
        )
        .join("")}
    </div>`;
}

const REPORT_ICONS = {
  new_customers: icons.mapPinPlus,
  checkins: icons.mapPinCheck,
  fuel_allowance: icons.route,
  weekly_scorecard: icons.clipboardCheck,
  customer_pipeline: icons.mapPinPlus,
  delivery_speed: icons.route,
  orders_pipeline: icons.cart,
  brand_availability: icons.store,
  product_wishes: icons.sparkles,
  payments: icons.payment,
  erp_payments: icons.wallet,
  cash_custody: icons.wallet,
  cash_reconciliation: icons.clipboardCheck,
  customer_debt: icons.warning,
  unpaid_invoices: icons.clipboardCheck,
  sales_budget: icons.target,
  product_liters: icons.box,
  brand_volume: icons.box,
  daily_management: icons.dashboard,
  documents: icons.note,
};

// syncBadgeHtml now lives in util.js, shared with sales.js and
// debtBalances.js (see its own comment there for why).

async function renderNewCustomersReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_new_customers_name")}
      <form id="report-filters" class="report-filter-form">
        ${periodTabsHtml("period", PERIOD_OPTIONS.map((o) => ({ ...o, label: o.labelKey ? t(o.labelKey) : "" })), "month")}
        ${selectHtml("region", [{ value: "", label: t("region") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("rp_f_tier") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { customers, by_manager } = await api.getNewCustomersReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("by_manager")}</h2>
        <div class="card-list">
          ${
            by_manager.length
              ? by_manager
                  .map(
                    (m) => `
              <div class="card report-row">
                <span>${escapeHtml(m.user_name)}</span>
                <strong>${m.new_customers}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
        <h2 class="section-title">${t("customers")} (${customers.length})</h2>
        <div class="card-list">
          ${
            customers.length
              ? customers
                  .map(
                    (c) => `
              <div class="card report-row-multiline">
                <div class="report-debt-customer-top">
                  <strong class="report-debt-customer-name">${escapeHtml(c.name)}</strong>
                  <span class="muted report-created-date">${formatDate(c.created_at)}</span>
                </div>
                <span class="muted">${escapeHtml(c.region || "")}${c.subregion ? `, ${escapeHtml(c.subregion)}` : ""} · ${escapeHtml(c.created_by_name)}</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

async function renderCheckinsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_checkins_name")}
      <form id="report-filters" class="report-filter-form">
        ${periodTabsHtml("period", PERIOD_OPTIONS.map((o) => ({ ...o, label: o.labelKey ? t(o.labelKey) : "" })), "month")}
        ${selectHtml("region", [{ value: "", label: t("region") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
        ${selectHtml(
          "category",
          [{ value: "", label: t("category") }, ...CATEGORY_LIST.map((c) => ({ value: c.value, label: c.value }))],
          ""
        )}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("rp_f_tier") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
        ${selectHtml(
          "outcome",
          [{ value: "", label: t("rp_f_outcome") }, ...OUTCOME_OPTIONS.map((v) => ({ value: v, label: t(`outcome_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { checkins, total } = await api.getCheckinsReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("checkins")} (${total})</h2>
        <div class="card-list">
          ${
            checkins.length
              ? checkins
                  .map(
                    (c) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(c.customer_name)}</strong>
                <span class="muted">${escapeHtml(c.user_name)} · ${formatDate(c.timestamp)}${c.region ? ` · ${escapeHtml(c.region)}` : ""}</span>
                <span class="muted">${(c.outcomes || []).map((o) => t(`outcome_${o}`)).join(", ")}</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

const ORDER_PIPELINE_STATUS_KEYS = {
  draft: "order_status_draft",
  submitted: "order_status_submitted",
  confirmed: "order_status_confirmed",
  packed_stock_out: "order_status_packed_stock_out",
  delivered: "order_status_delivered",
};

async function renderOrdersPipelineReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_orders_pipeline_name")}
      <form id="report-filters" class="report-filter-form">
        ${periodTabsHtml("period", PERIOD_OPTIONS.map((o) => ({ ...o, label: o.labelKey ? t(o.labelKey) : "" })), "month")}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { by_status, active, delivered, discount } = await api.getOrdersPipelineReport(params);
      const statusLabel = (s) => (ORDER_PIPELINE_STATUS_KEYS[s] ? t(ORDER_PIPELINE_STATUS_KEYS[s]) : s);

      body.innerHTML = `
        <h2 class="section-title">${t("report_orders_pipeline_by_status")}</h2>
        <div class="card-list">
          ${
            by_status.length
              ? by_status
                  .map(
                    (r) => `
              <div class="card report-row">
                <span>${escapeHtml(statusLabel(r.status))}</span>
                <strong>${r.count} · ${formatAmd(Number(r.total_amd))}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_active_title")}</h2>
        <div class="card-list">
          ${
            active.length
              ? active
                  .map(
                    (r) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(statusLabel(r.status))} · ${r.count}</strong>
                <span class="muted">${t("report_orders_pipeline_oldest_since").replace("{date}", formatDateTime(r.oldest_updated_at))}${
                      Number(r.stuck_over_48h) > 0
                        ? ` · <span class="sync-badge-stale">${t("report_orders_pipeline_stuck_over_48h").replace("{n}", r.stuck_over_48h)}</span>`
                        : ""
                    }</span>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_delivered_title")}</h2>
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value">${delivered.avg_cycle_hours != null ? `${Number(delivered.avg_cycle_hours).toFixed(1)}h` : "—"}</span>
            <span class="stat-label">${t("report_orders_pipeline_delivered_cycle")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${delivered.delivered_count}</span>
            <span class="stat-label">${t("report_orders_pipeline_delivered_count")}</span>
          </div>
        </div>

        <h2 class="section-title">${t("report_orders_pipeline_discount_title")}</h2>
        <div class="card-list">
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_pending")}</span>
            <strong>${discount.pending_count}${
              discount.oldest_pending_at ? ` · ${t("report_orders_pipeline_oldest_since").replace("{date}", formatDateTime(discount.oldest_pending_at))}` : ""
            }</strong>
          </div>
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_approved")}</span>
            <strong>${discount.approved_count}</strong>
          </div>
          <div class="card report-row">
            <span>${t("report_orders_pipeline_discount_rejected")}</span>
            <strong>${discount.rejected_count}</strong>
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}

