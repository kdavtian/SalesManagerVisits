// The product lines of an Excel order, the same on every sheet that shows one (the customer card's order, the Sales screen's order):
// grouped by brand in the price-list order (Castrol, Lotos, Orlen, Royal, then the rest), each brand's products in the catalogue order
// (family, viscosity, spec, size: productSort.js), the pieces of each brand next to its name, and one total line at the bottom
// (owner, 2026-11-19: "Improve. Total pcs. Sort products").
import { t } from "./i18n.js";
import { escapeHtml, formatAmd, erpLineDiscountRowHtml } from "./util.js";
import { compareProducts, sortedBrands, FAMILY_PRIORITY } from "./productSort.js";

const qtyOf = (l) => (Number.isFinite(Number(l.qty)) ? Number(l.qty) : 0);
const pcs = (n) => `${Number(n).toLocaleString("en-US")} ${t("pcs_short")}`;
// the product line ("Edge", "Magnatec", ...) is the name's first word when it is one of the known lines
const familyOf = (name) => FAMILY_PRIORITY.find((f) => String(name ?? "").toLowerCase().startsWith(f.toLowerCase())) ?? "";
const asProduct = (l) => ({ name: l.product_name || "", brand: l.brand || "", family: familyOf(l.product_name), unit: l.size_l ? `${l.size_l}L` : "" });

/** -> { html, totalQty } */
export function erpOrderLinesHtml(lines, { totalAmd = null } = {}) {
  const other = t("erp_brand_unspecified");
  const byBrand = new Map();
  for (const line of lines ?? []) {
    const brand = line.brand || other;
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  const brands = sortedBrands([...byBrand.keys()].filter((b) => b !== other).map((brand) => ({ brand })));
  if (byBrand.has(other)) brands.push(other);
  let totalQty = 0;
  const sections = brands
    .map((brand) => {
      const list = [...byBrand.get(brand)].sort((a, b) => compareProducts(asProduct(a), asProduct(b)));
      const brandQty = list.reduce((s, l) => s + qtyOf(l), 0);
      totalQty += brandQty;
      return `<section class="erp-brand-group">
        <div class="erp-brand-head"><span class="proposed-changes-label">${escapeHtml(brand)}</span><span class="erp-brand-qty">${escapeHtml(pcs(brandQty))}</span></div>
        ${list
          .map(
            (l) => `
          <div class="erp-line-row">
            <span>${escapeHtml(l.product_name || "")}${l.size_l ? ` ${escapeHtml(String(l.size_l))}L` : ""}</span>
            <span class="muted">${escapeHtml(pcs(qtyOf(l)))}</span>
            <span>${formatAmd(l.unit_price_amd)}</span>
          </div>
          ${erpLineDiscountRowHtml(l)}`
          )
          .join("")}
      </section>`;
    })
    .join("");
  const totalRow = `<div class="erp-line-row erp-line-total">
      <span>${escapeHtml(t("total"))}</span>
      <span>${escapeHtml(pcs(totalQty))}</span>
      <span>${totalAmd == null ? "" : formatAmd(totalAmd)}</span>
    </div>`;
  return { html: `${sections}${lines?.length ? totalRow : ""}`, totalQty };
}
