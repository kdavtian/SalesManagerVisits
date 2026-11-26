// The product card's Market section (owner, 2026-11-26; server reports/market/productMarket.js): how many visited shops had it in stock,
// the competitor equivalents of its line and volume with their median prices (per pack, as this card shows prices), how many customers
// wished for it, the litres a month our customers could use on its line, and, when it is out of stock, the sales it usually makes.
// Loaded after the card is drawn (never holds it up); the explanation sits under the "!" on the section title.
import { api } from "../../api.js";
import { t, getLang } from "../../i18n.js";
import { escapeHtml, formatDateDMY, openInfoPopup } from "../../util.js";
import { seesProductMarket } from "../../shared/roles.js";
import { nf } from "./common.js";

const signed = (p) => (p == null ? "" : `${p > 0 ? "+" : ""}${p}%`);
const gapClass = (p) => (p == null ? "" : p > 5 ? "mkt-gap-up" : p < -5 ? "mkt-gap-down" : "muted");
const row = (label, value) => `<div class="pd-row"><span class="muted">${escapeHtml(label)}</span><span class="pd-amount">${escapeHtml(value)}</span></div>`;

export function productMarketHtml(d) {
  if (!d) return "";
  const hy = getLang() === "hy";
  const parts = [];
  if (d.out_of_stock) {
    const o = d.out_of_stock;
    const lines = [
      o.since ? t("pm_out_since").replace("{date}", formatDateDMY(o.since)) : t("pm_out"),
      o.monthly_qty > 0 ? t("pm_out_sales").replace("{n}", nf(o.monthly_qty)).replace("{l}", o.litres ? ` (${nf(o.litres)} ${t("mkt_l")})` : "") : "",
      o.wish_customers ? t("pm_out_wishes").replace("{n}", nf(o.wish_customers)) : "",
    ].filter(Boolean);
    parts.push(`<div class="pm-alert" role="note"><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></div>`);
  }
  parts.push(row(t("pm_shelf"), d.shelf.on_shelf ? t("pm_shops_n").replace("{n}", nf(d.shelf.on_shelf)) : "—"));
  parts.push(row(t("pm_wishes"), d.wishes.customers ? t("pm_wishes_n").replace("{c}", nf(d.wishes.customers)).replace("{q}", nf(d.wishes.quantity)) : "—"));
  if (d.sales.monthly_qty > 0) parts.push(row(t("pm_sales"), t("pm_per_month").replace("{n}", nf(d.sales.monthly_qty))));
  if (d.line) {
    const l = d.line;
    parts.push(row(t("pm_potential").replace("{line}", hy ? l.name_hy : l.name_en), l.potential_litres ? `${nf(l.potential_litres)} ${l.unit === "kg" ? t("mkt_kg") : t("mkt_l")}` : "—"));
    if (l.competitors.length) {
      parts.push(`<p class="pm-sub muted">${escapeHtml(t("pm_competitors"))}</p>
        <div class="pm-comp pm-comp-head muted"><span></span><span>${escapeHtml(t("mkt_wholesale_short"))}</span><span>${escapeHtml(t("mkt_retail_short"))}</span></div>
        ${l.competitors
          .map(
            (c) => `<div class="pm-comp"><span>${escapeHtml(c.brand_name)}<small class="muted"> · ${escapeHtml(t("mkt_p_shops").replace("{n}", nf(c.shops)))}</small></span>
              <span class="mkt-num">${nf(c.wholesale)}<small class="${gapClass(c.gap_wholesale_pct)}">${signed(c.gap_wholesale_pct)}</small></span>
              <span class="mkt-num">${nf(c.retail)}<small class="${gapClass(c.gap_retail_pct)}">${signed(c.gap_retail_pct)}</small></span></div>`
          )
          .join("")}`);
    }
  }
  return `<div class="card pd-card pm-card">
      <div class="pm-head"><h3 class="pd-card-title">${escapeHtml(t("pm_title"))}</h3><button type="button" class="settings-hint-icon" id="pm-info" aria-label="${escapeHtml(t("more_info"))}">!</button></div>
      ${parts.join("")}
    </div>`;
}

// Fetch and keep the section; paint() is called whenever the card is drawn again. -> { html(), load(paint) }
export function productMarketSection(productId, role) {
  let data = null;
  return {
    html: () => productMarketHtml(data),
    async load(paint) {
      if (!seesProductMarket(role)) return;
      try {
        data = await api.getProductMarket(productId);
        paint();
      } catch {
        // the section is extra: the card stays as it is
      }
    },
    wire(container) {
      container.querySelector("#pm-info")?.addEventListener("click", () =>
        openInfoPopup(`<ul class="mkt-info">${["pm_info_1", "pm_info_2", "pm_info_3", "pm_info_4"].map((k) => `<li>${escapeHtml(t(k))}</li>`).join("")}</ul>`)
      );
    },
  };
}
