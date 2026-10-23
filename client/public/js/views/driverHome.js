// The delivery driver's Home (owner, 2026-10-23): today's route at a glance, the NEXT stop as one big card (navigate, call, open), and what is
// going wrong. Numbers + stops come from GET /api/delivery/home. The route planner / signature flow stays on the Route tab (#/delivery).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";
import { escapeHtml, formatAmd } from "../util.js";

const REFRESH_MS = 30000;
let lastHome = null;

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const mapsUrl = (s) => (s.lat != null && s.lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address || s.customer_name)}`);
const telUrl = (phone) => `tel:${String(phone).replace(/[^\d+]/g, "")}`;

export function driverAttention(h) {
  const items = [];
  if (h.unrouted_packed > 0) items.push({ level: "amber", text: fill("ops_driver_att_unrouted", { n: h.unrouted_packed }), to: "#/delivery" });
  if (h.stale_stops > 0) items.push({ level: "amber", text: fill("ops_att_stale", { n: h.stale_stops }), to: "#/delivery" });
  if (h.deliver_over_sla > 0) items.push({ level: "red", text: fill("ops_att_deliver_over", { n: h.deliver_over_sla }), to: "#/delivery" });
  return items;
}

function paint(box, h) {
  const next = h.next;
  const att = driverAttention(h);
  const pct = h.total ? Math.round((h.done / h.total) * 100) : 0;
  box.innerHTML = `
    <section class="ops-hero ${h.total && h.done === h.total ? "ops-hero-green" : "ops-hero-blue"} ops-hero-static">
      <span class="ops-hero-label">${t("ops_driver_progress")}</span>
      <span class="ops-hero-number">${h.total ? `${h.done}<small>/${h.total}</small>` : "–"}</span>
      <span class="ops-hero-sub">${h.total ? escapeHtml(fill("ops_driver_stops_done", { done: h.done, total: h.total })) : t("ops_driver_no_route")}</span>
      ${h.total ? `<span class="ops-bar" aria-hidden="true"><span class="ops-bar-fill" style="width:${pct}%"></span></span>` : ""}
    </section>

    ${
      next
        ? `<article class="ops-order ops-next">
            <header class="ops-order-head"><span class="ops-next-label">${t("ops_driver_next")}</span>${next.arrived_at ? `<span class="badge badge-success">${t("ops_driver_here")}</span>` : ""}</header>
            <strong class="ops-order-customer">${escapeHtml(next.customer_name)}</strong>
            <p class="muted ops-order-sub">${escapeHtml(next.address || "")}</p>
            <p class="ops-next-sum">${escapeHtml(next.order_code || "")} · <span class="text-amount">${formatAmd(Number(next.total_amd))}</span></p>
            <div class="ops-actions">
              <a class="btn btn-primary ops-pack-btn" href="${mapsUrl(next)}" target="_blank" rel="noopener">${icons.map || ""} ${t("ops_driver_navigate")}</a>
              ${next.phone ? `<a class="btn ops-problem-btn" href="${telUrl(next.phone)}">${icons.phone} ${t("ops_driver_call")}</a>` : ""}
            </div>
            <button type="button" class="btn btn-block" data-go="#/delivery">${t("ops_driver_open_route")}</button>
          </article>`
        : h.total
          ? `<p class="ops-clear">✓ ${t("ops_driver_all_done")}</p>`
          : `<button type="button" class="btn btn-primary btn-block ops-plan-btn" data-go="#/delivery">${t("ops_driver_plan")}</button>`
    }

    ${
      att.length
        ? `<h2 class="section-title">${t("ops_attention")}</h2><div class="ops-attention">${att
            .map((a) => `<button type="button" class="ops-att ops-att-${a.level}" data-go="${a.to}"><span class="ops-att-dot" aria-hidden="true"></span><span>${escapeHtml(a.text)}</span><span class="ops-att-chevron" aria-hidden="true">›</span></button>`)
            .join("")}</div>`
        : ""
    }

    <div class="ops-grid">
      <button type="button" class="ops-tile" data-go="#/delivery"><span class="ops-tile-icon">${icons.truck}</span><span>${t("ops_tab_route")}</span></button>
      <button type="button" class="ops-tile" data-go="#/orders"><span class="ops-tile-icon">${icons.cart}</span><span>${t("nav_orders")}</span></button>
      <button type="button" class="ops-tile" data-go="#/tasks"><span class="ops-tile-icon">${icons.tasks}</span><span>${t("qa_tasks")}</span></button>
    </div>`;
}

export async function renderDriverHome(root, navigate) {
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

  let alive = true;
  let timer = null;
  async function load() {
    try {
      lastHome = await api.getDeliveryHome();
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
  window.addEventListener("orders-changed", onChanged);
  window.addEventListener("delivery-changed", onChanged);
  await load();
  schedule();
  return () => {
    alive = false;
    clearTimeout(timer);
    window.removeEventListener("orders-changed", onChanged);
    window.removeEventListener("delivery-changed", onChanged);
  };
}
