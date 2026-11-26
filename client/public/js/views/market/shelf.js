// Reports > Shelf share (owner, 2026-11-26): of the visited shops with a fresh shelf record (<= 60 days, per brand group the latest visit
// that recorded it), the % carrying genuine Castrol and each competitor (numeric distribution) and the same weighted by the shops'
// monthly litres potential (weighted distribution); by region and sales channel; 6-month trend; the shops with fake or grey-imported
// Castrol, with "Show on map" (the map's Brands filter, picked). Server: reports/market/shelfShare.js.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml, formatDateDMY, regionLabelHy, channelDisplayLabel } from "../../util.js";
import { selectHtml } from "../reports/common.js";
import { competitorName } from "../../brandChips.js";
import { nf, pctText, freshnessHtml, marketHeaderHtml, wireMarketHeader } from "./common.js";

const SISTER = { lotos: "Lotos", royal: "Royal" };
const FLAG_CHIPS = ["castrol:fake", "castrol:imported_us", "castrol:imported_dubai", "castrol:imported_ru", "castrol:imported_other"];

export async function renderMarketShelf(root, navigate) {
  const filter = { region: "", channel: "" };
  let seq = 0;
  root.innerHTML = `
    <div class="detail-view mkt-view">
      ${marketHeaderHtml("report_market_shelf_name")}
      <form id="report-filters" class="report-filter-form mkt-filters"></form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  wireMarketHeader(root, navigate, ["mkt_s_info_1", "mkt_s_info_2", "mkt_s_info_3", "mkt_s_info_4"]);
  const form = root.querySelector("#report-filters");
  const body = root.querySelector("#report-body");

  const brandLabel = (b) =>
    b.key === "castrol" ? "Castrol" : b.key === "castrol_fake" ? t("chip_castrol_fake") : b.key === "castrol_grey" ? t("mkt_s_grey") : SISTER[b.key] ?? b.name ?? competitorName(b.key);
  const bar = (p, cls = "") => `<span class="mkt-bar ${cls}" aria-hidden="true"><span style="width:${Math.min(100, p ?? 0)}%"></span></span>`;
  const brandClass = (k) => (k === "castrol" ? "mkt-bar-ours" : k === "castrol_fake" || k === "castrol_grey" ? "mkt-bar-bad" : "");

  const brandRow = (b) => `
    <div class="mkt-share-row">
      <span class="mkt-row-main"><strong>${escapeHtml(brandLabel(b))}</strong><small class="muted">${escapeHtml(t("mkt_p_shops").replace("{n}", nf(b.shops)))}</small></span>
      <span class="mkt-num">${pctText(b.numeric_pct)}<small class="muted">${escapeHtml(t("mkt_s_weighted_short"))} ${pctText(b.weighted_pct)}</small></span>
      ${bar(b.numeric_pct, brandClass(b.key))}
    </div>`;

  const groupRows = (list, label) =>
    list.length
      ? `<div class="card mkt-list">${list
          .map(
            (g) => `
        <div class="mkt-row">
          <span class="mkt-row-main"><strong>${escapeHtml(label(g.key))}</strong>
            <small class="muted">${escapeHtml(
              [t("mkt_p_shops").replace("{n}", nf(g.shops)), g.top_competitor ? `${competitorName(g.top_competitor.key)} ${pctText(g.top_competitor.numeric_pct)}` : "", g.fake_grey ? `${t("mkt_s_fake_grey_short")} ${nf(g.fake_grey)}` : ""]
                .filter(Boolean)
                .join(" · ")
            )}</small>
          </span>
          <span class="mkt-num">Castrol ${pctText(g.castrol_pct)}<small class="muted">${escapeHtml(t("mkt_s_weighted_short"))} ${pctText(g.castrol_weighted_pct)}</small></span>
        </div>`
          )
          .join("")}</div>`
      : `<p class="empty-state">${escapeHtml(t("mkt_s_empty"))}</p>`;

  const trendHtml = (trend) => {
    const max = Math.max(1, ...trend.map((m) => m.castrol_pct ?? 0));
    return `<div class="card mkt-trend" role="img" aria-label="${escapeHtml(t("mkt_s_trend"))}">${trend
      .map(
        (m) => `<span class="mkt-trend-col"><small>${pctText(m.castrol_pct)}</small><span class="mkt-trend-bar"><span style="height:${Math.round(((m.castrol_pct ?? 0) / max) * 100)}%"></span></span><small class="muted">${escapeHtml(m.month.slice(5))}.${escapeHtml(m.month.slice(2, 4))}</small></span>`
      )
      .join("")}</div>`;
  };

  const flaggedRow = (f) => `
    <button type="button" class="mkt-row mkt-flag-row" data-cid="${f.customer_id}">
      <span class="mkt-row-main"><strong>${escapeHtml(f.name)}</strong>
        <small class="muted">${escapeHtml([f.region ? regionLabelHy(f.region) : "", f.rep_name, formatDateDMY(f.at)].filter(Boolean).join(" · "))}</small>
        <span class="mkt-flags">${f.values.map((v) => `<span class="badge ${v === "fake" ? "badge-danger" : "badge-warning"}">${escapeHtml(t(`chip_castrol_${v}`))}</span>`).join("")}</span>
      </span>
    </button>`;

  function renderFilters(d) {
    form.innerHTML = `
      ${selectHtml("region", [{ value: "", label: t("region") }, ...d.regions.map((r) => ({ value: r, label: regionLabelHy(r) }))], filter.region)}
      ${selectHtml("channel", [{ value: "", label: t("mkt_s_channel") }, ...d.channels.map((c) => ({ value: c, label: channelDisplayLabel(c) }))], filter.channel)}`;
  }

  async function load() {
    const my = ++seq;
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const d = await api.getMarketShelf(Object.fromEntries(Object.entries(filter).filter(([, v]) => v)));
      if (my !== seq) return;
      renderFilters(d);
      const castrol = d.totals.brands.find((b) => b.key === "castrol");
      const order = (b) => (b.key === "castrol" ? 0 : b.key === "castrol_fake" ? 1 : b.key === "castrol_grey" ? 2 : SISTER[b.key] ? 3 : 4);
      const brands = [...d.totals.brands].sort((a, b) => order(a) - order(b) || b.shops - a.shops);
      body.innerHTML = `
        <div class="card opp-totals">
          <div><span class="muted">${escapeHtml(t("mkt_s_shops"))}</span><strong>${nf(d.totals.shops)}</strong></div>
          <div><span class="muted">${escapeHtml(t("mkt_s_castrol_numeric"))}</span><strong>${pctText(castrol?.numeric_pct ?? (d.totals.shops ? 0 : null))}</strong></div>
          <div><span class="muted">${escapeHtml(t("mkt_s_castrol_weighted"))}</span><strong>${pctText(castrol?.weighted_pct ?? (d.totals.weighted_base ? 0 : null))}</strong></div>
          <div class="opp-gap"><span class="muted">${escapeHtml(t("mkt_s_fake_grey"))}</span><strong>${nf(d.flagged.length)}</strong></div>
        </div>
        ${freshnessHtml(d.meta)}
        <h2 class="section-title">${escapeHtml(t("mkt_s_trend"))}</h2>
        ${trendHtml(d.trend)}
        <h2 class="section-title">${escapeHtml(t("mkt_s_brands"))}</h2>
        ${brands.length ? `<div class="card mkt-list">${brands.map(brandRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("mkt_s_empty"))}</p>`}
        <h2 class="section-title">${escapeHtml(t("mkt_s_by_region"))}</h2>
        ${groupRows(d.by_region, (k) => (k ? regionLabelHy(k) : t("mkt_s_no_region")))}
        <h2 class="section-title">${escapeHtml(t("mkt_s_by_channel"))}</h2>
        ${groupRows(d.by_channel, (k) => (k ? channelDisplayLabel(k) : t("mkt_s_no_channel")))}
        <div class="mkt-section-head"><h2 class="section-title">${escapeHtml(t("mkt_s_fake_grey"))} <small class="muted">${nf(d.flagged.length)}</small></h2>
          ${d.flagged.length ? `<button type="button" class="btn btn-sm" id="mkt-map">${escapeHtml(t("mkt_s_on_map"))}</button>` : ""}</div>
        ${d.flagged.length ? `<div class="mkt-flag-list">${d.flagged.map(flaggedRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("mkt_s_no_fake"))}</p>`}`;
      body.querySelectorAll("[data-cid]").forEach((b) => b.addEventListener("click", () => navigate(`#/customers/${b.dataset.cid}`)));
      body.querySelector("#mkt-map")?.addEventListener("click", () => navigate(`#/map?brands=${FLAG_CHIPS.join(",")}`));
    } catch (err) {
      if (my !== seq) return;
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  form.addEventListener("change", () => {
    const f = new FormData(form);
    filter.region = f.get("region") || "";
    filter.channel = f.get("channel") || "";
    load();
  });
  await load();
}
