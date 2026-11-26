// Shared parts of the Market reports (owner, 2026-11-26): the report header with its "!" explanation, the freshness line every aggregate
// carries (latest date + how many shops it rests on), whole numbers, AMD per litre / kg, a brand / line / volume label.
import { t, getLang } from "./i18n.js";
import { escapeHtml, formatDateDMY, openInfoPopup } from "./util.js";
import { icons } from "./icons.js";

export const nf = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : Math.round(Number(n)).toLocaleString("en-US"));
export const pct = (part, whole) => (whole > 0 ? Math.round((100 * part) / whole) : null);
export const pctText = (p) => (p === null || p === undefined ? "—" : `${p}%`);

// "5W-30 PCMO" in the viewer's language; the line code when the catalogue does not know it
export const lineLabel = (e) => (getLang() === "hy" ? e.line_name_hy : e.line_name_en) || e.line_code || "";
// "4 L" / "0.5 kg"
export const volumeLabel = (volume, unit) => `${Number(volume).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit === "kg" ? t("mkt_kg") : t("mkt_l")}`;
// "1,250 / L"
export const perUnitLabel = (amount, unit) => (amount === null || amount === undefined ? "—" : `${nf(amount)}/${unit === "kg" ? t("mkt_kg") : t("mkt_l")}`);

// "Latest: 24-11-2026 · 18 shops" -- under every aggregate, so a number resting on one shop reads as such
export function freshnessHtml(meta) {
  if (!meta || !meta.entries) return `<p class="muted mkt-fresh">${escapeHtml(t("mkt_no_entries"))}</p>`;
  return `<p class="muted mkt-fresh">${escapeHtml(t("mkt_fresh").replace("{date}", formatDateDMY(meta.latest_at)).replace("{n}", nf(meta.shops)))}</p>`;
}

// The report header: back, title with its "!" (bullet lines, each a text key) on the left of the title like the other reports
export function marketHeaderHtml(titleKey) {
  return `
    <div class="detail-header report-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">${icons.chevronLeft}</button>
      <div class="detail-header-title">
        <div class="sales-heading-with-hint"><button type="button" class="settings-hint-icon" id="mkt-info" aria-label="${t("more_info")}">!</button><h1>${escapeHtml(t(titleKey))}</h1></div>
      </div>
    </div>`;
}

export function wireMarketHeader(root, navigate, infoKeys) {
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  root.querySelector("#mkt-info").addEventListener("click", () => openInfoPopup(`<ul class="mkt-info">${infoKeys.map((k) => `<li>${escapeHtml(t(k))}</li>`).join("")}</ul>`));
}
