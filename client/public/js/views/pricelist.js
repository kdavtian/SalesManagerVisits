import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { icons } from "../icons.js";

// Same brand ordering the order-creation flow uses, so the pricelist reads
// in the order a rep actually presents it to a customer.
const BRAND_PRIORITY = ["Castrol", "Lotos", "Royal"];

function sortedBrands(products) {
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
  return brands.sort((a, b) => {
    const pa = BRAND_PRIORITY.indexOf(a);
    const pb = BRAND_PRIORITY.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.localeCompare(b);
  });
}

const FAMILY_PRIORITY = ["Edge", "Magnatec", "GTX", "Vecton/CRB", "Engine oils", "Transmission oils", "Other"];

function sortProducts(products) {
  return [...products].sort((a, b) => {
    const fa = FAMILY_PRIORITY.indexOf(a.family ?? "Other");
    const fb = FAMILY_PRIORITY.indexOf(b.family ?? "Other");
    if (fa !== fb) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);
    return a.name.localeCompare(b.name);
  });
}

function numOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function renderPricelist(root, navigate) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let products;
  try {
    products = await api.listProducts();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const today = new Date().toLocaleDateString();
  const brands = sortedBrands(products);

  container.innerHTML = `
    <div class="detail-header pricelist-no-print">
      <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("pricelist_title")}</h1>
      </div>
      <button type="button" class="icon-btn" id="print-btn" aria-label="${t("print")}">${icons.print ?? "🖨️"}</button>
    </div>

    <div class="pricelist-doc">
      <div class="pricelist-doc-header">
        <div>
          <h1>${t("pricelist_title")}</h1>
          <p class="muted">${escapeHtml(today)}</p>
        </div>
        <div class="pricelist-rep-card">
          <strong>${escapeHtml(state.user.name)}</strong>
          ${state.user.position ? `<span>${escapeHtml(state.user.position)}</span>` : ""}
          <span>${escapeHtml(state.user.email)}</span>
        </div>
      </div>
      <p class="pricelist-legend">
        <span><strong>${t("price_standard")}</strong> &mdash; ${t("price_standard_hint")}</span>
        <span><strong>${t("price_special_period")}</strong> &mdash; ${t("price_special_period_hint")}</span>
        <span><strong>${t("price_retail")}</strong> &mdash; ${t("price_retail_hint")}</span>
      </p>
      ${brands
        .map((brand) => {
          const brandProducts = sortProducts(products.filter((p) => p.brand === brand));
          return `
          <h2 class="pricelist-brand-heading">${escapeHtml(brand)}</h2>
          <div class="pricelist-table-wrap">
          <table class="pricelist-table">
            <thead>
              <tr>
                <th>${t("product_name")}</th>
                <th>${t("unit")}</th>
                <th>${t("price_standard")}</th>
                <th>${t("price_special_period")}</th>
                <th>${t("price_retail")}</th>
              </tr>
            </thead>
            <tbody>
              ${brandProducts
                .map((p) => {
                  const standard = numOrNull(p.bronze_price_amd) ?? Number(p.unit_price_amd);
                  const promo = numOrNull(p.promo_price_amd);
                  return `
                  <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>${escapeHtml(p.unit ?? "")}</td>
                    <td>${formatAmd(standard)}</td>
                    <td>${promo !== null ? `<strong class="pricelist-promo">${formatAmd(promo)}</strong>` : "&mdash;"}</td>
                    <td>${formatAmd(Number(p.unit_price_amd))}</td>
                  </tr>
                `;
                })
                .join("")}
            </tbody>
          </table>
          </div>
        `;
        })
        .join("")}
    </div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  container.querySelector("#print-btn").addEventListener("click", () => window.print());
}
