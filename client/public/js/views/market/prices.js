// Reports > Competitor prices (owner, 2026-11-26): per product line and volume, each competitor brand's median wholesale and retail per
// litre (kg) over the last 90 days (clean entries only), beside our matching Castrol products per tier; gap % (+ = we are dearer than the
// brand), the shop's margin per brand vs the margin our recommended retail leaves, a 6-month trend line, and the brands whose price fell
// > 5 % in a month (the list admin / CEO also get as a notification). Server: reports/market/priceIndex.js.
import { api } from "../../api.js";
import { t, getLang, hasText } from "../../i18n.js";
import { escapeHtml } from "../../util.js";
import { nf, volumeLabel, freshnessHtml, marketHeaderHtml, wireMarketHeader } from "./common.js";

const per = (amount, volume) => (amount == null || !(volume > 0) ? null : Math.round(amount / volume));
const signed = (p) => (p == null ? "" : `${p > 0 ? "+" : ""}${p}%`);
// + = we are dearer: a risk when the gap is wide
const gapClass = (p) => (p == null ? "" : p > 5 ? "mkt-gap-up" : p < -5 ? "mkt-gap-down" : "muted");

// a small line of the monthly medians (wholesale, else retail); nothing with fewer than two months
export function sparkline(trend) {
  const kind = trend.some((m) => m.wholesale != null) ? "wholesale" : "retail";
  const pts = trend.map((m, i) => [i, m[kind]]).filter(([, v]) => v != null);
  if (pts.length < 2) return `<span class="mkt-spark" aria-hidden="true"></span>`;
  const vals = pts.map(([, v]) => v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const w = 40;
  const h = 14;
  const x = (i) => (i / Math.max(1, trend.length - 1)) * w;
  const y = (v) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  return `<svg class="mkt-spark" viewBox="-1 -1 ${w + 2} ${h + 2}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" /></svg>`;
}

export async function renderMarketPrices(root, navigate) {
  let data = null;
  let group = "";
  root.innerHTML = `
    <div class="detail-view mkt-view">
      ${marketHeaderHtml("report_market_prices_name")}
      <div class="vol-chips" id="mkt-groups"></div>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  wireMarketHeader(root, navigate, ["mkt_p_info_1", "mkt_p_info_2", "mkt_p_info_3", "mkt_p_info_4", "mkt_p_info_5"]);
  const body = root.querySelector("#report-body");
  const chips = root.querySelector("#mkt-groups");
  const hy = getLang() === "hy";
  const lineName = (g) => (hy ? g.line_name_hy : g.line_name_en) || g.line_code;
  const unitShort = (u) => (u === "kg" ? t("mkt_kg") : t("mkt_l"));

  const dropsHtml = (list, titleKey) =>
    list.length
      ? `<div class="card mkt-drops"><strong>${escapeHtml(t(titleKey))}</strong><ul>${list
          .map(
            (d) =>
              `<li>${escapeHtml(`${d.brand_name} · ${hy ? d.line_name_hy : d.line_name_en} · ${volumeLabel(d.volume, d.unit)}: ${t(d.kind === "wholesale" ? "mkt_wholesale_short" : "mkt_retail_short")} ${nf(d.before)} → ${nf(d.after)}`)} <span class="mkt-gap-down">${d.change_pct}%</span></li>`
          )
          .join("")}</ul></div>`
      : "";

  const oursHtml = (g) =>
    g.ours
      .map(
        (p) => `
      <div class="mkt-ours">
        <span class="mkt-row-main"><strong>${escapeHtml(p.name)}</strong>
          <small class="muted">${escapeHtml(
            [
              [t("mkt_tier_bronze"), p.bronze],
              [t("mkt_tier_silver"), p.silver],
              [t("mkt_tier_gold"), p.gold],
            ]
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k} ${nf(per(v, g.volume))}`)
              .join(" · ")
          )}</small>
          ${p.margin_bronze != null ? `<small class="muted">${escapeHtml(t("mkt_p_our_margin").replace("{amd}", nf(per(p.margin_bronze, g.volume))).replace("{pct}", String(p.margin_pct ?? "—")))}</small>` : ""}
        </span>
        <span class="mkt-nums"><strong>${nf(per(p.retail, g.volume))}</strong><small class="muted">${escapeHtml(t("mkt_retail_short"))}/${unitShort(g.unit)}</small></span>
      </div>`
      )
      .join("");

  const brandHtml = (g, b) => `
    <div class="mkt-brand">
      <span class="mkt-row-main"><strong>${escapeHtml(b.brand_name)}</strong>
        <small class="muted">${escapeHtml(
          [b.margin != null ? t("mkt_p_margin").replace("{amd}", nf(per(b.margin, g.volume))).replace("{pct}", String(b.margin_pct ?? "—")) : "", t("mkt_p_shops").replace("{n}", nf(b.meta.shops))].filter(Boolean).join(" · ")
        )}</small>
      </span>
      ${sparkline(b.trend)}
      <span class="mkt-num">${nf(per(b.wholesale, g.volume))}<small class="${gapClass(b.gap_wholesale_pct)}">${signed(b.gap_wholesale_pct)}</small></span>
      <span class="mkt-num">${nf(per(b.retail, g.volume))}<small class="${gapClass(b.gap_retail_pct)}">${signed(b.gap_retail_pct)}</small></span>
    </div>`;

  const groupHtml = (g) => `
    <section class="card mkt-group">
      <h3>${escapeHtml(`${lineName(g)} · ${volumeLabel(g.volume, g.unit)}`)}</h3>
      ${freshnessHtml(g.meta)}
      ${g.ours.length ? oursHtml(g) : `<p class="muted mkt-none">${escapeHtml(t("mkt_p_no_ours"))}</p>`}
      <div class="mkt-brand mkt-brand-head muted"><span>${escapeHtml(t("mkt_p_brand"))}</span><span></span><span class="mkt-num">${escapeHtml(t("mkt_wholesale_short"))}/${unitShort(g.unit)}</span><span class="mkt-num">${escapeHtml(t("mkt_retail_short"))}/${unitShort(g.unit)}</span></div>
      ${g.brands.map((b) => brandHtml(g, b)).join("")}
    </section>`;

  function render() {
    const groups = [...new Set(data.groups.map((g) => g.group_key).filter(Boolean))];
    chips.innerHTML =
      groups.length > 1
        ? [["", t("mkt_all")], ...groups.map((k) => [k, hasText(`mkt_group_${k}`) ? t(`mkt_group_${k}`) : hasText(`vp_group_${k}`) ? t(`vp_group_${k}`) : k])]
            .map(([k, label]) => `<button type="button" class="map-filter-chip ${group === k ? "chip-active" : ""}" data-g="${k}" aria-pressed="${group === k}">${escapeHtml(label)}</button>`)
            .join("")
        : "";
    chips.querySelectorAll("[data-g]").forEach((b) =>
      b.addEventListener("click", () => {
        group = b.dataset.g;
        render();
      })
    );
    const shown = data.groups.filter((g) => !group || g.group_key === group);
    body.innerHTML = `
      ${dropsHtml(data.drops.last_month, "mkt_p_drops_last")}${dropsHtml(data.drops.this_month, "mkt_p_drops_this")}
      ${freshnessHtml(data.meta)}
      ${shown.length ? shown.map(groupHtml).join("") : `<p class="empty-state">${escapeHtml(t("mkt_p_empty"))}</p>`}`;
  }

  try {
    data = await api.getMarketPrices();
    render();
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}
