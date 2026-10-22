// Reports > Products & liters: what was sold in LITERS (no money -- a separate amounts report is planned) for any
// period, product, channel and place, with comparison, breakdowns, an "all periods at a glance" table and charts
// (trend vs the comparison period, month by month this year vs last, share of the breakdown).
// One screen answers: "how many liters of Castrol this month / last year / YTD", "Magnatec 5W-30 C3 in Yerevan
// Ajapnyak", "Royal 0W-8 sold by SM YVN or CVO" ... (server/src/volumeReport.js).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, openInfoPopup, channelDisplayLabel, regionLabelHy, subregionLabelHy, syncBadgeHtml, saveBlob, formatDateDMY } from "../util.js";
import { icons } from "../icons.js";
import { openTriStateTreeSheet, buildRegionSubregionTree } from "../regionTree.js";
import { periodLabel, periodAria } from "../periodButtons.js";

// Buttons: each of the five flips between the period and the previous one when the selected button is tapped again
// (periodButtons.js); Last 12 months and the custom range stand alone. [button base, period now, period previous]
const PERIOD_BUTTONS = [["today", "today", "yesterday"], ["week", "this_week", "last_week"], ["month", "this_month", "last_month"], ["quarter", "this_quarter", "last_quarter"], ["year", "ytd", "last_year"]];
// Break-down chips, grouped so twelve options are never one long hidden scroll row.
const GROUP_CATS = [
  ["product", ["product", "family", "brand", "grade", "size"]],
  ["where", ["channel", "region", "subregion", "customer"]],
  ["time", ["month", "week", "day"]],
];
const catOf = (g) => GROUP_CATS.find(([, list]) => list.includes(g))[0];
const TOP_ROWS = 10;
// Which filter a tapped breakdown row narrows to (rows of the other groups just show numbers).
const DRILL = { product: "products", family: "families", brand: "brands", grade: "grades", size: "sizes", channel: "channels", subregion: "region_sub" };
const DRILL_STATE = { product: "products", family: "families", brand: "brands", grade: "grades", size: "sizes", channel: "channels", subregion: "regionKeys" };

