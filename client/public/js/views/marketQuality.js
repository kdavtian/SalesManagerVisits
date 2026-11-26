// Reports > Market data quality (owner, 2026-11-26: "the data reps record is not usable yet"). Per rep: share of visits that recorded the
// shelf, share with a competitor price, price entries flagged as outliers (retail below wholesale, 3x off the median), and one score;
// weakest first, so management knows whom to coach. Below: the flagged entries themselves (tap = the shop). Rules: server
// reports/market/priceRules.js.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY } from "../util.js";
import { periodTabsHtml } from "./reports/common.js";
import { nf, pct, pctText, lineLabel, volumeLabel, perUnitLabel, freshnessHtml, marketHeaderHtml, wireMarketHeader } from "../marketCommon.js";

const scoreClass = (s) => (s === null || s === undefined ? "" : s >= 70 ? "mkt-score-good" : s >= 40 ? "mkt-score-mid" : "mkt-score-low");
const scoreHtml = (s) => `<span class="mkt-score ${scoreClass(s)}" aria-label="${escapeHtml(t("mkt_q_score"))}">${s === null || s === undefined ? "—" : s}</span>`;

export async function renderMarketQuality(root, navigate) {
  const periods = ["30", "90", "365"].map((d) => ({ value: d, label: t(`mkt_days_${d}`) }));
  root.innerHTML = `
    <div class="detail-view mkt-view">
      ${marketHeaderHtml("report_market_quality_name")}
      <form id="report-filters" class="report-filter-form">${periodTabsHtml("days", periods, "30")}</form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  wireMarketHeader(root, navigate, ["mkt_q_info_1", "mkt_q_info_2", "mkt_q_info_3", "mkt_q_info_4"]);
  const form = root.querySelector("#report-filters");
  const body = root.querySelector("#report-body");
  let seq = 0;

  const repRow = (r) => `
    <div class="mkt-row">
      <span class="mkt-row-main"><strong>${escapeHtml(r.rep_name || "—")}</strong>
        <small class="muted">${escapeHtml(
          [
            `${t("mkt_q_visits")} ${nf(r.visits)}`,
            `${t("mkt_q_shelf")} ${pctText(pct(r.shelf_visits, r.visits))}`,
            `${t("mkt_q_prices")} ${pctText(pct(r.price_visits, r.visits))}`,
            r.flagged_entries ? `${t("mkt_q_flagged")} ${nf(r.flagged_entries)}/${nf(r.price_entries)}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        )}</small>
      </span>
      ${scoreHtml(r.score)}
    </div>`;

  const flaggedRow = (e) => `
    <button type="button" class="mkt-row mkt-flag-row" data-cid="${e.customer_id}">
      <span class="mkt-row-main"><strong>${escapeHtml(`${e.brand_name} · ${lineLabel(e)} · ${volumeLabel(e.volume, e.unit)}`)}</strong>
        <small class="muted">${escapeHtml([e.customer_name, e.rep_name, formatDateDMY(e.recorded_at)].filter(Boolean).join(" · "))}</small>
        <span class="mkt-flags">${e.flags.map((f) => `<span class="badge badge-danger">${escapeHtml(t(`mkt_flag_${f}`))}</span>`).join("")}</span>
      </span>
      <span class="mkt-nums">
        <span>${escapeHtml(t("mkt_wholesale_short"))} ${escapeHtml(perUnitLabel(e.wholesale_per_unit, e.unit))}</span>
        <span>${escapeHtml(t("mkt_retail_short"))} ${escapeHtml(perUnitLabel(e.retail_per_unit, e.unit))}</span>
      </span>
    </button>`;

  async function load() {
    const my = ++seq;
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const d = await api.getMarketQuality({ days: new FormData(form).get("days") });
      if (my !== seq) return;
      const tot = d.totals;
      body.innerHTML = `
        <div class="card opp-totals">
          <div><span class="muted">${escapeHtml(t("mkt_q_score"))}</span><strong class="${scoreClass(tot.score)}">${tot.score ?? "—"}</strong></div>
          <div><span class="muted">${escapeHtml(t("mkt_q_visits"))}</span><strong>${nf(tot.visits)}</strong></div>
          <div><span class="muted">${escapeHtml(t("mkt_q_shelf"))}</span><strong>${pctText(pct(tot.shelf_visits, tot.visits))}</strong></div>
          <div><span class="muted">${escapeHtml(t("mkt_q_prices"))}</span><strong>${pctText(pct(tot.price_visits, tot.visits))}</strong></div>
        </div>
        ${freshnessHtml(d.meta)}
        <h2 class="section-title">${escapeHtml(t("mkt_q_by_rep"))}</h2>
        ${d.reps.length ? `<div class="card mkt-list">${d.reps.map(repRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("mkt_q_no_visits"))}</p>`}
        <h2 class="section-title">${escapeHtml(t("mkt_q_flagged_title"))} <small class="muted">${nf(tot.flagged_entries)}</small></h2>
        ${d.flagged.length ? `<div class="mkt-flag-list">${d.flagged.map(flaggedRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("mkt_q_no_flags"))}</p>`}`;
      body.querySelectorAll("[data-cid]").forEach((b) => b.addEventListener("click", () => navigate(`#/customers/${b.dataset.cid}`)));
    } catch (err) {
      if (my !== seq) return;
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  form.addEventListener("change", load);
  await load();
}
