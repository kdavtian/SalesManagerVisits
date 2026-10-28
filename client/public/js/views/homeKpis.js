// Desktop Home (owner, 2026-10-25): instead of repeating the sidebar menu as tiles, management sees the company's numbers, each one a link to the page where it is
// dealt with. Phones keep the tiles (the block is hidden below 1024 px by CSS and not even requested there).
import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t, getLang } from "../i18n.js";
import { loadWithCache } from "../listCache.js";
import { state } from "../state.js";
import { seesHomeKpis } from "../shared/roles.js";
import { icons } from "../icons.js";
import { repColor } from "../repColors.js";

export const wantsKpis = () => seesHomeKpis(state.user.role) && window.matchMedia?.("(min-width: 1024px)").matches;

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
    </div>
    <div class="home-desk-cols">
      ${attentionHtml(k)}
      <div class="home-today-slot"></div>
    </div>`;
}

// "Needs attention" (Step 7): what is waiting for somebody, each row opening the page where it is dealt with. Rows with nothing waiting
// stay (dimmed) so the list does not jump around from one day to the next.
function attentionRow({ href, label, count, sub, warn }) {
  return `<a class="home-att-row${count ? (warn ? " is-warn" : "") : " is-clear"}" href="${href}">
    <span class="home-att-count">${fmt(count)}</span>
    <span class="home-att-text"><span class="home-att-label">${escapeHtml(label)}</span>${sub ? `<span class="home-att-sub muted">${escapeHtml(sub)}</span>` : ""}</span>
    <span class="home-att-chevron" aria-hidden="true">${icons.chevronRight}</span>
  </a>`;
}

function attentionHtml(k) {
  const o = k.orders;
  const waiting = o.to_confirm + o.to_pack + o.to_deliver;
  const rows = [
    { href: "#/orders", label: t("home_att_orders"), count: waiting, sub: waiting ? fill(t("kpi_orders_sub"), { a: fmt(o.to_confirm), b: fmt(o.to_pack), c: fmt(o.to_deliver) }) : "" },
    { href: "#/payments", label: t("home_att_unconfirmed"), count: k.payments.pending_approval, sub: k.payments.pending_approval ? t("home_att_unconfirmed_sub") : "" },
    { href: "#/tasks", label: t("home_att_tasks"), count: k.tasks.overdue, sub: fill(t("home_att_tasks_sub"), { n: fmt(k.tasks.open) }), warn: true },
    { href: "#/payments", label: t("home_att_excel"), count: k.payments.not_in_excel_count, sub: k.payments.not_in_excel_count ? formatAmd(k.payments.not_in_excel_amd) : "", warn: true },
  ];
  const clear = rows.every((r) => !r.count);
  return `<section class="card home-col home-attention" aria-labelledby="home-att-h">
    <h2 class="home-col-title" id="home-att-h">${t("home_attention")}</h2>
    ${clear ? `<p class="muted home-att-clear">${escapeHtml(t("home_att_clear"))}</p>` : ""}
    <div class="home-att-list">${rows.map(attentionRow).join("")}</div>
  </section>`;
}

// ---- "Today" (Step 7): the field team's day, one element kept across Home's repaints so the map is drawn once, not on every paint ----
const today = { el: null, data: null, map: null, layer: null, run: null, at: 0, sig: "" };
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Yerevan" }) : "");

function todayEl() {
  // another language or another person signed in: start over (labels and data belong to the old one)
  const sig = `${getLang()}:${state.user.id}`;
  if (today.sig !== sig) {
    today.map?.remove();
    Object.assign(today, { el: null, data: null, map: null, layer: null, run: null, at: 0, sig });
  }
  if (today.el) return today.el;
  const el = document.createElement("section");
  el.className = "card home-col home-today";
  el.setAttribute("aria-labelledby", "home-today-h");
  el.innerHTML = `<div class="home-col-head"><h2 class="home-col-title" id="home-today-h">${t("home_today")}</h2>
      <a class="link-btn home-col-link" href="#/team-progress">${escapeHtml(t("home_today_all"))}</a></div>
    <p class="home-today-team muted"></p>
    <div class="home-today-reps"></div>
    <div class="home-today-map"><div class="home-today-map-canvas"></div><p class="home-today-map-empty muted" hidden>${escapeHtml(t("home_today_no_visits"))}</p></div>`;
  today.el = el;
  return el;
}

function paintToday() {
  const d = today.data;
  const el = today.el;
  if (!el || !d) return;
  const reps = d.reps ?? [];
  const out = reps.filter((r) => r.visited > 0).length;
  const visits = reps.reduce((n, r) => n + r.visited, 0);
  el.querySelector(".home-today-team").textContent = reps.length ? fill(t("home_today_team"), { a: fmt(out), b: fmt(reps.length), v: fmt(visits) }) : t("home_today_no_reps");
  // reps who have something today first (planned or visited), then by name
  const sorted = [...reps].sort((a, b) => Number(b.planned > 0 || b.visited > 0) - Number(a.planned > 0 || a.visited > 0) || a.name.localeCompare(b.name));
  el.querySelector(".home-today-reps").innerHTML = sorted
    .map((r) => {
      const pct = r.planned ? Math.min(100, Math.round((r.visited / r.planned) * 100)) : r.visited ? 100 : 0;
      const tail = r.first_at ? fill(t("home_today_since"), { t: hhmm(r.first_at) }) : "";
      return `<a class="home-rep-row${r.visited ? "" : " is-idle"}" href="#/team-progress" aria-label="${escapeHtml(fill(t("home_today_rep_aria"), { name: r.name, v: r.visited, p: r.planned }))}">
        <span class="home-rep-dot" style="background:${repColor(r.user_id, r.map_color)}" aria-hidden="true"></span>
        <span class="home-rep-name">${escapeHtml(r.name)}</span>
        <span class="home-rep-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="home-rep-num">${fmt(r.visited)}${r.planned ? `<span class="muted">/${fmt(r.planned)}</span>` : `<span class="muted" title="${escapeHtml(t("home_today_no_plan"))}">/–</span>`}</span>
        <span class="home-rep-since muted">${escapeHtml(tail)}</span>
      </a>`;
    })
    .join("");
  drawTodayMap();
}

async function drawTodayMap() {
  const el = today.el;
  const points = (today.data?.visits ?? []).filter((v) => v.lat != null && v.lng != null);
  el.querySelector(".home-today-map-empty").hidden = points.length > 0;
  const canvas = el.querySelector(".home-today-map-canvas");
  canvas.hidden = !points.length;
  if (!points.length || !el.isConnected) return;
  if (!today.map) {
    try {
      const { ensureLeaflet } = await import("../leafletLoader.js");
      await ensureLeaflet();
    } catch {
      el.querySelector(".home-today-map").hidden = true;
      return;
    }
    if (today.map || !canvas.isConnected) return;
    const L = window.L;
    today.map = L.map(canvas, { zoomControl: false, scrollWheelZoom: false, attributionControl: true, rotate: false, rotateControl: false, touchRotate: false, compassBearing: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap" }).addTo(today.map);
    today.map.attributionControl?.setPrefix(false);
    today.layer = L.layerGroup().addTo(today.map);
  }
  const L = window.L;
  today.layer.clearLayers();
  const latlngs = [];
  for (const v of points) {
    const ll = [Number(v.lat), Number(v.lng)];
    latlngs.push(ll);
    L.circleMarker(ll, { radius: 6, weight: 1.5, color: "#ffffff", fillColor: repColor(v.user_id, v.map_color), fillOpacity: 0.95 })
      .bindTooltip(`${escapeHtml(v.customer_name || "")} · ${escapeHtml(v.user_name || "")} ${hhmm(v.timestamp)}`, { direction: "top" })
      .on("click", () => (location.hash = `#/customers/${v.customer_id}`))
      .addTo(today.layer);
  }
  today.map.invalidateSize();
  if (latlngs.length === 1) today.map.setView(latlngs[0], 14);
  else today.map.fitBounds(latlngs, { padding: [18, 18], maxZoom: 15 });
  setTimeout(() => canvas.isConnected && today.map?.invalidateSize(), 150);
}

