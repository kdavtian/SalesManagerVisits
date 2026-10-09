// Fuel allowance report: per rep, per day, the kilometres driven between the
// day's check-ins (home legs when the day starts/ends outside Yerevan) and the
// fuel money they are worth. Tap a rep to see the days, tap a day for the exact
// route (times, km per leg, a small map). Admin/CEO set consumption, home
// address and the monthly fuel price from the Settings button, and can correct
// a day. The page never waits on road routing: distances that are still being
// worked out show as estimates with a progress bar and refresh by themselves.
import { api } from "../api.js";
import { t, getLang } from "../i18n.js";
import { escapeHtml, formatAmd, downloadFromUrl, activateDialog } from "../util.js";
import { icons } from "../icons.js";
import { state } from "../state.js";
import { ensureLeaflet } from "../leafletLoader.js";

const MONTH_KEY = "fv_fuel_month";
const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
function savedMonth() {
  try {
    return sessionStorage.getItem(MONTH_KEY) || currentMonth();
  } catch {
    return currentMonth();
  }
}
const locale = () => (getLang() === "hy" ? "hy-AM" : "en-GB");
const num = (v, max = 1) => Number(v ?? 0).toLocaleString(locale(), { maximumFractionDigits: max });
const km = (v) => `${num(v)} ${t("fuel_km_unit")}`;
const liters = (v) => (v == null ? "—" : `${num(v)} ${t("fuel_liters_unit")}`);
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", minute: "2-digit" });
const fill = (text, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), text);
function monthLabel(month) {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" });
}
function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function dayParts(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    weekday: d.toLocaleDateString(locale(), { weekday: "short", timeZone: "UTC" }),
    dm: `${date.slice(8, 10)}.${date.slice(5, 7)}`,
  };
}
const initials = (name) => String(name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const stopsOf = (d) => d.route.filter((p) => p.type === "checkin").length;

export async function renderFuelReport(root, navigate) {
  const canManage = ["admin", "ceo"].includes(state.user?.role);
  let month = savedMonth();
  let data = null;
  let polls = 0;
  let pollTimer = null;
  let loadSeq = 0;
  const openReps = new Set();
  const openDays = new Set();
  const openMaps = new Set();
  const maps = new Map();

  root.innerHTML = `
    <div class="detail-view fuel-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("report_fuel_allowance_name")}</h1></div>
      </div>
      <div class="fuel-controls">
        <button type="button" class="icon-btn" id="fuel-prev" aria-label="${t("fuel_prev_month")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <label class="fuel-month-pill"><span id="fuel-month-label"></span><input type="month" id="fuel-month" aria-label="${t("fuel_month")}" /></label>
        <button type="button" class="icon-btn" id="fuel-next" aria-label="${t("fuel_next_month")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <button type="button" class="icon-btn" id="fuel-csv-btn" aria-label="${t("fuel_download_csv")}" title="${t("fuel_download_csv")}">${icons.download}</button>
      </div>
      <div id="fuel-body"></div>
    </div>`;
  const container = root.querySelector(".fuel-view");
  const body = container.querySelector("#fuel-body");
  const monthInput = container.querySelector("#fuel-month");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));

  function setMonth(next) {
    month = next;
    try {
      sessionStorage.setItem(MONTH_KEY, month);
    } catch {
      /* ignore */
    }
    container.querySelector("#fuel-month-label").textContent = monthLabel(month);
    monthInput.value = month;
    container.querySelector("#fuel-next").disabled = month >= currentMonth();
    openDays.clear();
    openMaps.clear();
    polls = 0;
    load();
  }
  monthInput.addEventListener("change", () => monthInput.value && setMonth(monthInput.value));
  container.querySelector("#fuel-prev").addEventListener("click", () => setMonth(shiftMonth(month, -1)));
  container.querySelector("#fuel-next").addEventListener("click", () => setMonth(shiftMonth(month, 1)));
  container.querySelector("#fuel-csv-btn").addEventListener("click", async () => {
    try {
      await downloadFromUrl(`/api/fuel/report.csv?month=${month}`, `fuel-${month}.csv`);
    } catch (err) {
      body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
    }
  });

  async function load({ quiet = false, retry = false } = {}) {
    const seq = ++loadSeq;
    clearTimeout(pollTimer);
    if (!quiet) body.innerHTML = `<div class="fuel-skeleton"><div></div><div></div><div></div></div><p class="muted fuel-loading-note">${t("fuel_loading")}</p>`;
    try {
      const result = await api.fuelReport(month, retry);
      if (seq !== loadSeq || !container.isConnected) return;
      data = result;
      paint();
      // Road distances still being worked out: look again shortly (up to ~2 min).
      if (data.routing.pending > 0 && polls < 40) {
        polls++;
        pollTimer = setTimeout(() => load({ quiet: true }), 3000);
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      body.innerHTML = `<div class="card fuel-error"><p class="form-error">${escapeHtml(err.message)}</p><button type="button" class="btn btn-primary" id="fuel-retry-load">${t("fuel_retry")}</button></div>`;
      body.querySelector("#fuel-retry-load").addEventListener("click", () => load());
    }
  }

  // ---- painting ----
  function setupItems() {
    const items = [];
    if (data.price_amd_per_l == null) items.push({ text: fill(t("fuel_setup_price"), { month: monthLabel(month) }), focus: { type: "price" } });
    for (const r of data.reps) {
      const active = r.days.length > 0;
      if (r.fuel_l_per_100km == null && active) items.push({ text: fill(t("fuel_setup_consumption"), { name: r.name_hy || r.name }), focus: { type: "rep", id: r.user_id } });
      if (!r.home_set && r.totals.missing_home_days) items.push({ text: fill(t("fuel_setup_home"), { name: r.name_hy || r.name }), focus: { type: "rep", id: r.user_id } });
    }
    return items;
  }

  function paint() {
    const scroll = window.scrollY;
    for (const m of maps.values()) m.remove();
    maps.clear();
    const tot = data.totals;
    const active = data.reps.filter((r) => r.days.length > 0).sort((a, b) => (b.totals.amount ?? b.totals.km) - (a.totals.amount ?? a.totals.km));
    const idle = data.reps.filter((r) => r.days.length === 0);
    const days = active.reduce((s, r) => s + r.totals.days, 0);
    const maxKm = Math.max(1, ...active.map((r) => r.totals.km));
    const setup = setupItems();
    const rt = data.routing;
    const done = rt.total - rt.pending - rt.failed;

    body.innerHTML = `
      ${
        setup.length
          ? canManage
            ? `<div class="card fuel-setup"><strong>${t("fuel_setup_title")}</strong><p class="muted">${t("fuel_setup_hint")}</p>${setup.map((s, i) => `<button type="button" class="fuel-setup-item" data-setup="${i}"><span>${escapeHtml(s.text)}</span><span aria-hidden="true">›</span></button>`).join("")}</div>`
            : `<p class="fuel-note fuel-note-warn">${fill(t("fuel_setup_wait"), { what: setup.map((s) => s.text).join("; ") })}</p>`
          : ""
      }
      <div class="card fuel-hero">
        <div class="fuel-hero-top"><span class="fuel-hero-label">${t("fuel_total_amount")}</span>${canManage ? `<button type="button" class="btn fuel-settings-btn" id="fuel-settings-btn">${icons.settings}<span>${t("fuel_settings_btn")}</span></button>` : ""}</div>
        <strong class="fuel-hero-amount">${tot.amount == null ? "—" : formatAmd(tot.amount)}</strong>
        <div class="fuel-hero-stats">
          <span><b>${km(tot.km)}</b>${t("fuel_total_km")}</span>
          <span><b>${liters(tot.liters)}</b>${t("fuel_total_liters")}</span>
          <span><b>${days}</b>${t("fuel_stat_days")}</span>
          <span><b>${data.price_amd_per_l ? `${num(data.price_amd_per_l, 0)} ${t("amd")}` : "—"}</b>${t("fuel_price_short")}</span>
        </div>
      </div>
      ${
        rt.pending > 0
          ? `<div class="fuel-progress" role="status"><div class="fuel-progress-bar"><span style="width:${rt.total ? Math.round((done / rt.total) * 100) : 0}%"></span></div><span>${fill(t("fuel_calculating"), { done, total: rt.total })}</span></div>`
          : rt.failed > 0
            ? `<div class="fuel-note fuel-note-warn">${t("fuel_estimated_note")} <button type="button" class="fuel-link" id="fuel-retry">${t("fuel_retry")}</button></div>`
            : ""
      }
      <div class="fuel-reps">${active.map((r) => repHtml(r, maxKm)).join("") || `<div class="card fuel-empty"><p>${t("fuel_empty_month")}</p></div>`}</div>
      ${idle.length ? `<details class="fuel-idle"><summary>${t("fuel_no_checkins_reps")} (${idle.length})</summary><p class="muted">${idle.map((r) => escapeHtml(r.name_hy || r.name)).join(" · ")}</p></details>` : ""}
      <details class="card fuel-how"><summary>${t("fuel_how_title")}</summary><ul><li>${t("fuel_how_1")}</li><li>${t("fuel_how_2")}</li><li>${t("fuel_how_3")}</li><li>${t("fuel_how_4")}</li></ul></details>`;
    body.querySelector("#fuel-settings-btn")?.addEventListener("click", () => openSettings());
    body.querySelectorAll("[data-setup]").forEach((btn) => btn.addEventListener("click", () => openSettings(setup[Number(btn.dataset.setup)].focus)));
    body.querySelector("#fuel-retry")?.addEventListener("click", () => {
      polls = 0;
      load({ quiet: true, retry: true });
    });
    for (const key of openMaps) initMap(key);
    window.scrollTo(0, scroll);
  }

  function repHtml(rep, maxKm) {
    const open = openReps.has(rep.user_id);
    const name = rep.name_hy || rep.name;
    const avg = rep.totals.days ? rep.totals.km / rep.totals.days : 0;
    const chips = [
      rep.fuel_l_per_100km == null
        ? `<button type="button" class="badge badge-warning fuel-chip" data-edit="${rep.user_id}" ${canManage ? "" : "disabled"}>${t("fuel_no_consumption")}</button>`
        : `<span class="badge badge-neutral">${t("fuel_city_short")} ${num(rep.fuel_l_per_100km)} · ${t("fuel_highway_short")} ${num(rep.fuel_highway_l_per_100km ?? rep.fuel_l_per_100km)} ${t("fuel_liters_unit")}/100${t("fuel_km_unit")}</span>`,
      rep.fuel_l_per_100km != null && rep.fuel_highway_l_per_100km == null && rep.totals.highway_km > 0
        ? `<button type="button" class="badge badge-warning fuel-chip" data-edit="${rep.user_id}" ${canManage ? "" : "disabled"}>${t("fuel_no_highway")}</button>`
        : "",
      rep.totals.suspicious_days ? `<span class="badge badge-warning">⚠ ${rep.totals.suspicious_days} ${t("fuel_check_days")}</span>` : "",
      rep.totals.missing_home_days ? `<button type="button" class="badge badge-warning fuel-chip" data-edit="${rep.user_id}" ${canManage ? "" : "disabled"}>${t("fuel_home_missing")}</button>` : "",
      rep.totals.estimated_days ? `<span class="badge badge-neutral">${t("fuel_estimated")}</span>` : "",
    ].join("");
    return `
      <div class="card fuel-rep ${open ? "is-open" : ""}">
        <button type="button" class="fuel-rep-head" data-rep="${rep.user_id}" aria-expanded="${open}">
          <span class="fuel-avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>
          <span class="fuel-rep-main"><strong>${escapeHtml(name)}</strong><span class="muted">${rep.totals.days} ${t("fuel_days_unit")} · ${km(rep.totals.km)} · ${t("fuel_avg_day")} ${num(avg)} ${t("fuel_km_unit")}</span></span>
          <span class="fuel-rep-amount">${rep.totals.amount == null ? "" : formatAmd(rep.totals.amount)}</span>
          <span class="fuel-chevron" aria-hidden="true">${icons.chevronDown}</span>
        </button>
        <div class="fuel-bar" aria-hidden="true"><span style="width:${Math.max(2, Math.round((rep.totals.km / maxKm) * 100))}%"></span></div>
        <div class="fuel-rep-chips">${chips}</div>
        ${open ? `<div class="fuel-days">${rep.days.map((d) => dayHtml(rep, d)).join("")}</div>` : ""}
      </div>`;
  }

  function dayHtml(rep, d) {
    const key = `${rep.user_id}:${d.date}`;
    const open = openDays.has(key);
    const p = dayParts(d.date);
    const n = stopsOf(d);
    const badge = d.override ? `<span class="badge badge-info">${t("fuel_adjusted")}</span>` : d.estimated ? `<span class="badge badge-neutral">${d.estimate_state === "pending" ? "…" : t("fuel_estimated")}</span>` : "";
    return `
      <div class="fuel-day ${open ? "is-open" : ""}">
        <button type="button" class="fuel-day-head" data-day="${key}" aria-expanded="${open}">
          <span class="fuel-day-date"><b>${escapeHtml(p.weekday)}</b><span>${p.dm}</span></span>
          <span class="fuel-day-mid"><span class="fuel-day-km">${km(d.km)} ${badge}</span><span class="muted">${n} ${n === 1 ? t("fuel_stop_one") : t("fuel_stops")}${d.highway_km > 0 ? ` · ${t("fuel_city_short")} ${num(d.city_km)} / ${t("fuel_highway_short")} ${num(d.highway_km)}` : ""}${d.missing_home ? ` · ⚠ ${t("fuel_home_missing")}` : ""}${d.suspicious ? ` · ⚠ ${t("fuel_check_day")}` : ""}</span></span>
          <span class="fuel-day-amount">${d.amount == null ? "" : formatAmd(d.amount)}</span>
        </button>
        ${open ? routeHtml(rep, d, key) : ""}
      </div>`;
  }

  function routeHtml(rep, d, key) {
    const stops = d.route
      .map((p, i) => {
        const title = p.type === "home" ? `${t("fuel_home")}${p.name ? ` · ${escapeHtml(p.name)}` : ""}` : escapeHtml(p.name);
        return `
        <li class="fuel-stop fuel-stop-${p.type}">
          <span class="fuel-time">${p.time ? timeOf(p.time) : ""}</span>
          <span class="fuel-dot" aria-hidden="true">${p.type === "home" ? "⌂" : i + (d.route[0].type === "home" ? 0 : 1)}</span>
          <span class="fuel-stop-body"><strong>${title}</strong>${p.km_from_prev != null ? `<span class="fuel-leg">+ ${km(p.km_from_prev)}${p.km_from_prev > 0 && p.city_km != null && p.city_km < p.km_from_prev - 0.05 ? ` (${t("fuel_highway_short")} ${num(p.km_from_prev - p.city_km)})` : ""}</span>` : ""}</span>
        </li>`;
      })
      .join("");
    const skipped = d.skipped.map((s) => `<li class="fuel-skipped"><span class="fuel-time">${timeOf(s.time)}</span> ${escapeHtml(s.name)} — ${t("fuel_not_counted")}</li>`).join("");
    const merged = d.merged.map((m) => `<li class="fuel-skipped"><span class="fuel-time">${timeOf(m.time)}</span> ${escapeHtml(m.name)} — ${t("fuel_same_place")}</li>`).join("");
    const manage = canManage
      ? `<button type="button" class="btn" data-adjust="${key}">${t("fuel_adjust_km")}</button>${d.override ? `<button type="button" class="btn" data-reset="${key}">${t("fuel_reset")}</button>` : ""}`
      : "";
    const mapOpen = openMaps.has(key);
    return `
      <div class="fuel-route">
        ${d.missing_home ? `<p class="fuel-note fuel-note-warn">${t("fuel_home_missing_day")}</p>` : ""}
        ${d.suspicious ? `<p class="fuel-note fuel-note-warn">${t("fuel_suspicious_day")}</p>` : ""}
        ${d.override ? `<p class="fuel-note">${fill(t("fuel_computed_km"), { km: d.computed_km })}${d.override.note ? ` · ${escapeHtml(d.override.note)}` : ""}</p>` : ""}
        <ol class="fuel-stops">${stops || `<li class="muted">${t("fuel_no_visits")}</li>`}</ol>
        ${skipped || merged ? `<ul class="fuel-skipped-list">${skipped}${merged}</ul>` : ""}
        ${d.route.length > 1 ? `<div class="fuel-map-wrap"><div class="fuel-map" data-map="${key}" ${mapOpen ? "" : "hidden"}></div>${mapOpen ? `<p class="muted fuel-map-note">${t("fuel_map_note")}</p>` : ""}</div>` : ""}
        <div class="fuel-day-actions">${d.route.length > 1 ? `<button type="button" class="btn" data-map-toggle="${key}">${mapOpen ? t("fuel_hide_map") : t("fuel_show_map")}</button>` : ""}${manage}</div>
      </div>`;
  }

  async function initMap(key) {
    const el = body.querySelector(`.fuel-map[data-map="${key}"]`);
    const [uid, date] = key.split(":");
    const day = data.reps.find((r) => r.user_id === Number(uid))?.days.find((d) => d.date === date);
    if (!el || !day) return;
    try {
      await ensureLeaflet();
      if (!el.isConnected) return;
      // new L.Map (not L.map): the shared L.map wrapper would store this little
      // map's view as the main map's remembered position.
      const map = new window.L.Map(el, { attributionControl: false, zoomControl: true, scrollWheelZoom: false });
      maps.set(key, map);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      const pts = day.route.map((p) => [p.lat, p.lng]);
      window.L.polyline(pts, { color: "#0a66e8", weight: 3, dashArray: "6 6" }).addTo(map);
      let n = 0;
      day.route.forEach((p) => {
        const label = p.type === "home" ? "⌂" : ++n;
        window.L.marker([p.lat, p.lng], { icon: window.L.divIcon({ className: "", html: `<div class="fuel-pin ${p.type === "home" ? "fuel-pin-home" : ""}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
      });
      map.fitBounds(pts, { padding: [28, 28], maxZoom: 16 });
    } catch {
      el.outerHTML = `<p class="muted">${t("map_load_failed")}</p>`;
    }
  }

  body.addEventListener("click", async (e) => {
    const repBtn = e.target.closest("[data-rep]");
    if (repBtn) {
      const id = Number(repBtn.dataset.rep);
      if (openReps.has(id)) openReps.delete(id);
      else openReps.add(id);
      return paint();
    }
    const dayBtn = e.target.closest("[data-day]");
    if (dayBtn) {
      const key = dayBtn.dataset.day;
      if (openDays.has(key)) {
        openDays.delete(key);
        openMaps.delete(key);
      } else openDays.add(key);
      return paint();
    }
    const mapBtn = e.target.closest("[data-map-toggle]");
    if (mapBtn) {
      const key = mapBtn.dataset.mapToggle;
      if (openMaps.has(key)) openMaps.delete(key);
      else openMaps.add(key);
      return paint();
    }
    const edit = e.target.closest("[data-edit]");
    if (edit && canManage) return openSettings({ type: "rep", id: Number(edit.dataset.edit) });
    const adjust = e.target.closest("[data-adjust]");
    if (adjust) return openAdjust(...adjust.dataset.adjust.split(":"));
    const reset = e.target.closest("[data-reset]");
    if (reset) {
      const [uid, date] = reset.dataset.reset.split(":");
      await api.setFuelOverride({ user_id: Number(uid), day: date, km: null });
      load({ quiet: true });
    }
  });

  // ---- sheets ----
  function sheet(html) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet fuel-sheet" role="dialog" aria-modal="true"><form class="fuel-form" onsubmit="return false">${html}</form></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    return overlay;
  }

  function openAdjust(uid, date) {
    const rep = data.reps.find((r) => r.user_id === Number(uid));
    const day = rep?.days.find((d) => d.date === date);
    if (!day) return;
    const p = dayParts(date);
    const overlay = sheet(`
      <h2>${t("fuel_adjust_km")}</h2>
      <p class="muted">${escapeHtml(rep.name_hy || rep.name)} · ${p.weekday} ${p.dm} · ${fill(t("fuel_computed_km"), { km: day.computed_km })}</p>
      <label>${t("fuel_total_km")} (${t("fuel_km_unit")})<input type="number" id="adj-km" min="0" max="2000" step="0.1" value="${day.km}" inputmode="decimal" /></label>
      <label>${t("fuel_adjust_note")}<input type="text" id="adj-note" maxlength="300" value="${escapeHtml(day.override?.note ?? "")}" /></label>
      <p class="form-error" id="adj-error" hidden></p>
      <div class="sheet-actions"><button type="button" class="btn" data-close>${t("cancel")}</button><button type="button" class="btn btn-primary" id="adj-save">${t("save")}</button></div>`);
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#adj-save").addEventListener("click", async () => {
      try {
        await api.setFuelOverride({ user_id: Number(uid), day: date, km: Number(overlay.querySelector("#adj-km").value), note: overlay.querySelector("#adj-note").value || null });
        overlay.remove();
        load({ quiet: true });
      } catch (err) {
        const el = overlay.querySelector("#adj-error");
        el.textContent = err.message;
        el.hidden = false;
      }
    });
  }

  async function openSettings(focus = null) {
    let s;
    try {
      s = await api.fuelSettings(month);
    } catch (err) {
      return body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
    }
    const overlay = sheet(`
      <h2>${t("fuel_settings")}</h2>
      <section class="card fuel-price-box" id="fuel-price-box">
        <label>${t("fuel_price_label")} · ${escapeHtml(monthLabel(month))}<input type="number" id="fuel-price" min="1" step="1" inputmode="decimal" value="${s.price_amd_per_l ?? ""}" /></label>
        <button type="button" class="btn btn-primary" id="fuel-price-save">${t("save")}</button>
      </section>
      <p class="muted">${t("fuel_settings_hint")}</p>
      <div class="fuel-settings-reps">
        ${s.reps
          .map(
            (r) => `
          <div class="card fuel-rep-settings" data-user="${r.id}">
            <strong>${escapeHtml(r.name_hy || r.name)}</strong>
            <div class="fuel-cons-row">
              <label>${t("fuel_consumption_city")}<input type="number" class="fs-cons" min="1" max="60" step="0.1" inputmode="decimal" value="${r.fuel_l_per_100km ?? ""}" /></label>
              <label>${t("fuel_consumption_highway")}<input type="number" class="fs-cons-hwy" min="1" max="60" step="0.1" inputmode="decimal" value="${r.fuel_highway_l_per_100km ?? ""}" /></label>
            </div>
            <label>${t("fuel_home_address")}<input type="text" class="fs-home" maxlength="300" value="${escapeHtml(r.home_address ?? "")}" placeholder="${t("fuel_home_placeholder")}" /></label>
            <input type="hidden" class="fs-lat" value="${r.home_lat ?? ""}" /><input type="hidden" class="fs-lng" value="${r.home_lng ?? ""}" />
            <div class="fuel-home-status muted">${r.home_lat != null ? `📍 ${t("fuel_home_saved")}` : t("fuel_home_missing")}</div>
            <div class="fuel-search-results"></div>
            <div class="sheet-actions"><button type="button" class="btn fs-search">${t("fuel_home_search")}</button><button type="button" class="btn btn-primary fs-save">${t("save")}</button></div>
            <p class="form-error fs-error" hidden></p>
          </div>`
          )
          .join("")}
      </div>
      <div class="sheet-actions"><button type="button" class="btn btn-primary" data-close>${t("fuel_done")}</button></div>`);
    overlay.querySelector("[data-close]").addEventListener("click", () => {
      overlay.remove();
      load({ quiet: true });
    });
    overlay.querySelector("#fuel-price-save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await api.setFuelPrice(month, Number(overlay.querySelector("#fuel-price").value));
        btn.textContent = `✓ ${t("fuel_saved")}`;
      } catch (err) {
        btn.textContent = err.message;
      }
    });
    overlay.querySelectorAll(".fuel-rep-settings").forEach((card) => {
      const lat = card.querySelector(".fs-lat");
      const lng = card.querySelector(".fs-lng");
      const home = card.querySelector(".fs-home");
      const results = card.querySelector(".fuel-search-results");
      const err = card.querySelector(".fs-error");
      const status = card.querySelector(".fuel-home-status");
      home.addEventListener("input", () => {
        // Editing the text invalidates the old pin until an address is picked again.
        lat.value = "";
        lng.value = "";
        status.textContent = t("fuel_home_pick");
      });
      const search = async () => {
        results.innerHTML = `<p class="muted">${t("loading")}</p>`;
        try {
          const found = await api.searchAddress(home.value);
          results.innerHTML = found.length ? found.map((f, i) => `<button type="button" class="fuel-result" data-i="${i}">${escapeHtml(f.address)}</button>`).join("") : `<p class="muted">${t("fuel_search_none")}</p>`;
          results.querySelectorAll(".fuel-result").forEach((btn) =>
            btn.addEventListener("click", () => {
              const f = found[Number(btn.dataset.i)];
              home.value = f.address;
              lat.value = f.lat;
              lng.value = f.lng;
              results.innerHTML = "";
              status.textContent = `📍 ${t("fuel_home_picked")}`;
            })
          );
        } catch (e2) {
          results.innerHTML = `<p class="form-error">${escapeHtml(e2.message)}</p>`;
        }
      };
      card.querySelector(".fs-search").addEventListener("click", search);
      home.addEventListener("keydown", (e) => e.key === "Enter" && search());
      card.querySelector(".fs-save").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        err.hidden = true;
        // An address typed but never picked from the list has no location yet.
        if (home.value && lat.value === "") {
          err.textContent = t("fuel_home_pick");
          err.hidden = false;
          return;
        }
        try {
          await api.setFuelUser(Number(card.dataset.user), {
            fuel_l_per_100km: card.querySelector(".fs-cons").value === "" ? null : Number(card.querySelector(".fs-cons").value),
            fuel_highway_l_per_100km: card.querySelector(".fs-cons-hwy").value === "" ? null : Number(card.querySelector(".fs-cons-hwy").value),
            home_address: home.value || null,
            home_lat: lat.value === "" ? null : Number(lat.value),
            home_lng: lng.value === "" ? null : Number(lng.value),
          });
          status.textContent = lat.value ? `📍 ${t("fuel_home_saved")}` : t("fuel_home_missing");
          btn.textContent = `✓ ${t("fuel_saved")}`;
        } catch (e3) {
          err.textContent = e3.message;
          err.hidden = false;
        }
      });
    });
    if (focus) {
      const target = focus.type === "price" ? overlay.querySelector("#fuel-price-box") : overlay.querySelector(`.fuel-rep-settings[data-user="${focus.id}"]`);
      target?.scrollIntoView({ block: "center" });
      target?.querySelector("input")?.focus({ preventScroll: true });
    }
  }

  setMonth(month);
}
