// Reports > sales budget, brand volume, brand availability and wished products (moved out of reports.js with the refactor tool,
// docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { REGION_LIST, amdWithUnitHtml, channelDisplayLabel, escapeHtml, formatAmd, formatDateDMY, labelColon, regionLabelHy } from "../../util.js";
import { t } from "../../i18n.js";
import { channelOptions, currentYearMonth, formatDate, periodTabsHtml, reportHeaderHtml, selectHtml, wireSyncHint } from "./common.js";

export async function renderSalesBudgetReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_sales_budget_name", { hint: true })}
      <form id="report-filters" class="report-filter-form">
        <input type="month" name="month" value="${currentYearMonth()}" />
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  const syncAlert = wireSyncHint(container);
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  function achievedPct(sales, budget) {
    if (!budget) return "—";
    return `${Math.round((sales / budget) * 100)}%`;
  }

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { rows, totals, sync } = await api.getSalesBudgetReport(params);
      body.innerHTML = `
        ${syncAlert(sync)}
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.sales_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_sales")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_budget")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value">${achievedPct(totals.sales_amd, totals.budget_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_achieved")}</span>
          </div>
          <div class="stat-card">
            <span class="stat-value stat-value-amd">${amdWithUnitHtml(totals.collected_amd)}</span>
            <span class="stat-label">${t("report_sales_budget_collected")}</span>
          </div>
        </div>

        <h2 class="section-title">${t("by_channel")}</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map(
                    (r) => `
              <div class="card report-row-multiline">
                <strong>${escapeHtml(r.channel_name || channelDisplayLabel(r.rep_name))}</strong>
                <span class="muted">${formatAmd(Number(r.sales_amd))} / ${formatAmd(Number(r.budget_amd))} (${achievedPct(Number(r.sales_amd), Number(r.budget_amd))}) · ${t("report_sales_budget_collected")}${labelColon()}${formatAmd(Number(r.collected_amd))}</span>
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

// Deliberately not run through t() -- these are trademarked brand names,
// not translatable UI copy, and read the same in Armenian as in English.
export const BRAND_LABELS = {
  castrol: "Castrol",
  lotos: "Lotos",
  royal: "Royal",
  mobil: "Mobil",
  motul: "Motul",
  shell: "Shell",
  liquimoly: "Liqui Moly",
  bardahl: "Bardahl",
  aral: "Aral",
  petronas: "Petronas",
  fuchs: "Fuchs",
  total: "Total",
  ravenol: "Ravenol",
  oscar: "Oscar",
  amsoil: "AMSoil",
  zic: "ZIC",
  pennzoil: "Pennzoil",
  addinol: "Addinol",
  s_oil: "S-Oil",
  kixx: "Kixx",
  russian_oil: "Russian oil",
};

export function brandLabel(key) {
  return BRAND_LABELS[key] || key;
}

