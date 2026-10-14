// Progress by reps (Home progress card -> tap). Reps are the COLUMNS and the metrics the ROWS, so one metric can be
// compared across everybody at a glance; the best value of each row is highlighted and a Total column closes the table.
// Metrics: visits, check-ins, customers; payments (count, amount, % of visits); orders (count, amount, % of visits,
// liters, average order); hours worked (first to last check-in of each day, rounded UP to 0.25 h). Under it, the same
// hours day by day.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, groupDigits } from "../util.js";

const PERIODS = ["today", "week", "last_week", "month"];
const PERIOD_KEY = { today: "rp_today", week: "rp_week", last_week: "rp_last_week", month: "rp_month" };

const hoursLabel = (h) => (h ? `${Number(h.toFixed(2))}` : "0");
const pctLabel = (v) => (v == null ? "–" : `${v}%`);
const shortName = (name) => {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
};

// [section title key, [row key, label key, per-rep value, total from all reps, formatter]]
function metricRows() {
  const sum = (reps, k) => reps.reduce((s, r) => s + r[k], 0);
  const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
  return [
    ["rp_sec_visits", [
      ["visits", "rp_visits", (r) => r.visits, (rs) => sum(rs, "visits"), String],
      ["checkins", "rp_checkins", (r) => r.checkins, (rs) => sum(rs, "checkins"), String],
      ["customers", "rp_customers", (r) => r.customers_visited, (rs) => sum(rs, "customers_visited"), String],
    ]],
    ["rp_sec_payments", [
      ["pay_n", "rp_payments_qty", (r) => r.payments_count, (rs) => sum(rs, "payments_count"), String],
      ["pay_amd", "rp_payments_amount", (r) => r.payments_amd, (rs) => sum(rs, "payments_amd"), groupDigits],
      ["pay_pct", "rp_pct_of_visits", (r) => r.payments_pct_of_visits, (rs) => ratio(sum(rs, "payments_count"), sum(rs, "visits")), pctLabel],
    ]],
    ["rp_sec_orders", [
      ["ord_n", "rp_orders_qty", (r) => r.orders_count, (rs) => sum(rs, "orders_count"), String],
      ["ord_amd", "rp_orders_amount", (r) => r.orders_amd, (rs) => sum(rs, "orders_amd"), groupDigits],
      ["ord_pct", "rp_pct_of_visits", (r) => r.orders_pct_of_visits, (rs) => ratio(sum(rs, "orders_count"), sum(rs, "visits")), pctLabel],
      ["liters", "rp_liters", (r) => r.liters, (rs) => Math.round(sum(rs, "liters") * 10) / 10, (v) => groupDigits(v)],
      ["avg_order", "rp_avg_order", (r) => (r.orders_count ? Math.round(r.orders_amd / r.orders_count) : 0), (rs) => (sum(rs, "orders_count") ? Math.round(sum(rs, "orders_amd") / sum(rs, "orders_count")) : 0), groupDigits],
    ]],
    ["rp_sec_time", [
      ["hours", "rp_hours", (r) => r.hours, (rs) => sum(rs, "hours"), hoursLabel],
      ["days", "rp_days_worked", (r) => r.days_worked, (rs) => sum(rs, "days_worked"), String],
      ["avg_h", "rp_avg_hours", (r) => r.avg_hours_per_day, (rs) => (sum(rs, "days_worked") ? sum(rs, "hours") / sum(rs, "days_worked") : 0), hoursLabel],
    ]],
  ];
}

