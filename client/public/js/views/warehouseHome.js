// The warehouse manager's Home (owner, 2026-10-23): one glance = what to do now (pack) and what is going wrong, then big buttons. Numbers come
// from GET /api/warehouse/home; every row opens the screen where it is solved. The classic Inventory stays reachable ("compare").
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";
import { escapeHtml } from "../util.js";
import { formatAge } from "../opsShell.js";
import { attentionItems } from "../warehouseAttention.js";

const REFRESH_MS = 30000;
let lastHome = null; // stale-then-live: the previous numbers paint at once

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const hoursText = (h) => formatAge(Math.round(h * 60));

function stockCountCard(sc) {
  if (!sc || (!sc.due && !sc.finished)) return "";
  return `<button type="button" class="ops-stat ops-stat-wide" data-go="#/stock-count">
      <span class="ops-stat-number">${sc.counted}<small>/${sc.due}</small></span>
      <span class="ops-stat-label">${t("ops_stock_count")}${sc.finished ? ` · ${t(sc.not_finished ? "stock_count_state_not_finished" : "ops_stock_count_done")}` : ""}</span>
    </button>`;
}

function paint(box, h) {
  // the 30-second refresh redraws only when a number changed: no flicker, no lost scroll, no idle DOM work
  const sig = JSON.stringify(h);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const over = h.to_pack.over_sla > 0;
  const att = attentionItems(h);
  box.innerHTML = `
    <button type="button" class="ops-hero ${over ? "ops-hero-red" : h.to_pack.count ? "ops-hero-blue" : "ops-hero-green"}" data-go="#/wh-pack">
      <span class="ops-hero-label">${t("ops_to_pack")}</span>
      <span class="ops-hero-number">${h.to_pack.count}</span>
      <span class="ops-hero-sub">${
        h.to_pack.count ? escapeHtml(fill("ops_oldest_waiting", { t: hoursText(h.to_pack.oldest_h) })) : t("ops_nothing_to_pack")
      }</span>
      ${h.to_pack.count ? `<span class="ops-hero-cta">${t("ops_start_packing")} ›</span>` : ""}
    </button>

    ${stockCountCard(h.stock_count)}

    <div class="ops-pair">
      <button type="button" class="ops-stat" data-go="#/wh-pack?tab=packed">
        <span class="ops-stat-number">${h.packed.count}</span>
        <span class="ops-stat-label">${t("ops_waiting_driver")}</span>
      </button>
      <button type="button" class="ops-stat" data-go="#/delivery">
        <span class="ops-stat-number">${h.today.done}<small>/${h.today.stops}</small></span>
        <span class="ops-stat-label">${t("ops_deliveries_today")}</span>
      </button>
    </div>

    <h2 class="section-title">${t("ops_attention")}</h2>
    ${
      att.length
        ? `<div class="ops-attention">${att
            .map((a) => `<button type="button" class="ops-att ops-att-${a.level}" data-go="${a.to}"><span class="ops-att-dot" aria-hidden="true"></span><span>${escapeHtml(a.text)}</span><span class="ops-att-chevron" aria-hidden="true">›</span></button>`)
            .join("")}</div>`
        : `<p class="ops-clear">✓ ${t("ops_all_clear")}</p>`
    }

    <!-- Orders, Tasks, Stock count and Packing are the bottom tabs; here only what has no tab (owner, 2026-11-03: hyper simple) -->
    <div class="ops-grid">
      <button type="button" class="ops-tile ops-tile-wide" data-go="#/warehouse"><span class="ops-tile-icon">${icons.box}</span><span>${t("ops_shortcut_inventory")}</span></button>
      <button type="button" class="ops-tile" data-go="#/returns"><span class="ops-tile-icon">${icons.undo}</span><span>${t("qa_returns")}</span>${h.returns_to_receive ? `<span class="count-badge ops-tile-badge">${h.returns_to_receive}</span>` : ""}</button>
      <button type="button" class="ops-tile" data-go="#/staff"><span class="ops-tile-icon">${icons.person}</span><span>${t("qa_staff")}</span></button>
    </div>`;
}

export async function renderWarehouseHome(root, navigate) {
  root.innerHTML = `
    <div class="ops-view">
      <h1 class="ops-hello">${escapeHtml(fill("ops_hello", { name: (state.user?.name || "").split(" ")[0] }))}</h1>
      <div id="ops-body" class="ops-stack"></div>
      <p class="form-error" id="ops-error" hidden></p>
    </div>`;
  const box = root.querySelector("#ops-body");
  const errorEl = root.querySelector("#ops-error");
  box.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) navigate(go.dataset.go);
  });
  if (lastHome) paint(box, lastHome);
  else box.innerHTML = `<div class="ops-skeleton" aria-hidden="true"></div><p class="loading-state" role="status">${t("loading")}</p>`;

  let timer = null;
  let alive = true;
  async function load() {
    try {
      lastHome = await api.getWarehouseHome();
      if (!alive) return;
      errorEl.hidden = true;
      paint(box, lastHome);
    } catch (err) {
      if (!alive || lastHome) return;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      box.innerHTML = "";
    }
  }
  const schedule = () => {
    clearTimeout(timer);
    if (alive) timer = setTimeout(async () => ((document.hidden ? 0 : await load()), schedule()), REFRESH_MS);
  };
  const onChanged = () => load();
  // back to the app (phone unlocked, tab shown): fresh numbers at once, not after up to 30 s
  const onVisible = () => !document.hidden && load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("warehouse-changed", onChanged);
  window.addEventListener("orders-changed", onChanged);
  await load();
  schedule();
  return () => {
    alive = false;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("warehouse-changed", onChanged);
    window.removeEventListener("orders-changed", onChanged);
  };
}
