// Driver arrival (owner, 2026-10-23): while the app is open on a driver's phone, report where it is every ~20 s (foreground only, like
// locationBroadcast.js: a single getCurrentPosition per tick, never watchPosition). The server decides whether the driver reached a customer of
// today's route; this file only shows the answer: a banner with a one-tap "Delivered" (mode suggest) or "delivered automatically" (mode auto).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, formatAmd, showToast } from "./util.js";
import { canDeliverOrders } from "./state.js";

const ACTIVE_MS = 20000;
const IDLE_MS = 120000; // nothing left to deliver today: check rarely
let timer = null;
let busy = false;
let mode = "off";
let idle = false;
let navigateFn = null;
let dismissedFor = null; // customer id whose banner the driver closed (until they leave and come back)
let shownFor = null;

function banner() {
  let el = document.getElementById("arrival-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "arrival-banner";
    el.className = "arrival-banner";
    el.setAttribute("role", "status");
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function hideBanner() {
  const el = document.getElementById("arrival-banner");
  if (el) el.hidden = true;
  shownFor = null;
}

function showArrival(arrival) {
  const el = banner();
  const auto = arrival.auto_delivered?.length > 0;
  const total = arrival.orders.reduce((sum, o) => sum + o.total_amd, 0);
  const lines = (auto ? arrival.auto_delivered.length : arrival.orders.length);
  el.innerHTML = `
    <div class="arrival-head">
      <strong>${escapeHtml(t(auto ? "arrival_auto_title" : "arrival_title").replace("{name}", arrival.customer_name))}</strong>
      <button type="button" class="icon-btn arrival-close" aria-label="${t("close")}">&times;</button>
    </div>
    <p class="arrival-sub">${escapeHtml(t("arrival_orders").replace("{n}", String(lines)).replace("{sum}", formatAmd(total)))}</p>
    ${
      auto
        ? `<button type="button" class="btn btn-block" data-act="route">${t("arrival_open_route")}</button>`
        : `<div class="arrival-actions">
             <button type="button" class="btn btn-primary" data-act="deliver">${t("arrival_delivered_btn")}</button>
             <button type="button" class="btn" data-act="sign">${t("arrival_signature_btn")}</button>
           </div>`
    }`;
  el.hidden = false;
  shownFor = arrival.customer_id;
  el.querySelector(".arrival-close").addEventListener("click", () => {
    dismissedFor = arrival.customer_id;
    hideBanner();
  });
  el.querySelector('[data-act="route"]')?.addEventListener("click", () => {
    hideBanner();
    navigateFn?.("#/delivery");
  });
  el.querySelector('[data-act="sign"]')?.addEventListener("click", () => {
    hideBanner();
    navigateFn?.("#/delivery");
  });
  const deliverBtn = el.querySelector('[data-act="deliver"]');
  deliverBtn?.addEventListener("click", async () => {
    deliverBtn.disabled = true;
    try {
      await api.arrivalDeliver(arrival.customer_id);
      showToast(t("arrival_done"));
      hideBanner();
      window.dispatchEvent(new Event("orders-changed"));
    } catch (err) {
      showToast(err.message);
      deliverBtn.disabled = false;
    }
  });
}

function handle(res) {
  mode = res.mode;
  idle = res.open_customers === 0;
  const a = res.arrival;
  if (!a) {
    dismissedFor = null;
    hideBanner();
    return;
  }
  if (a.auto_delivered?.length) {
    showToast(t("arrival_auto_done").replace("{n}", String(a.auto_delivered.length)).replace("{name}", a.customer_name));
    window.dispatchEvent(new Event("orders-changed"));
    showArrival(a);
    return;
  }
  if (!a.ready || dismissedFor === a.customer_id) return;
  if (shownFor !== a.customer_id) showArrival(a);
}

function tick() {
  if (document.hidden || busy || !navigator.geolocation) return schedule();
  busy = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        handle(await api.arrivalPing(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy));
      } catch {
        /* offline: try again next tick */
      }
      busy = false;
      schedule();
    },
    () => {
      busy = false;
      schedule();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function schedule() {
  clearTimeout(timer);
  if (mode === "off") return; // switched off in App configuration: asked again only after the next start
  timer = setTimeout(tick, idle ? IDLE_MS : ACTIVE_MS);
}

export async function startDriverArrival(navigate) {
  if (timer || !canDeliverOrders()) return;
  navigateFn = navigate;
  try {
    mode = (await api.getArrivalSettings()).mode;
  } catch {
    return;
  }
  if (mode === "off") return;
  timer = setTimeout(tick, 1000);
  document.addEventListener("visibilitychange", onVisibility);
}

function onVisibility() {
  if (!document.hidden && timer) {
    clearTimeout(timer);
    timer = setTimeout(tick, 500);
  }
}

export function stopDriverArrival() {
  clearTimeout(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisibility);
  hideBanner();
}
