// The single source of truth for what a product actually costs right now.
// Every surface that shows or exports a price -- the catalog API, the
// pricelist page, the PDF/print view, the Excel export -- must go through
// this function rather than recomputing the "is a promo active" logic
// itself. Two call sites disagreeing about whether today falls inside a
// promo's date range is exactly the kind of bug that erodes trust in a
// document a rep hands to a customer.

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// `product` is a row from the products table. `activePromo`, if given, is
// a product_promos row already known to cover `asOf` (callers that fetch
// many products at once -- e.g. the catalog list -- resolve this via a
// single SQL LATERAL join rather than calling this per-row with a
// separate query; see routes/products.js).
export function getEffectiveProductPricing(product, activePromo = null, asOf = new Date()) {
  const standard = toNumberOrNull(product.bronze_price_amd) ?? toNumberOrNull(product.unit_price_amd);
  const retail = toNumberOrNull(product.retail_price_amd) ?? toNumberOrNull(product.unit_price_amd);

  let promo = activePromo;
  if (promo && !isPromoActive(promo, asOf)) promo = null;

  return {
    standard,
    retail,
    special: promo ? toNumberOrNull(promo.promo_price_amd) : null,
    specialValidFrom: promo ? dateOnly(promo.starts_on) : null,
    specialValidTo: promo ? dateOnly(promo.ends_on) : null,
  };
}

export function isPromoActive(promo, asOf = new Date()) {
  const today = dateOnly(asOf);
  return dateOnly(promo.starts_on) <= today && today <= dateOnly(promo.ends_on);
}

// Postgres DATE columns round-trip through the driver/JSON as a full ISO
// timestamp ("2026-09-01T00:00:00.000Z") or, given a plain JS Date, in
// local time -- normalize everything to a YYYY-MM-DD string so date-only
// comparisons never get tripped up by a timezone offset.
export function dateOnly(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
