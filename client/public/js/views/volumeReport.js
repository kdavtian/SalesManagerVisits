// Reports > Products & liters: what was sold -- liters, AMD, orders, customers -- for any period, product,
// channel and place, with comparison, breakdowns, an "all periods at a glance" table and a trend.
// One screen answers: "how many liters of Castrol this month / last year / YTD", "Magnatec 5W-30 C3 in Yerevan
// Ajapnyak", "Royal 0W-8 sold by SM YVN or CVO" ... (server/src/volumeReport.js).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, openInfoPopup, formatAmd, channelDisplayLabel, regionLabelHy, subregionLabelHy, syncBadgeHtml, saveBlob, formatDateDMY } from "../util.js";
import { icons } from "../icons.js";
import { openTriStateTreeSheet, buildRegionSubregionTree } from "../regionTree.js";

const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "ytd", "last_year", "last_12m"];
const GROUPS = ["product", "family", "brand", "grade", "size", "channel", "region", "subregion", "customer", "month", "week", "day"];
// Which filter a tapped breakdown row narrows to (rows of the other groups just show numbers).
const DRILL = { product: "products", family: "families", brand: "brands", grade: "grades", size: "sizes", channel: "channels", subregion: "region_sub" };
const DRILL_STATE = { product: "products", family: "families", brand: "brands", grade: "grades", size: "sizes", channel: "channels", subregion: "regionKeys" };

const fmtL = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString();
  return `${s} ${t("vol_unit_l")}`;
};
const pctChange = (now, before) => (before ? ((now - before) / Math.abs(before)) * 100 : null);
function deltaHtml(now, before, { compact = false } = {}) {
  if (before === null || before === undefined) return "";
  const pct = pctChange(now, before);
  if (pct === null) return now ? `<span class="vol-delta vol-delta-up">${t("vol_new")}</span>` : "";
  if (Math.round(pct * 10) === 0) return `<span class="vol-delta vol-delta-flat">0%</span>`;
  const up = pct >= 0;
  const text = `${up ? "▲" : "▼"} ${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : (Math.round(Math.abs(pct) * 10) / 10)}%`;
  return `<span class="vol-delta ${up ? "vol-delta-up" : "vol-delta-down"}">${text}${compact ? "" : ""}</span>`;
}
const dateCaption = (s) => formatDateDMY(s);

