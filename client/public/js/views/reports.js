import { api } from "../api.js";
import { escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { REGION_LIST, YEREVAN_DISTRICTS, CATEGORY_LIST } from "../util.js";

const PERIOD_OPTIONS = [
  { value: "", labelKey: "period_all_time" },
  { value: "today", labelKey: "tab_today" },
  { value: "week", labelKey: "tab_week" },
  { value: "month", labelKey: "tab_month" },
  { value: "year", labelKey: "period_year" },
];

const TIER_OPTIONS = ["potential", "bronze", "silver", "gold", "competitor"];

const OUTCOME_OPTIONS = [
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "assortment_check",
  "customer_unavailable",
  "complaint",
  "other",
];

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function selectHtml(name, options, value) {
  return `<select name="${name}">${options
    .map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("")}</select>`;
}

// Reports is its own mini-router within one hash (#/reports) -- a list
// page when no report is selected, or one of the three report views when
// `r` is set in the query string. Kept in one file since the views share
// the same header/back-button chrome and filter-building conventions.
export async function renderReports(root, navigate, reportKey) {
  if (reportKey === "new_customers") return renderNewCustomersReport(root, navigate);
  if (reportKey === "checkins") return renderCheckinsReport(root, navigate);
  if (reportKey === "brand_availability") return renderBrandAvailabilityReport(root, navigate);
  return renderReportsList(root, navigate);
}

async function renderReportsList(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("reports")}</h1></div>
      </div>
      <div id="reports-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  const listEl = container.querySelector("#reports-list");

  try {
    const reports = await api.listReports();
    if (!reports.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_reports_available")}</p>`;
      return;
    }
    listEl.innerHTML = reports
      .map(
        (r) => `
      <button type="button" class="card report-list-card" data-key="${r.key}">
        <span class="report-list-icon">${icons.chart}</span>
        <div class="report-list-text">
          <strong>${t(r.nameKey)}</strong>
          <span class="muted">${t(r.descriptionKey)}</span>
        </div>
      </button>`
      )
      .join("");
    listEl.querySelectorAll(".report-list-card").forEach((el) => {
      el.addEventListener("click", () => navigate(`#/reports?r=${el.dataset.key}`));
    });
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

function reportHeaderHtml(titleKey) {
  return `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title"><h1>${t(titleKey)}</h1></div>
    </div>
  `;
}

function subregionOptions(region) {
  if (region === "Yerevan") return YEREVAN_DISTRICTS;
  return [];
}

async function renderNewCustomersReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_new_customers_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("all_tiers") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
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
                <strong>${escapeHtml(c.name)}</strong>
                <span class="muted">${escapeHtml(c.region || "")}${c.subregion ? `, ${escapeHtml(c.subregion)}` : ""} · ${escapeHtml(c.created_by_name)} · ${formatDate(c.created_at)}</span>
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
        ${selectHtml(
          "period",
          PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
          "month"
        )}
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
        ${selectHtml(
          "category",
          [{ value: "", label: t("all_categories") }, ...CATEGORY_LIST.map((c) => ({ value: c.value, label: c.value }))],
          ""
        )}
        ${selectHtml(
          "customer_tier",
          [{ value: "", label: t("all_tiers") }, ...TIER_OPTIONS.map((v) => ({ value: v, label: t(`tier_${v}`) }))],
          ""
        )}
        ${selectHtml(
          "outcome",
          [{ value: "", label: t("all_outcomes") }, ...OUTCOME_OPTIONS.map((v) => ({ value: v, label: t(`outcome_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
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

const BRAND_LABELS = {
  castrol: "Castrol",
  lotos: "Lotos",
  royal: "Royal",
  mobil: "Mobil",
  motul: "Motul",
  shell: "Shell",
  liquimoly: "Liqui Moly",
  bardahl: "Bardahl",
  aral: "Aral",
  oscar: "Oscar",
  zic: "ZIC",
  russian_oil: "Russian oil",
};

function summarizeBrandStatus(brandStatus) {
  const present = [];
  for (const brand of ["castrol", "lotos", "royal"]) {
    if ((brandStatus[brand] || []).length) present.push(BRAND_LABELS[brand]);
  }
  for (const key of brandStatus.competitors || []) {
    if (BRAND_LABELS[key]) present.push(BRAND_LABELS[key]);
  }
  return present;
}

async function renderBrandAvailabilityReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_brand_availability_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml("region", [{ value: "", label: t("all_regions") }, ...REGION_LIST.map((r) => ({ value: r, label: r }))], "")}
      </form>
      <p class="muted" style="margin: 0 4px 8px;">${t("brand_availability_map_hint")}</p>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const rows = await api.getBrandAvailabilityReport(params);
      body.innerHTML = `
        <h2 class="section-title">${t("customers")} (${rows.length})</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map((r) => {
                    const brands = summarizeBrandStatus(r.brand_status || {});
                    return `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(r.name)}</strong>
                <span class="muted">${escapeHtml(r.region || "")}${r.subregion ? `, ${escapeHtml(r.subregion)}` : ""} · ${formatDate(r.as_of)}</span>
                <span class="muted">${brands.length ? brands.map(escapeHtml).join(", ") : t("no_data")}</span>
              </div>`;
                  })
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