export async function renderRepProgress(root, navigate) {
  let period = "week";
  root.innerHTML = `
    <div class="detail-view rp-view">
      <div class="detail-header oc-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title oc-title"><h1>${t("rp_title")}</h1></div>
      </div>
      <div class="oc-chips" id="rp-periods" role="group" aria-label="${t("rp_title")}">
        ${PERIODS.map((p) => `<button type="button" class="map-filter-chip${p === period ? " chip-active" : ""}" data-period="${p}" aria-pressed="${p === period}">${t(PERIOD_KEY[p])}</button>`).join("")}
      </div>
      <p class="muted rp-range" id="rp-range"></p>
      <div id="rp-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => history.back());
  const bodyEl = root.querySelector("#rp-body");
  let loadToken = 0;

  async function load() {
    const token = ++loadToken;
    bodyEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    let data;
    try {
      data = await api.getRepProgress(period);
    } catch (err) {
      if (token === loadToken) bodyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (token !== loadToken) return; // a newer period was picked meanwhile
    paint(data);
  }

  function paint(data) {
    const { reps, days } = data;
    root.querySelector("#rp-range").textContent = data.from_day === data.last_day ? data.from_day : `${data.from_day} – ${data.last_day}`;
    if (!reps.length) {
      bodyEl.innerHTML = `<p class="empty-state">${t("rp_no_reps")}</p>`;
      return;
    }
    // The Total column comes right after the metric names, so it is on screen without scrolling sideways.
    const head = `<tr><th class="rp-metric"></th><th class="rp-col rp-total">${t("total")}</th>${reps
      .map((r) => `<th class="rp-col"><button type="button" class="rp-rep-link" data-rep="${r.user_id}" title="${escapeHtml(r.name)}">${escapeHtml(shortName(r.name))}</button></th>`)
      .join("")}</tr>`;
    const rows = metricRows()
      .map(([secKey, list]) => {
        const body = list
          .map(([, labelKey, value, total, fmt]) => {
            const values = reps.map(value);
            // highlight the leader of the row, but not when everybody is level
            const best = reps.length > 1 && Math.max(...values.map((v) => v ?? -1)) > Math.min(...values.map((v) => v ?? -1)) ? Math.max(...values.map((v) => v ?? -1)) : -1;
            const cells = values
              .map((v) => {
                const empty = v == null || v === 0;
                return `<td class="rp-num${!empty && v === best ? " rp-best" : ""}${empty ? " rp-zero" : ""}">${v == null ? "–" : v === 0 ? "0" : fmt(v)}</td>`;
              })
              .join("");
            const tot = total(reps);
            return `<tr><th class="rp-metric" scope="row">${t(labelKey)}</th><td class="rp-num rp-total">${tot == null ? "–" : fmt(tot)}</td>${cells}</tr>`;
          })
          .join("");
        return `<tr class="rp-section"><th colspan="${reps.length + 2}">${t(secKey)}</th></tr>${body}`;
      })
      .join("");

    const dayRows = days
      .map((d) => {
        const cells = reps.map((r) => `<td class="rp-num${r.hours_by_day[d] ? "" : " rp-zero"}">${r.hours_by_day[d] ? hoursLabel(r.hours_by_day[d]) : "–"}</td>`).join("");
        const dayTotal = reps.reduce((s, r) => s + (r.hours_by_day[d] ?? 0), 0);
        const label = new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
        return `<tr><th class="rp-metric" scope="row">${label}</th><td class="rp-num rp-total">${dayTotal ? hoursLabel(dayTotal) : "–"}</td>${cells}</tr>`;
      })
      .join("");

    bodyEl.innerHTML = `
      <div class="rp-table-wrap"><table class="rp-table">${head}${rows}</table></div>
      <p class="muted rp-note">${t("rp_note")}</p>
      ${
        days.length > 1
          ? `<h2 class="section-title">${t("rp_hours_by_day")}</h2>
             <div class="rp-table-wrap"><table class="rp-table">${head}${dayRows}</table></div>`
          : ""
      }`;
    bodyEl.querySelectorAll("[data-rep]").forEach((btn) => btn.addEventListener("click", () => navigate(`#/team-performance?manager=${btn.dataset.rep}`)));
  }

  root.querySelectorAll("[data-period]").forEach((btn) =>
    btn.addEventListener("click", () => {
      period = btn.dataset.period;
      root.querySelectorAll("[data-period]").forEach((b) => {
        b.classList.toggle("chip-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      load();
    })
  );
  load();
}