export async function renderVolumeReport(root, navigate) {
  const state = {
    period: "this_month",
    from: "",
    to: "",
    compare: "prev",
    groupBy: "product",
    brands: new Set(),
    families: new Set(),
    grades: new Set(),
    sizes: new Set(),
    products: new Set(),
    channels: new Set(),
    regionKeys: new Set(),
    q: "",
    cq: "",
    showCustomer: false,
  };
  let data = null;
  let facets = null;
  let loadSeq = 0;
  let searchTimer;

  root.innerHTML = `
    <div class="detail-view vol-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title">
          <div class="sales-heading-with-hint"><h1>${t("report_product_liters_name")}</h1><button type="button" class="settings-hint-icon" id="vol-info-btn" aria-label="${t("more_info")}">!</button></div>
        </div>
        <button type="button" class="icon-btn" id="vol-export-btn" aria-label="${t("export_excel")}">${icons.send}</button>
      </div>
      <div class="vol-chips" id="vol-periods" role="group" aria-label="${escapeHtml(t("vol_period"))}"></div>
      <div class="pill-date-filter-row" id="vol-custom-row" hidden>
        <div class="pill-date-filter-wrap">
          <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true"><span class="pill-date-filter-caption">${t("date_from")}</span><span class="pill-date-filter-value" id="vol-from-value"></span></button>
          <input type="date" class="pill-date-picker-input" id="vol-from" aria-label="${t("date_from")}" />
        </div>
        <div class="pill-date-filter-wrap">
          <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true"><span class="pill-date-filter-caption">${t("date_to")}</span><span class="pill-date-filter-value" id="vol-to-value"></span></button>
          <input type="date" class="pill-date-picker-input" id="vol-to" aria-label="${t("date_to")}" />
        </div>
      </div>
      <div class="vol-chips vol-chips-small" id="vol-compare" role="group" aria-label="${escapeHtml(t("vol_compare"))}"></div>
      <div class="list-toolbar">
        <label class="visually-hidden" for="vol-search">${t("vol_search_ph")}</label>
        <input type="search" id="vol-search" placeholder="${t("vol_search_ph")}" aria-label="${t("vol_search_ph")}" autocomplete="off" />
      </div>
      <div class="vol-chips" id="vol-filters"></div>
      <div class="list-toolbar" id="vol-customer-row" hidden>
        <input type="search" id="vol-customer" placeholder="${t("vol_customer_ph")}" aria-label="${t("vol_customer_ph")}" autocomplete="off" />
      </div>
      <div class="vol-active" id="vol-active"></div>
      <p class="form-error" id="vol-error" hidden></p>
      <div id="vol-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const $ = (sel) => root.querySelector(sel);
  $("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));

  // ---- chips ---------------------------------------------------------------------------------------------------------
  function renderPeriodChips() {
    $("#vol-periods").innerHTML = [...PERIODS, "custom"]
      .map((k) => `<button type="button" class="map-filter-chip ${state.period === k ? "chip-active" : ""}" data-period="${k}" aria-pressed="${state.period === k}">${t(`vol_p_${k}`)}</button>`)
      .join("");
    $("#vol-custom-row").hidden = state.period !== "custom";
    $("#vol-periods").querySelectorAll("[data-period]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.period;
        if (k === "custom") {
          state.from = state.from || data?.from || "";
          state.to = state.to || data?.to || "";
        }
        state.period = k;
        renderPeriodChips();
        load();
      })
    );
  }
  function renderCompareChips() {
    $("#vol-compare").innerHTML = ["prev", "yoy", "none"]
      .map((k) => `<button type="button" class="map-filter-chip ${state.compare === k ? "chip-active" : ""}" data-compare="${k}" aria-pressed="${state.compare === k}">${t(`vol_cmp_${k}`)}</button>`)
      .join("");
    $("#vol-compare").querySelectorAll("[data-compare]").forEach((b) =>
      b.addEventListener("click", () => {
        state.compare = b.dataset.compare;
        renderCompareChips();
        load();
      })
    );
  }
  const FILTER_CHIPS = [
    ["products", "vol_f_products"],
    ["grades", "vol_f_grade"],
    ["sizes", "vol_f_size"],
    ["channels", "vol_f_channel"],
    ["regionKeys", "vol_f_region"],
  ];
  const activeCount = () => FILTER_CHIPS.reduce((n, [k]) => n + state[k].size, 0) + (state.cq ? 1 : 0) + state.brands.size + state.families.size;
  function renderFilterChips() {
    const chips = FILTER_CHIPS.map(([k, label]) => {
      const n = k === "products" ? state.products.size + state.brands.size + state.families.size : state[k].size;
      return `<button type="button" class="map-filter-chip ${n ? "chip-active" : ""}" data-filter="${k}">${t(label)}${n ? ` (${n})` : ""}</button>`;
    });
    chips.push(`<button type="button" class="map-filter-chip ${state.cq ? "chip-active" : ""}" data-filter="customer">${t("vol_f_customer")}${state.cq ? " (1)" : ""}</button>`);
    if (activeCount() || state.q) chips.push(`<button type="button" class="map-filter-chip vol-clear" data-filter="clear">${t("vol_f_clear")}</button>`);
    $("#vol-filters").innerHTML = chips.join("");
    $("#vol-filters").querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => openFilter(b.dataset.filter)));
    renderActive();
  }
  // What is filtered right now, each removable with one tap.
  function renderActive() {
    const items = [];
    const label = {
      brands: (v) => v,
      families: (v) => v,
      grades: (v) => v,
      sizes: (v) => `${v} ${t("vol_unit_l")}`,
      channels: (v) => channelDisplayLabel(v),
      products: (v) => facets?.product.find((p) => p.key === v)?.label || v,
      regionKeys: (v) => {
        const [r, s] = v.split("::");
        return s && s !== "__none__" ? `${regionLabelHy(r)} › ${subregionLabelHy(s)}` : regionLabelHy(r);
      },
    };
    for (const k of ["brands", "families", "products", "grades", "sizes", "channels", "regionKeys"]) {
      for (const v of state[k]) items.push(`<button type="button" class="vol-active-chip" data-remove="${k}" data-value="${escapeHtml(v)}">${escapeHtml(label[k](v))} <span aria-hidden="true">×</span></button>`);
    }
    if (state.cq) items.push(`<button type="button" class="vol-active-chip" data-remove="cq">${escapeHtml(state.cq)} <span aria-hidden="true">×</span></button>`);
    $("#vol-active").innerHTML = items.join("");
    $("#vol-active").querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.remove === "cq") {
          state.cq = "";
          $("#vol-customer").value = "";
        } else state[b.dataset.remove].delete(b.dataset.value);
        renderFilterChips();
        load();
      })
    );
  }

  // ---- filter sheets -------------------------------------------------------------------------------------------------
  const flatTree = (title, items) => [
    { key: "all", name: title, allIds: items.map((i) => i.key), customerCount: items.length, leaves: items.map((i) => ({ id: i.key, name: i.label })), children: null },
  ];
  function openFlat(stateKey, titleKey, items, labelFn = (i) => i.label) {
    openTriStateTreeSheet(t(titleKey), {
      tree: flatTree(t(titleKey), items.map((i) => ({ key: i.key, label: `${labelFn(i)} · ${fmtL(i.liters)}` }))),
      initialSelectedIds: state[stateKey],
      countUnitLabel: "",
      onApply: (selected) => {
        state[stateKey] = new Set([...selected].map(String));
        renderFilterChips();
        load();
      },
    });
  }
  function openFilter(kind) {
    if (!facets) return;
    if (kind === "clear") {
      for (const [k] of FILTER_CHIPS) state[k] = new Set();
      state.brands = new Set();
      state.families = new Set();
      state.q = "";
      state.cq = "";
      $("#vol-search").value = "";
      $("#vol-customer").value = "";
      renderFilterChips();
      load();
    } else if (kind === "customer") {
      state.showCustomer = !state.showCustomer;
      $("#vol-customer-row").hidden = !state.showCustomer;
      if (state.showCustomer) $("#vol-customer").focus();
    } else if (kind === "products") {
      // Brand -> product line -> product, tri-state: ticking a brand ticks all its products.
      const byBrand = new Map();
      for (const p of facets.product) {
        const [brand, family] = String(p.parent || "—|—").split("|");
        if (!byBrand.has(brand)) byBrand.set(brand, new Map());
        const fam = byBrand.get(brand);
        if (!fam.has(family)) fam.set(family, []);
        fam.get(family).push(p);
      }
      const tree = [...byBrand.entries()].map(([brand, fams], i) => {
        const allIds = [...fams.values()].flat().map((p) => p.key);
        return {
          key: `b${i}`,
          name: brand,
          allIds,
          customerCount: allIds.length,
          leaves: null,
          children: [...fams.entries()].map(([family, list], j) => ({
            key: `b${i}-f${j}`,
            name: family,
            allIds: list.map((p) => p.key),
            customerCount: list.length,
            leaves: list.map((p) => ({ id: p.key, name: `${p.label} · ${fmtL(p.liters)}` })),
            children: null,
          })),
        };
      });
      openTriStateTreeSheet(t("vol_f_products"), {
        tree,
        initialSelectedIds: state.products,
        countUnitLabel: t("vol_f_products").toLowerCase(),
        searchPlaceholder: t("vol_search_ph"),
        onApply: (selected) => {
          state.products = new Set([...selected].map(String));
          state.brands = new Set();
          state.families = new Set();
          renderFilterChips();
          load();
        },
      });
    } else if (kind === "grades") openFlat("grades", "vol_f_grade", facets.grade);
    else if (kind === "sizes") openFlat("sizes", "vol_f_size", facets.size);
    else if (kind === "channels") openFlat("channels", "vol_f_channel", facets.channel, (i) => channelDisplayLabel(i.label));
    else if (kind === "regionKeys") {
      // The count next to each region / district is its liters (last two years), not a number of customers.
      const litersByKey = new Map(facets.region.map((r) => [r.key, r.liters]));
      const tree = buildRegionSubregionTree(facets.region.map((r) => ({ region: r.label, subregion: r.parent || null })));
      const setLiters = (node) => {
        node.customerCount = Math.round((node.allIds || []).reduce((s, id) => s + (litersByKey.get(String(id)) || 0), 0));
        (node.children || []).forEach(setLiters);
      };
      tree.forEach(setLiters);
      openTriStateTreeSheet(t("vol_f_region"), {
        tree,
        initialSelectedIds: state.regionKeys,
        countUnitLabel: t("vol_unit_l"),
        onApply: (selected) => {
          state.regionKeys = new Set([...selected].map(String));
          renderFilterChips();
          load();
        },
      });
    }
  }

  // ---- request -------------------------------------------------------------------------------------------------------
  function params() {
    const p = { period: state.period, compare: state.compare, group_by: state.groupBy };
    if (state.period === "custom" && state.from && state.to) {
      p.from = state.from;
      p.to = state.to;
    }
    for (const [key, set] of [["brands", state.brands], ["families", state.families], ["grades", state.grades], ["sizes", state.sizes], ["products", state.products], ["channels", state.channels], ["region_sub", state.regionKeys]]) {
      if (set.size) p[key] = [...set].join(",");
    }
    if (state.q) p.q = state.q;
    if (state.cq) p.cq = state.cq;
    return p;
  }

  async function load() {
    const mine = ++loadSeq;
    const body = $("#vol-body");
    body.classList.add("vol-loading");
    $("#vol-error").hidden = true;
    try {
      const res = await api.getVolumeReport(params());
      if (mine !== loadSeq) return;
      data = res;
      facets = res.facets;
      // The server resolves "this month" etc. in the Yerevan calendar; show the real dates in the custom pills.
      $("#vol-from").value = res.from;
      $("#vol-to").value = res.to;
      $("#vol-from-value").textContent = dateCaption(res.from);
      $("#vol-to-value").textContent = dateCaption(res.to);
      body.classList.remove("vol-loading");
      renderBody();
      renderActive();
    } catch (err) {
      if (mine !== loadSeq) return;
      body.classList.remove("vol-loading");
      $("#vol-error").textContent = err.message;
      $("#vol-error").hidden = false;
      body.innerHTML = "";
    }
  }

  // ---- body ----------------------------------------------------------------------------------------------------------
  const periodRange = (p) => (p.from === p.to ? dateCaption(p.from) : `${dateCaption(p.from)} – ${dateCaption(p.to)}`);
  function kpiHtml() {
    const tt = data.totals;
    const pt = data.prev_totals;
    const margin = data.with_costs && tt.revenue_costed ? ((tt.revenue_costed - tt.cost) / tt.revenue_costed) * 100 : null;
    const pm = data.with_costs && pt && pt.revenue_costed ? ((pt.revenue_costed - pt.cost) / pt.revenue_costed) * 100 : null;
    const tile = (label, value, delta = "", extra = "") => `<div class="vol-kpi ${extra}"><span class="vol-kpi-label">${label}</span><strong class="vol-kpi-value">${value}</strong>${delta}</div>`;
    const prevLine = pt ? `<span class="muted vol-kpi-prev">${t("vol_vs")} ${fmtL(pt.liters)} · ${periodRange(data.prev)}</span>` : "";
    return `
      <div class="vol-kpis">
        <div class="vol-kpi vol-kpi-main">
          <span class="vol-kpi-label">${t("vol_k_liters")} · ${periodRange(data)}</span>
          <strong class="vol-kpi-value">${fmtL(tt.liters)} ${pt ? deltaHtml(tt.liters, pt.liters) : ""}</strong>
          ${prevLine}
          ${tt.all_liters && Math.abs(tt.all_liters - tt.liters) > 0.5 ? `<span class="muted vol-kpi-prev">${t("vol_share_of_all").replace("{p}", ((tt.liters / tt.all_liters) * 100).toFixed(1)).replace("{l}", fmtL(tt.all_liters))}</span>` : ""}
        </div>
        ${tile(t("vol_k_sales"), formatAmd(tt.revenue), pt ? deltaHtml(tt.revenue, pt.revenue) : "")}
        ${tile(t("vol_k_price"), tt.liters ? formatAmd(tt.avg_price_per_liter) : "—", pt && pt.liters ? deltaHtml(tt.avg_price_per_liter, pt.revenue / pt.liters) : "")}
        ${tile(t("vol_k_orders"), String(tt.orders), pt ? deltaHtml(tt.orders, pt.orders) : "")}
        ${tile(t("vol_k_customers"), String(tt.customers), pt ? deltaHtml(tt.customers, pt.customers) : "")}
        ${margin !== null ? tile(t("vol_k_margin"), `${margin.toFixed(1)}%`, pm !== null ? `<span class="vol-delta ${margin >= pm ? "vol-delta-up" : "vol-delta-down"}">${margin >= pm ? "▲" : "▼"} ${Math.abs(margin - pm).toFixed(1)} ${t("vol_pp")}</span>` : "") : ""}
      </div>
      ${data.pending.liters || data.pending.orders ? `<p class="vol-pending">${t("vol_pending").replace("{l}", fmtL(data.pending.liters)).replace("{n}", String(data.pending.orders))}</p>` : ""}`;
  }

  function groupChipsHtml() {
    return `<div class="vol-chips" id="vol-groups" role="group" aria-label="${escapeHtml(t("vol_group"))}">${GROUPS.map(
      (k) => `<button type="button" class="map-filter-chip ${state.groupBy === k ? "chip-active" : ""}" data-group="${k}" aria-pressed="${state.groupBy === k}">${t(`vol_g_${k}`)}</button>`
    ).join("")}</div>`;
  }

  function rowLabel(r) {
    if (state.groupBy === "channel") return channelDisplayLabel(r.label);
    if (state.groupBy === "region") return r.label === "—" ? "—" : regionLabelHy(r.label);
    if (state.groupBy === "subregion") return r.label === "—" ? "—" : subregionLabelHy(r.label);
    if (state.groupBy === "size") return r.label;
    if (["day", "week"].includes(state.groupBy)) return dateCaption(r.label);
    return r.label;
  }
  function rowsHtml() {
    if (!data.rows.length) return `<p class="empty-state">${t("vol_empty")}</p>`;
    const timeGroup = ["month", "week", "day"].includes(state.groupBy);
    const total = data.totals.liters || data.rows.reduce((s, r) => s + r.liters, 0);
    const max = Math.max(...data.rows.map((r) => Math.abs(r.liters)), 1);
    const drill = DRILL[state.groupBy];
    return `<div class="card-list">${data.rows
      .map((r) => {
        const share = total ? (r.liters / total) * 100 : 0;
        const price = r.liters ? formatAmd(r.revenue / r.liters) : "—";
        const sub = [r.sub && state.groupBy === "product" ? r.sub : state.groupBy === "customer" || state.groupBy === "subregion" ? (r.sub ? regionLabelHy(r.sub) : "") : "", formatAmd(r.revenue), `${price}/${t("vol_unit_l")}`, `${r.orders} ${t("vol_k_orders").toLowerCase()}`]
          .filter(Boolean)
          .map(escapeHtml)
          .join(" · ");
        return `<${drill ? 'button type="button"' : "div"} class="card vol-row ${drill ? "vol-row-tap" : ""}" ${drill ? `data-drill="${escapeHtml(r.key)}"` : ""}>
          <span class="vol-row-top"><strong class="vol-row-label">${escapeHtml(rowLabel(r))}</strong><span class="vol-row-liters">${fmtL(r.liters)}</span></span>
          <span class="vol-row-sub"><span class="muted">${sub}</span>${r.prev_liters !== null ? deltaHtml(r.liters, r.prev_liters) : ""}</span>
          <span class="vol-bar" aria-hidden="true"><span style="width:${Math.max(1, (Math.abs(r.liters) / max) * 100).toFixed(1)}%"></span></span>
          ${timeGroup ? "" : `<span class="vol-share muted">${share.toFixed(share >= 10 ? 0 : 1)}%</span>`}
        </${drill ? "button" : "div"}>`;
      })
      .join("")}</div>${data.truncated ? `<p class="muted">${t("vol_truncated").replace("{n}", String(data.rows.length))}</p>` : ""}${drill ? `<p class="muted vol-hint">${t("vol_tap_hint")}</p>` : ""}`;
  }

  function periodsHtml() {
    return `<div class="card vol-periods">
      <h3 class="health-title">${t("vol_periods_title")}</h3>
      ${data.periods
        .map(
          (p) => `<div class="vol-period-row">
            <span class="vol-period-name"><strong>${t(`vol_p_${p.key}`)}</strong><span class="muted">${escapeHtml(periodRange(p))}</span></span>
            <span class="vol-period-vals"><strong>${fmtL(p.liters)}</strong>${deltaHtml(p.liters, p.prev_liters)}<span class="muted">${formatAmd(p.revenue)}</span></span>
          </div>`
        )
        .join("")}
    </div>`;
  }

  function trendHtml() {
    const rows = data.trend.rows;
    if (rows.length < 2) return "";
    const max = Math.max(...rows.map((r) => r.liters), 1);
    const labelOf = (k) => (data.trend.bucket === "month" ? k : dateCaption(k));
    return `<div class="card vol-trend">
      <h3 class="health-title">${t("vol_trend_title")} · ${t(`vol_g_${data.trend.bucket}`)}</h3>
      <div class="vol-trend-bars" role="img" aria-label="${escapeHtml(t("vol_trend_title"))}">${rows
        .map((r) => `<span class="vol-trend-col" title="${escapeHtml(`${labelOf(r.key)}: ${fmtL(r.liters)}`)}"><span style="height:${Math.max(2, (r.liters / max) * 100).toFixed(1)}%"></span></span>`)
        .join("")}</div>
      <div class="vol-trend-axis muted"><span>${escapeHtml(labelOf(rows[0].key))}</span><span>${escapeHtml(labelOf(rows[rows.length - 1].key))}</span></div>
    </div>`;
  }

  function renderBody() {
    const body = $("#vol-body");
    body.innerHTML = `
      ${kpiHtml()}
      <div class="sales-subtotal-row"><p class="sales-subtotal-bar muted">${data.sync ? "" : ""}</p></div>
      ${groupChipsHtml()}
      <div id="vol-rows">${rowsHtml()}</div>
      ${periodsHtml()}
      ${trendHtml()}
      <div class="vol-sync">${data.sync ? syncBadgeHtml(data.sync) : ""}${data.last_erp_order_date ? `<p class="muted">${t("vol_last_order").replace("{d}", escapeHtml(dateCaption(data.last_erp_order_date)))}</p>` : ""}</div>`;
    body.querySelectorAll("[data-group]").forEach((b) =>
      b.addEventListener("click", () => {
        state.groupBy = b.dataset.group;
        load();
      })
    );
    body.querySelectorAll("[data-drill]").forEach((row) =>
      row.addEventListener("click", () => {
        const set = state[DRILL_STATE[state.groupBy]];
        const key = row.dataset.drill;
        if (key === "—") return;
        set.add(key);
        renderFilterChips();
        load();
      })
    );
  }

  // ---- inputs --------------------------------------------------------------------------------------------------------
  for (const [id, key] of [["#vol-from", "from"], ["#vol-to", "to"]]) {
    $(id).addEventListener("change", (e) => {
      if (!e.target.value) return;
      state[key] = e.target.value;
      state.period = "custom";
      $(`${id}-value`).textContent = dateCaption(e.target.value);
      renderPeriodChips();
      load();
    });
  }
  $("#vol-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      renderFilterChips();
      load();
    }, 350);
  });
  $("#vol-customer").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.cq = e.target.value.trim();
      renderFilterChips();
      load();
    }, 350);
  });
  $("#vol-info-btn").addEventListener("click", () => openInfoPopup(`<p>${t("vol_info_1")}</p><p>${t("vol_info_2")}</p><p>${t("vol_info_3")}</p>`));
  $("#vol-export-btn").addEventListener("click", async (e) => {
    if (!data) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const costs = data.with_costs;
      const columns = [
        { header: t(`vol_g_${state.groupBy}`), width: 34 },
        { header: t("vol_k_liters"), type: "number", width: 12 },
        { header: t("vol_k_sales"), type: "number", width: 14 },
        { header: t("vol_k_price"), type: "number", width: 14 },
        { header: t("vol_k_orders"), type: "number", width: 10 },
        { header: t("vol_k_customers"), type: "number", width: 12 },
        ...(data.prev ? [{ header: `${t("vol_k_liters")} (${t("vol_cmp_" + data.compare)})`, type: "number", width: 16 }] : []),
        ...(costs ? [{ header: t("vol_k_margin"), type: "number", width: 12 }] : []),
      ];
      const rows = data.rows.map((r) => [
        rowLabel(r),
        r.liters,
        Math.round(r.revenue),
        r.liters ? Math.round(r.revenue / r.liters) : 0,
        r.orders,
        r.customers,
        ...(data.prev ? [r.prev_liters ?? 0] : []),
        ...(costs ? [r.revenue_costed ? Math.round(((r.revenue_costed - r.cost) / r.revenue_costed) * 1000) / 10 : ""] : []),
      ]);
      const filename = `liters-${data.from}_${data.to}`;
      const blob = await api.buildXlsx({ filename, sheet: t("report_product_liters_name"), columns, rows });
      await saveBlob(blob, `${filename}.xlsx`);
    } catch (err) {
      $("#vol-error").textContent = err.message;
      $("#vol-error").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  renderPeriodChips();
  renderCompareChips();
  renderFilterChips();
  load();
}
