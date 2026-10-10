// Weekly scorecard per sales rep and the new-customer pipeline (server: scorecard.js,
// routes/bizReports.js). Both are plain read-only report pages.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateDMY } from "../util.js";
import { t } from "../i18n.js";

const BACK_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;

function shell(root, navigate, titleKey, extra = "") {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">${BACK_SVG}</button>
        <div class="detail-header-title"><h1>${t(titleKey)}</h1></div>
      </div>
      ${extra}
      <div id="biz-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  return root.querySelector("#biz-body");
}

const shiftDays = (dateStr, days) => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

function metric(label, value, sub = "") {
  return `<div style="min-width:46%;flex:1"><div class="muted" style="font-size:0.8em">${label}</div><div style="font-weight:600;font-size:1.05em">${value}</div>${sub ? `<div class="muted" style="font-size:0.8em">${sub}</div>` : ""}</div>`;
}

export async function renderWeeklyScorecard(root, navigate) {
  let week = new Date().toISOString().slice(0, 10);
  const controls = `
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0">
      <button type="button" class="icon-btn" id="week-prev" aria-label="${t("scorecard_prev_week")}">&lsaquo;</button>
      <strong id="week-label" style="flex:1;text-align:center"></strong>
      <button type="button" class="icon-btn" id="week-next" aria-label="${t("scorecard_next_week")}">&rsaquo;</button>
    </div>`;
  const body = shell(root, navigate, "report_weekly_scorecard_name", controls);
  const label = root.querySelector("#week-label");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const card = await api.getScorecard(week);
      label.textContent = `${formatDateDMY(card.from)} – ${formatDateDMY(card.to)}`;
      if (!card.reps.length) {
        body.innerHTML = `<p class="muted">${t("scorecard_none")}</p>`;
        return;
      }
      body.innerHTML = card.reps
        .map((r) => {
          const conv = r.conversion_pct === null ? "—" : `${r.conversion_pct}%`;
          return `
        <div class="card" style="margin-bottom:12px">
          <strong>${escapeHtml(r.name)}</strong>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
            ${metric(t("scorecard_visits"), r.visits, `${r.customers_visited} ${t("scorecard_customers")}`)}
            ${metric(t("scorecard_conversion"), conv, t("scorecard_conversion_hint"))}
            ${metric(t("scorecard_orders"), r.orders, formatAmd(r.orders_amd))}
            ${metric(t("scorecard_collected"), formatAmd(r.collected_amd))}
            ${metric(t("scorecard_visit_length"), r.avg_visit_minutes == null ? "—" : `${r.avg_visit_minutes} ${t("scorecard_min")}`)}
            ${metric(t("scorecard_debt_tasks"), `${r.debt_tasks_open} ${t("scorecard_open")}`, `${t("scorecard_paid")} ${r.debt_paid} · ${t("scorecard_promised")} ${r.debt_promised} · ${t("scorecard_failed")} ${r.debt_failed}`)}
          </div>
        </div>`;
        })
        .join("");
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  root.querySelector("#week-prev").addEventListener("click", () => {
    week = shiftDays(week, -7);
    load();
  });
  root.querySelector("#week-next").addEventListener("click", () => {
    week = shiftDays(week, 7);
    load();
  });
  load();
}

export async function renderCustomerPipeline(root, navigate) {
  const body = shell(root, navigate, "report_customer_pipeline_name");
  try {
    const { waiting, funnel } = await api.getCustomerPipeline();
    const pct = (n) => (funnel.created ? `${Math.round((n / funnel.created) * 100)}%` : "—");
    body.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <strong>${t("pipeline_funnel_title")}</strong>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
          ${metric(t("pipeline_created"), funnel.created)}
          ${metric(t("pipeline_with_erp"), funnel.with_erp_id, pct(funnel.with_erp_id))}
          ${metric(t("pipeline_ordered"), funnel.ordered, pct(funnel.ordered))}
        </div>
      </div>
      <h3 class="list-group-heading">${t("pipeline_waiting_title")} (${waiting.length})</h3>
      ${
        waiting.length
          ? waiting
              .map(
                (c) => `
        <button type="button" class="card" data-customer="${c.id}" style="display:block;width:100%;text-align:left;min-height:44px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <strong>${escapeHtml(c.name)}</strong>
            <span class="badge ${c.age_days >= 3 ? "badge-danger" : "badge-neutral"}">${c.age_days} ${t("pipeline_days")}</span>
          </div>
          <div class="muted" style="font-size:0.85em">${[c.manager_name, c.created_by_name, c.region].filter(Boolean).map(escapeHtml).join(" · ")}</div>
          ${c.draft_orders ? `<div style="font-size:0.85em">${t("pipeline_draft_orders")}: ${c.draft_orders} · ${formatAmd(c.draft_amd)}</div>` : ""}
        </button>`
              )
              .join("")
          : `<p class="muted">${t("pipeline_none")}</p>`
      }`;
    body.querySelectorAll("[data-customer]").forEach((el) => el.addEventListener("click", () => navigate(`#/customers/${el.dataset.customer}`)));
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}
