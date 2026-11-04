// Usage report (owner, 2026-11-03; admin only): which screens are opened most, how long people stay on them, which buttons are tapped.
// Data: GET /api/usage/report (system/usageAnalytics.js), only filled while the Settings switch is on.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateTime } from "../util.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const PERIODS = [7, 30, 90];

function duration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} ${t("usage_sec")}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${t("usage_min")}${s % 60 ? ` ${s % 60} ${t("usage_sec")}` : ""}`;
  return `${Math.floor(m / 60)} ${t("usage_hour")} ${m % 60} ${t("usage_min")}`;
}

export async function renderUsageReport(root, navigate) {
  let days = 30;
  root.innerHTML = `
    <div class="detail-view usage-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("usage_title")}</h1></div>
      </div>
      <div class="segmented" id="usage-period">${PERIODS.map((d) => `<button type="button" class="chip ${d === days ? "chip-active" : ""}" data-days="${d}">${fill("usage_days", { n: d })}</button>`).join("")}</div>
      <p class="form-error" id="usage-error" hidden></p>
      <section class="usage-speed" id="usage-speed" aria-live="polite"></section>
      <div id="usage-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/settings"));
  const body = root.querySelector("#usage-body");
  const errorEl = root.querySelector("#usage-error");

  async function load() {
    try {
      const r = await api.getUsageReport(days);
      errorEl.hidden = true;
      paint(r);
    } catch (err) {
      body.innerHTML = "";
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  function paint(r) {
    if (!r.events) {
      body.innerHTML = `<p class="empty-state">${t("usage_empty")}</p>`;
      return;
    }
    const maxTime = Math.max(1, ...r.pages.map((p) => p.total_seconds));
    const maxTaps = Math.max(1, ...r.taps.map((p) => p.taps));
    body.innerHTML = `
      <p class="muted">${fill("usage_summary", { people: r.people, events: r.events, since: formatDateTime(r.since) })}</p>
      <h2 class="section-title">${t("usage_pages")}</h2>
      <div class="card-list">${r.pages
        .map(
          (p) => `<div class="card usage-row"><div class="usage-line"><strong>${escapeHtml(p.target)}</strong><span>${duration(p.total_seconds)}</span></div>
            <span class="usage-bar"><span style="width:${Math.round((p.total_seconds / maxTime) * 100)}%"></span></span>
            <span class="muted">${fill("usage_page_meta", { visits: p.visits, avg: duration(p.avg_seconds), people: p.people })}</span></div>`
        )
        .join("")}</div>
      <h2 class="section-title">${t("usage_taps")}</h2>
      <div class="card-list">${r.taps
        .map(
          (p) => `<div class="card usage-row"><div class="usage-line"><strong>${escapeHtml(p.target)}</strong><span>${p.taps}</span></div>
            <span class="usage-bar"><span style="width:${Math.round((p.taps / maxTaps) * 100)}%"></span></span>
            <span class="muted">${fill("usage_tap_meta", { people: p.people })}</span></div>`
        )
        .join("")}</div>`;
  }

  root.querySelectorAll("#usage-period [data-days]").forEach((b) =>
    b.addEventListener("click", () => {
      days = Number(b.dataset.days);
      root.querySelectorAll("#usage-period .chip").forEach((c) => c.classList.toggle("chip-active", c === b));
      load();
    })
  );
  loadSpeed(root.querySelector("#usage-speed"));
  await load();
}

// Slowest screens (owner, 2026-11-04: "measure every tap"): tap-to-screen time on the real phones, last 7 days (GET /api/perf/slow-screens,
// system/navTimings.js). Always measured, whatever the usage switch says; only the screen's kind, never who.
const ms = (v) => `${Math.round(Number(v) || 0)} ms`;
async function loadSpeed(slot) {
  let r;
  try {
    r = await api.getSlowScreens(7);
  } catch {
    slot.hidden = true;
    return;
  }
  const head = `<h2 class="section-title">${t("perf_slow_title")}</h2><p class="muted">${t("perf_slow_hint")}</p>`;
  if (!r.screens?.length) {
    slot.innerHTML = `${head}<p class="empty-state">${t("perf_slow_none")}</p>`;
    return;
  }
  const slow = (v) => (v > 1000 ? " perf-bad" : v > 300 ? " perf-warn" : "");
  slot.innerHTML = `${head}
    <div class="perf-table-wrap"><table class="perf-table">
      <thead><tr><th>${t("perf_col_screen")}</th><th class="num">p50</th><th class="num">p75</th><th class="num">p95</th><th class="num">${t("perf_col_samples")}</th></tr></thead>
      <tbody>${r.screens
        .map(
          (row) => `<tr><td class="perf-route">${escapeHtml(row.route)}</td><td class="num">${ms(row.p50)}</td><td class="num${slow(row.p75)}">${ms(row.p75)}</td><td class="num${slow(row.p95)}">${ms(row.p95)}</td><td class="num">${row.samples}</td></tr>`
        )
        .join("")}</tbody>
    </table></div>
    ${
      r.slowTaps?.length
        ? `<h3 class="perf-sub">${t("perf_slow_taps")}</h3><div class="perf-table-wrap"><table class="perf-table"><tbody>${r.slowTaps
            .map((row) => `<tr><td class="perf-route">${escapeHtml(row.route)}</td><td class="num">${ms(row.p75)}</td><td class="num">${row.samples}</td></tr>`)
            .join("")}</tbody></table></div>`
        : ""
    }`;
}
