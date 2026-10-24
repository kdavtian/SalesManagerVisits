// The warehouse manager's Home (owner, 2026-10-23): one glance = what to do now (pack) and what is going wrong, then big buttons. Numbers come
// from GET /api/warehouse/home; every row opens the screen where it is solved. The classic Inventory stays reachable ("compare").
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";
import { escapeHtml } from "../util.js";
import { formatAge } from "../opsShell.js";

const REFRESH_MS = 30000;
let lastHome = null; // stale-then-live: the previous numbers paint at once

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const hoursText = (h) => formatAge(Math.round(h * 60));

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
  if (h.tasks.overdue > 0) items.push({ level: "amber", text: fill("ops_att_tasks", { n: h.tasks.overdue }), to: "#/tasks" });
  return items;
}

function paint(box, h) {
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

    <div class="ops-grid">
      <button type="button" class="ops-tile" data-go="#/orders"><span class="ops-tile-icon">${icons.cart}</span><span>${t("nav_orders")}</span></button>
      <button type="button" class="ops-tile" data-go="#/pricelist"><span class="ops-tile-icon">${icons.tag}</span><span>${t("ops_tab_products")}</span></button>
      <button type="button" class="ops-tile" data-go="#/tasks"><span class="ops-tile-icon">${icons.tasks}</span><span>${t("qa_tasks")}</span>${h.tasks.open ? `<span class="count-badge ops-tile-badge">${h.tasks.open}</span>` : ""}</button>
      <button type="button" class="ops-tile" data-go="#/delivery"><span class="ops-tile-icon">${icons.truck}</span><span>${t("ops_shortcut_delivery")}</span></button>
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
  window.addEventListener("warehouse-changed", onChanged);
  window.addEventListener("orders-changed", onChanged);
  await load();
  schedule();
  return () => {
    alive = false;
    clearTimeout(timer);
    window.removeEventListener("warehouse-changed", onChanged);
    window.removeEventListener("orders-changed", onChanged);
  };
}