async function loadToday() {
  if (today.run && Date.now() - today.at < 3000) return today.run;
  today.at = Date.now();
  const sig = today.sig;
  today.run = loadWithCache(`home-today:${state.user.id}`, () => api.dashboardToday(), (d) => {
    if (today.sig !== sig) return;
    today.data = d;
    paintToday();
  }).catch(() => {
    if (!today.data && today.el) today.el.hidden = true;
  });
  return today.run;
}

// Home repaints itself (cache first, then the live answer) and its slot is a new element each time: both paints share one request,
// and whatever slot is current gets the numbers.
const recent = { at: 0, run: null, slot: null, last: null };

function paintInto(slot, k) {
  if (!slot?.isConnected) return;
  slot.innerHTML = html(k);
  slot.hidden = false;
  const el = todayEl();
  slot.querySelector(".home-today-slot").replaceWith(el);
  if (today.data) paintToday();
  // the map keeps its tiles when the element moves into a new Home; it only needs to re-measure
  today.map && setTimeout(() => el.isConnected && today.map.invalidateSize(), 0);
}

// A failure leaves the block empty (the rest of Home is not affected).
export async function renderHomeKpis(slot) {
  if (!slot || !wantsKpis()) return;
  recent.slot = slot;
  if (recent.last) paintInto(slot, recent.last);
  todayEl();
  loadToday();
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