const fmtL = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : (Math.round(v * 10) / 10).toLocaleString();
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
const shortDay = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const addDaysStr = (s, n) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)).toISOString().slice(0, 10);
const monthName = (m) => t(`vol_mon_${m}`); // 1..12
// Axis numbers: 1.2k, 15k, 820
const axisNum = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(Math.round(v / 100) / 10).toString()}k` : String(Math.round(v)));
function niceScale(max) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  return { step, top: Math.ceil(max / step) * step };
}

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
    showAll: false,
  };
  let data = null;
  let facets = null;
  let loadSeq = 0;
  let searchTimer;
  let resizeTimer;

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
    const chip = (attrs, active, label, aria = "") =>
      `<button type="button" class="map-filter-chip ${active ? "chip-active" : ""} ${active && attrs.prev ? "period-prev" : ""}" data-period="${attrs.key}" aria-pressed="${active}"${aria ? ` aria-label="${escapeHtml(aria)}" title="${escapeHtml(aria)}"` : ""}>${label}</button>`;
    $("#vol-periods").innerHTML = [
      ...PERIOD_BUTTONS.map(([base, now, prev]) => {
        const active = state.period === now || state.period === prev;
        const isPrev = state.period === prev;
        return chip({ key: active ? state.period : now, prev: isPrev }, active, periodLabel(base, isPrev), active ? periodAria(base, isPrev) : "");
      }),
      chip({ key: "last_12m" }, state.period === "last_12m", t("vol_p_last_12m")),
      chip({ key: "custom" }, state.period === "custom", icons.calendar, t("vol_p_custom")),
    ].join("");
    $("#vol-custom-row").hidden = state.period !== "custom";
    $("#vol-periods").querySelectorAll("[data-period]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.period;
        if (k === "custom") {
          state.from = state.from || data?.from || "";
          state.to = state.to || data?.to || "";
        }
        const pair = PERIOD_BUTTONS.find(([, now, prev]) => k === now || k === prev);
        // the selected button flips between its period and the previous one
        state.period = pair && (k === state.period) ? (k === pair[1] ? pair[2] : pair[1]) : k;
        renderPeriodChips();
        $("#vol-periods").querySelector(".chip-active")?.scrollIntoView({ inline: "center", block: "nearest" });
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
    state.showAll = false;
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
  const fmtSigned = (n) => `${n >= 0 ? "+" : "−"}${fmtL(Math.abs(n))}`;

  // The headline answer: liters for the chosen period, the change, and three small facts.
  function heroHtml() {
    const tt = data.totals;
    const pt = data.prev_totals;
    const perOrder = tt.orders ? tt.liters / tt.orders : 0;
    const stat = (value, label) => `<span class="vol-stat"><strong>${value}</strong><span class="muted">${label}</span></span>`;
    const prevLine = pt ? `<span class="muted vol-hero-prev">${t("vol_vs")} ${fmtL(pt.liters)} (${fmtSigned(tt.liters - pt.liters)}) · ${periodRange(data.prev)}</span>` : "";
    const share = tt.all_liters && Math.abs(tt.all_liters - tt.liters) > 0.5 ? `<span class="muted vol-hero-prev">${t("vol_share_of_all").replace("{p}", ((tt.liters / tt.all_liters) * 100).toFixed(1)).replace("{l}", fmtL(tt.all_liters))}</span>` : "";
    return `
      <div class="vol-hero">
        <span class="vol-hero-label">${t(`vol_p_${data.period}`)} · ${periodRange(data)}</span>
        <strong class="vol-hero-num">${fmtL(tt.liters)} ${pt ? deltaHtml(tt.liters, pt.liters) : ""}</strong>
        ${prevLine}${share}
        <div class="vol-stats">${stat(String(tt.orders), t("vol_k_orders"))}${stat(String(tt.customers), t("vol_k_customers"))}${stat(tt.orders ? fmtL(perOrder) : "—", t("vol_k_per_order"))}</div>
      </div>
      ${data.pending.liters || data.pending.orders ? `<p class="vol-pending">${t("vol_pending").replace("{l}", fmtL(data.pending.liters)).replace("{n}", String(data.pending.orders))}</p>` : ""}`;
  }

  function groupChipsHtml() {
    const cat = catOf(state.groupBy);
    const list = GROUP_CATS.find(([k]) => k === cat)[1];
    return `<div class="vol-group" role="group" aria-label="${escapeHtml(t("vol_group"))}">
      <div class="vol-seg">${GROUP_CATS.map(([k]) => `<button type="button" class="${k === cat ? "seg-active" : ""}" data-cat="${k}" aria-pressed="${k === cat}">${t(`vol_gc_${k}`)}</button>`).join("")}</div>
      <div class="vol-chips vol-chips-small">${list.map((k) => `<button type="button" class="map-filter-chip ${state.groupBy === k ? "chip-active" : ""}" data-group="${k}" aria-pressed="${state.groupBy === k}">${t(`vol_g_${k}`)}</button>`).join("")}</div>
    </div>`;
  }

  function rowLabel(r) {
    if (state.groupBy === "channel") return channelDisplayLabel(r.label);
    if (state.groupBy === "region") return r.label === "—" ? "—" : regionLabelHy(r.label);
    if (state.groupBy === "subregion") return r.label === "—" ? "—" : subregionLabelHy(r.label);
    if (state.groupBy === "size") return r.label;
    if (["day", "week"].includes(state.groupBy)) return dateCaption(r.label);
    return r.label;
  }
  const isTimeGroup = () => ["month", "week", "day"].includes(state.groupBy);
  function rowsHtml() {
    if (!data.rows.length) return `<p class="empty-state">${t("vol_empty")}</p>`;
    const timeGroup = isTimeGroup();
    const total = data.totals.liters || data.rows.reduce((s, r) => s + r.liters, 0);
    const max = Math.max(...data.rows.map((r) => Math.abs(r.liters)), 1);
    const drill = DRILL[state.groupBy];
    const limited = !timeGroup && !state.showAll && data.rows.length > TOP_ROWS;
    const shown = limited ? data.rows.slice(0, TOP_ROWS) : data.rows;
    return `<div class="card-list">${shown
      .map((r) => {
        const share = total ? (r.liters / total) * 100 : 0;
        const where = state.groupBy === "customer" || state.groupBy === "subregion" ? (r.sub ? regionLabelHy(r.sub) : "") : state.groupBy === "product" ? r.sub || "" : "";
        const sub = [where, `${r.orders} ${t("vol_k_orders").toLowerCase()}`, state.groupBy === "customer" ? "" : `${r.customers} ${t("vol_k_customers").toLowerCase()}`]
          .filter(Boolean)
          .map(escapeHtml)
          .join(" · ");
        return `<${drill ? 'button type="button"' : "div"} class="card vol-row ${drill ? "vol-row-tap" : ""}" ${drill ? `data-drill="${escapeHtml(r.key)}"` : ""}>
          <span class="vol-row-top"><strong class="vol-row-label">${escapeHtml(rowLabel(r))}</strong><span class="vol-row-liters">${fmtL(r.liters)}</span></span>
          <span class="vol-row-sub"><span class="muted">${sub}</span>${r.prev_liters !== null ? deltaHtml(r.liters, r.prev_liters) : ""}</span>
          <span class="vol-bar-row"><span class="vol-bar" aria-hidden="true"><span style="width:${Math.max(1, (Math.abs(r.liters) / max) * 100).toFixed(1)}%"></span></span>${timeGroup ? "" : `<span class="vol-share muted">${share.toFixed(share >= 10 ? 0 : 1)}%</span>`}</span>
        </${drill ? "button" : "div"}>`;
      })
      .join("")}</div>${limited ? `<button type="button" class="vol-more" id="vol-more">${t("vol_show_all").replace("{n}", String(data.rows.length))}</button>` : state.showAll && !timeGroup && data.rows.length > TOP_ROWS ? `<button type="button" class="vol-more" id="vol-more">${t("vol_show_less")}</button>` : ""}${data.truncated ? `<p class="muted">${t("vol_truncated").replace("{n}", String(data.rows.length))}</p>` : ""}${drill ? `<p class="muted vol-hint">${t("vol_tap_hint")}</p>` : ""}`;
  }

  function periodsHtml() {
    return `<div class="card vol-periods">
      <h3 class="health-title">${t("vol_periods_title")}</h3>
      ${data.periods
        .map(
          (p) => `<div class="vol-period-row">
            <span class="vol-period-name"><strong>${t(`vol_p_${p.key}`)}</strong><span class="muted">${escapeHtml(periodRange(p))}</span></span>
            <span class="vol-period-vals"><strong>${fmtL(p.liters)}</strong>${deltaHtml(p.liters, p.prev_liters)}</span>
          </div>`
        )
        .join("")}
    </div>`;
  }

  // ---- charts (inline SVG, drawn to the real width; colors are the --vz-* tokens in styles.css) ------------------------
  const MIX_SLOTS = 5;
  const legendItem = (cls, text) => `<span class="vol-legend-item"><i class="${cls}"></i>${text}</span>`;
  function chartsHtml() {
    const hasTrend = data.trend.rows.length >= 2;
    const mix = !isTimeGroup() && data.rows.length >= 2;
    if (!hasTrend && !mix && !data.monthly.rows.some((r) => r.liters)) return "";
    const prev = data.trend.prev_rows;
    return `<h2 class="vol-charts-title">${t("vol_charts_title")}</h2>
      ${hasTrend ? `<div class="card vol-chart" id="vol-chart-trend">
        <h3 class="health-title">${t("vol_chart_trend")} · ${t(`vol_g_${data.trend.bucket}`).toLowerCase()}</h3>
        <div class="vol-legend">${legendItem("vz-b1", `${t(`vol_p_${data.period}`)}`)}${prev ? legendItem("vz-l2", `${t("vol_legend_prev")}`) : ""}</div>
        <p class="vol-readout muted" aria-live="polite">${t("vol_chart_hint")}</p>
        <div class="vol-chart-box" role="img" aria-label="${escapeHtml(t("vol_chart_trend"))}"></div>
      </div>` : ""}
      <div class="card vol-chart" id="vol-chart-monthly">
        <h3 class="health-title">${t("vol_chart_monthly")}</h3>
        <div class="vol-legend">${legendItem("vz-l1", String(data.monthly.year))}${legendItem("vz-l2", String(data.monthly.year - 1))}</div>
        <p class="vol-readout muted" aria-live="polite">${t("vol_chart_hint")}</p>
        <div class="vol-chart-box" role="img" aria-label="${escapeHtml(t("vol_chart_monthly"))}"></div>
        <p class="muted vol-chart-note">${t("vol_chart_partial")}</p>
      </div>
      ${mix ? mixHtml() : ""}`;
  }
  function mixHtml() {
    const total = data.totals.liters;
    const rows = data.rows.filter((r) => r.liters > 0);
    if (!total || rows.length < 2) return "";
    const top = rows.slice(0, MIX_SLOTS);
    const rest = total - top.reduce((s, r) => s + r.liters, 0);
    const items = top.map((r, i) => ({ label: rowLabel(r), liters: r.liters, cls: `vz-s${i + 1}` }));
    if (rest > 0.5) items.push({ label: t("vol_other"), liters: rest, cls: "vz-sx" });
    const pct = (l) => ((l / total) * 100).toFixed(l / total >= 0.1 ? 0 : 1);
    return `<div class="card vol-chart" id="vol-chart-mix">
      <h3 class="health-title">${t("vol_chart_mix")} · ${t(`vol_g_${state.groupBy}`).toLowerCase()}</h3>
      <div class="vol-mix-bar" role="img" aria-label="${escapeHtml(t("vol_chart_mix"))}">${items.map((i) => `<span class="${i.cls}" style="flex:${Math.max(i.liters, total * 0.004)}" title="${escapeHtml(`${i.label}: ${fmtL(i.liters)}`)}"></span>`).join("")}</div>
      <ul class="vol-mix-legend">${items.map((i) => `<li><i class="${i.cls}"></i><span class="vol-mix-name">${escapeHtml(i.label)}</span><strong>${fmtL(i.liters)}</strong><span class="muted vol-mix-pct">${pct(i.liters)}%</span></li>`).join("")}</ul>
    </div>`;
  }

  const svgEl = (w, h, inner) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="vol-svg" aria-hidden="true">${inner}</svg>`;
  // Grid + y labels shared by the charts. Returns the y() mapper and the markup.
  function axes(W, H, m, max) {
    const { top, step } = niceScale(max);
    const ih = H - m.t - m.b;
    const y = (v) => m.t + ih - (v / top) * ih;
    let g = "";
    for (let v = 0; v <= top + 1e-9; v += step) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="vz-grid"/><text x="${m.l - 5}" y="${y(v) + 3.5}" text-anchor="end" class="vz-axis">${axisNum(v)}</text>`;
    return { y, grid: g, ih };
  }
  // Tap / drag across the chart to read a column; the browser keeps vertical scrolling (touch-action: pan-y).
  function scrub(box, n, m, W, onPick) {
    const svg = box.querySelector("svg");
    const band = svg.querySelector(".vz-band");
    const pick = (ev) => {
      const r = svg.getBoundingClientRect();
      const slot = (W - m.l - m.r) / n;
      const i = Math.max(0, Math.min(n - 1, Math.floor(((ev.clientX - r.left) * (W / r.width) - m.l) / slot)));
      band.setAttribute("x", m.l + i * slot);
      band.setAttribute("width", slot);
      band.removeAttribute("hidden");
      onPick(i);
    };
    svg.addEventListener("pointerdown", pick);
    svg.addEventListener("pointermove", (ev) => ev.buttons || ev.pointerType === "mouse" ? pick(ev) : null);
  }
  const bucketLabel = (key, bucket, long = false) => {
    if (bucket === "month") return `${monthName(+key.slice(5, 7))} ${key.slice(0, 4)}`;
    if (bucket === "week") return long ? `${dateCaption(key)} – ${dateCaption(addDaysStr(key, 6))}` : shortDay(key);
    return long ? dateCaption(key) : shortDay(key);
  };
  const axisLabel = (key, bucket) => (bucket === "month" ? `${monthName(+key.slice(5, 7))} ${key.slice(2, 4)}` : shortDay(key));

  function drawTrend() {
    const card = $("#vol-chart-trend");
    if (!card) return;
    const box = card.querySelector(".vol-chart-box");
    const W = Math.max(240, Math.floor(box.clientWidth));
    const H = 190;
    const m = { l: 36, r: 6, t: 8, b: 22 };
    const { rows, prev_rows: prev, bucket } = data.trend;
    const n = rows.length;
    const max = Math.max(...rows.map((r) => r.liters), ...(prev || []).map((r) => r.liters), 1);
    const { y, grid, ih } = axes(W, H, m, max);
    const slot = (W - m.l - m.r) / n;
    const bw = Math.max(2, Math.min(26, slot * 0.7));
    const rad = Math.min(4, bw / 2);
    const bars = rows
      .map((r, i) => {
        if (r.liters <= 0) return "";
        const x = m.l + i * slot + (slot - bw) / 2;
        const top = y(r.liters);
        const base = m.t + ih;
        return `<path d="M${x},${base} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + bw - rad} Q${x + bw},${top} ${x + bw},${top + rad} V${base} Z" class="vz-bar"/>`;
      })
      .join("");
    let line = "";
    if (prev) {
      const k = Math.min(n, prev.length);
      const pts = Array.from({ length: k }, (_, i) => `${m.l + i * slot + slot / 2},${y(prev[i].liters)}`).join(" ");
      line = `<polyline points="${pts}" class="vz-line2"/>`;
      if (n <= 12) line += Array.from({ length: k }, (_, i) => (prev[i].liters ? `<circle cx="${m.l + i * slot + slot / 2}" cy="${y(prev[i].liters)}" r="4" class="vz-dot2"/>` : "")).join("");
    }
    // as many x labels as fit side by side (~64px each), evenly spread, always including the first and last
    const want = Math.max(2, Math.min(n, Math.floor((W - m.l - m.r) / 64)));
    const ticks = Array.from({ length: want }, (_, q) => Math.round((q * (n - 1)) / (want - 1)));
    const xl = [...new Set(ticks)]
      .map((i) => `<text x="${m.l + i * slot + slot / 2}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" class="vz-axis">${escapeHtml(axisLabel(rows[i].key, bucket))}</text>`)
      .join("");
    box.innerHTML = svgEl(W, H, `${grid}<rect class="vz-band" hidden x="0" y="${m.t}" height="${ih}"/>${bars}${line}${xl}`);
    const readout = card.querySelector(".vol-readout");
    scrub(box, n, m, W, (i) => {
      const now = rows[i].liters;
      const p = prev?.[i];
      readout.innerHTML = `<strong>${escapeHtml(bucketLabel(rows[i].key, bucket, true))}</strong> · ${fmtL(now)}${p ? ` · ${escapeHtml(bucketLabel(p.key, bucket, true))}: ${fmtL(p.liters)} ${deltaHtml(now, p.liters)}` : ""}`;
      readout.classList.remove("muted");
    });
  }

  function drawMonthly() {
    const card = $("#vol-chart-monthly");
    if (!card) return;
    const box = card.querySelector(".vol-chart-box");
    const W = Math.max(240, Math.floor(box.clientWidth));
    const H = 190;
    const m = { l: 36, r: 10, t: 8, b: 22 };
    const year = data.monthly.year;
    const by = new Map(data.monthly.rows.map((r) => [r.key, r.liters]));
    const thisYear = Array.from({ length: 12 }, (_, i) => by.get(`${year}-${String(i + 1).padStart(2, "0")}`) ?? null);
    const lastYear = Array.from({ length: 12 }, (_, i) => by.get(`${year - 1}-${String(i + 1).padStart(2, "0")}`) ?? 0);
    const max = Math.max(...thisYear.map((v) => v || 0), ...lastYear, 1);
    const { y, grid, ih } = axes(W, H, m, max);
    const slot = (W - m.l - m.r) / 12;
    const cx = (i) => m.l + i * slot + slot / 2;
    const pts = (arr) => arr.map((v, i) => (v === null ? null : [cx(i), y(v)])).filter(Boolean);
    const line = (arr, cls) => {
      const p = pts(arr);
      return `<polyline points="${p.map((q) => q.join(",")).join(" ")}" class="${cls}"/>${p.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="4" class="${cls}-dot"/>`).join("")}`;
    };
    // every month when each has ~34px, otherwise every other one (Armenian names are wide)
    const everyOther = slot < 34;
    const xl = Array.from({ length: 12 }, (_, i) => (everyOther && i % 2 ? "" : `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="vz-axis">${escapeHtml(monthName(i + 1))}</text>`)).join("");
    box.innerHTML = svgEl(W, H, `${grid}<rect class="vz-band" hidden x="0" y="${m.t}" height="${ih}"/>${line(lastYear, "vz-line2")}${line(thisYear, "vz-line1")}${xl}`);
    const readout = card.querySelector(".vol-readout");
    scrub(box, 12, m, W, (i) => {
      const a = thisYear[i];
      readout.innerHTML = `<strong>${escapeHtml(monthName(i + 1))}</strong> · ${year}: ${a === null ? "—" : fmtL(a)} · ${year - 1}: ${fmtL(lastYear[i])}${a !== null && lastYear[i] ? ` ${deltaHtml(a, lastYear[i])}` : ""}`;
      readout.classList.remove("muted");
    });
  }
  const drawCharts = () => {
    if (!data || !root.isConnected) return;
    drawTrend();
    drawMonthly();
  };
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  });

  function renderBody() {
    const body = $("#vol-body");
    body.innerHTML = `
      ${heroHtml()}
      ${groupChipsHtml()}
      <div id="vol-rows">${rowsHtml()}</div>
      ${periodsHtml()}
      ${chartsHtml()}
      <div class="vol-sync">${data.sync ? syncBadgeHtml(data.sync) : ""}${data.last_erp_order_date ? `<p class="muted">${t("vol_last_order").replace("{d}", escapeHtml(dateCaption(data.last_erp_order_date)))}</p>` : ""}</div>`;
    body.querySelectorAll("[data-cat]").forEach((b) =>
      b.addEventListener("click", () => {
        if (catOf(state.groupBy) === b.dataset.cat) return;
        state.groupBy = GROUP_CATS.find(([k]) => k === b.dataset.cat)[1][0];
        load();
      })
    );
    body.querySelectorAll("[data-group]").forEach((b) =>
      b.addEventListener("click", () => {
        state.groupBy = b.dataset.group;
        load();
      })
    );
    bindRows();
    drawCharts();
  }
  function bindRows() {
    $("#vol-body").querySelectorAll("[data-drill]").forEach((row) =>
      row.addEventListener("click", () => {
        const set = state[DRILL_STATE[state.groupBy]];
        const key = row.dataset.drill;
        if (key === "—") return;
        set.add(key);
        renderFilterChips();
        load();
      })
    );
    $("#vol-more")?.addEventListener("click", () => {
      state.showAll = !state.showAll;
      $("#vol-rows").innerHTML = rowsHtml();
      bindRows();
    });
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
      const columns = [
        { header: t(`vol_g_${state.groupBy}`), width: 34 },
        { header: t("vol_k_liters"), type: "number", width: 12 },
        { header: t("vol_k_orders"), type: "number", width: 10 },
        { header: t("vol_k_customers"), type: "number", width: 12 },
        ...(data.prev ? [{ header: `${t("vol_k_liters")} (${t("vol_cmp_" + data.compare)})`, type: "number", width: 16 }] : []),
      ];
      const rows = data.rows.map((r) => [rowLabel(r), r.liters, r.orders, r.customers, ...(data.prev ? [r.prev_liters ?? 0] : [])]);
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