export async function renderBrandVolumeReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_brand_volume_name", { hint: true })}
      <form id="report-filters" class="report-filter-form">
        <input type="month" name="month" value="${currentYearMonth()}" />
        <select name="sales_channel"><option value="">${t("all_channels")}</option></select>
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  const syncAlert = wireSyncHint(container);
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  try {
    const options = await channelOptions();
    form.querySelector('select[name="sales_channel"]').outerHTML = selectHtml("sales_channel", options, "");
  } catch {
    // Filter convenience only, same as the debt report above.
  }

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    try {
      const { rows, by_brand, sync } = await api.getBrandVolumeReport(params);
      body.innerHTML = `
        ${syncAlert(sync)}
        <h2 class="section-title">${t("report_brand_volume_total")}</h2>
        <div class="card-list">
          ${
            by_brand.length
              ? by_brand
                  .map(
                    (b) => `
              <div class="card report-row">
                <span>${escapeHtml(brandLabel(b.brand))}</span>
                <strong>${Number(b.total_liters).toLocaleString("en-US")} L</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("by_channel")}</h2>
        <div class="card-list">
          ${
            rows.length
              ? rows
                  .map(
                    (r) => `
              <div class="card report-row">
                <span>${escapeHtml(r.channel_name || channelDisplayLabel(r.channel_code))} · ${escapeHtml(brandLabel(r.brand))}</span>
                <strong>${Number(r.liters).toLocaleString("en-US")} L</strong>
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

export function summarizeBrandStatus(brandStatus) {
  const present = [];
  for (const brand of ["castrol", "lotos", "royal"]) {
    if ((brandStatus[brand] || []).length) present.push(BRAND_LABELS[brand]);
  }
  for (const key of brandStatus.competitors || []) {
    if (BRAND_LABELS[key]) present.push(BRAND_LABELS[key]);
  }
  return present;
}

export async function renderBrandAvailabilityReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_brand_availability_name")}
      <form id="report-filters" class="report-filter-form">
        ${selectHtml("region", [{ value: "", label: t("region") }, ...REGION_LIST.map((r) => ({ value: r, label: regionLabelHy(r) }))], "")}
      </form>
      <p class="muted" style="margin: 0 4px 8px;">${t("brand_availability_map_hint")}</p>
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

// Wished products (1.452.0): what customers asked for that we did not have -- out-of-stock catalog products and products we never carried --
// most wanted first (by customers, then quantity). Tap a row for who asked, how many, when and through whom.
export async function renderProductWishesReport(root, navigate) {
  const periods = ["d30", "d90", "d365", "all"].map((p) => ({ value: p, label: t(`wish_period_${p}`) }));
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_product_wishes_name")}
      <form id="report-filters" class="report-filter-form">${periodTabsHtml("period", periods, "d90")}</form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  const itemHtml = (i) => `
    <li class="wish-item">
      <span class="wish-item-main"><strong>${escapeHtml(i.customer_name)}</strong><span class="wish-item-qty">× ${i.quantity}</span></span>
      <span class="muted">${formatDateDMY(i.created_at)} · ${escapeHtml(i.source === "kados" ? t("wish_from_kados") : i.by || "")}${
        i.back_in_stock_at ? ` · ${t("wish_back_on").replace("{date}", formatDateDMY(i.back_in_stock_at))}` : ""
      }</span>
      ${i.note ? `<span class="muted wish-item-note">${escapeHtml(i.note)}</span>` : ""}
    </li>`;

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const { rows } = await api.getProductWishesReport({ period: new FormData(form).get("period") });
      const people = rows.reduce((n, r) => n + r.customers, 0);
      body.innerHTML = rows.length
        ? `<p class="muted wish-report-summary">${t("wish_report_summary").replace("{n}", String(rows.length)).replace("{c}", String(people))}</p>
          <div class="card-list wish-report-list">
            ${rows
              .map(
                (r) => `
              <details class="card wish-report-row">
                <summary>
                  <span class="wish-report-name">
                    <strong>${escapeHtml(r.name)}</strong>
                    <span class="muted">${[r.brand, r.unit].filter(Boolean).map(escapeHtml).join(" · ")}${
                      r.new_product ? `<span class="badge badge-accent">${t("wish_new_product")}</span>` : r.in_stock_now ? `<span class="badge badge-success">${t("wish_in_stock_now")}</span>` : `<span class="badge badge-danger">${t("out_of_stock")}</span>`
                    }</span>
                  </span>
                  <span class="wish-report-nums">
                    <strong>${t("wish_customers_n").replace("{n}", String(r.customers))}</strong>
                    <span class="muted">${t("wish_qty_n").replace("{n}", String(r.quantity))}</span>
                  </span>
                </summary>
                <ul class="wish-items">${r.items.map(itemHtml).join("")}</ul>
              </details>`
              )
              .join("")}
          </div>`
        : `<p class="empty-state">${t("wish_report_empty")}</p>`;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener("change", load);
  await load();
}
