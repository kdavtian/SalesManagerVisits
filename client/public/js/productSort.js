// Canonical product display order, shared by every screen that lists
// products (Pricelist, Order creation, Warehouse Inventory, Product
// Catalog admin) -- one comparator instead of each screen inventing (or,
// worse, half-duplicating) its own, so a priority-list change only has
// to be made once and every screen stays in sync.
//
// Order: brand -> product family -> viscosity grade -> specification
// (ACEA C1-C5/A-B combos, "LL", etc. -- e.g. "0W-20 C5" before "0W-20 LL")
// -> container size (liters, ascending) -> name, matching how a rep
// actually walks a customer through the pricelist. A brand/family/
// viscosity/spec value not in its priority list falls back to
// alphabetical, placed after every known value in that list. Non-oil
// products (no parseable viscosity grade in the name -- brake pads,
// filters, etc.) sort as one alphabetical block after every oil, since
// brand/family/viscosity/spec priority doesn't apply to them.

export const BRAND_PRIORITY = ["Castrol", "Lotos", "Orlen", "Royal"];

export const FAMILY_PRIORITY = ["Edge", "Magnatec", "GTX", "CRB", "Vecton"];

// 10W-60 is priced and presented like the 0W-* grades, not where a
// numeric-then-alpha viscosity sort would otherwise place it -- hence
// it's out of ascending order here, right after 0W-40.
export const VISCOSITY_PRIORITY = [
  "0W-8",
  "0W-16",
  "0W-20",
  "0W-30",
  "0W-40",
  "10W-60",
  "5W-20",
  "5W-30",
  "5W-40",
  "10W-40",
  "15W-40",
];

// ACEA (and similar) oil specification, in the order Castrol's own
// literature lists them -- C-series ascending, then the older A/B combos,
// then E (heavy-duty diesel), with "LL" (VW Longlife -- broader/older
// than a C-series spec) last, matching a spec like "0W-20 C5" outranking
// "0W-20 LL" at the same viscosity.
export const SPEC_PRIORITY = ["C1", "C2", "C3", "C4", "C5", "A1/B1", "A3/B3", "A3/B4", "A5/B5", "E4", "E6", "E7", "E9", "LL"];

// Ranked values (found in `list`) always sort before unranked ones; among
// values sharing a rank tier (both ranked with the same index -- only
// possible for exact duplicates -- or both unranked), fall back to
// alphabetical so the tier is still fully ordered.
function compareTier(list, a, b) {
  const ra = list.findIndex((v) => v.toLowerCase() === (a || "").toLowerCase());
  const rb = list.findIndex((v) => v.toLowerCase() === (b || "").toLowerCase());
  if (ra !== -1 || rb !== -1) return (ra === -1 ? Infinity : ra) - (rb === -1 ? Infinity : rb);
  return (a || "").localeCompare(b || "");
}

// Matches "0w20", "0W-20", "0 w 20", etc. inside a product name and
// normalizes it to the "0W-20" form VISCOSITY_PRIORITY uses. Returns null
// for a name with no viscosity grade -- the signal used to route a
// product into the non-oil block.
function parseViscosity(name) {
  if (!name) return null;
  const m = name.match(/(\d{1,2})\s*w\s*-?\s*(\d{1,3})/i);
  return m ? `${m[1]}W-${m[2]}` : null;
}

// Matches an ACEA-style spec ("C3", "A3/B4", "A3-B4", "E7") or "LL"
// (VW Longlife) in a product name and normalizes it to the "/"-separated
// upper-case form SPEC_PRIORITY uses. Only called on products that already
// have a parsed viscosity grade (see compareProducts below), so this never
// runs against a non-oil product's name/SKU -- no risk of e.g. "Filter
// A123" being misread as spec "A1".
function parseSpec(name) {
  if (!name) return null;
  const acea = name.match(/\b([ABCE]\d)((?:[/-][ABCE]\d)*)\b/i);
  if (acea) return acea[0].replace(/-/g, "/").toUpperCase();
  return /\bLL\b/i.test(name) ? "LL" : null;
}

// Matches "0.5L", "1 L", "208L", etc. in a unit string; returns the
// numeric liter value, or null if the unit isn't a plain liter size.
export function parseLiters(unit) {
  if (!unit) return null;
  const m = String(unit).match(/^\s*([\d.]+)\s*L\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function compareProducts(a, b) {
  const va = parseViscosity(a.name);
  const vb = parseViscosity(b.name);
  if (!va && !vb) return (a.name || "").localeCompare(b.name || "");
  if (!va) return 1;
  if (!vb) return -1;

  const brandCmp = compareTier(BRAND_PRIORITY, a.brand, b.brand);
  if (brandCmp !== 0) return brandCmp;

  const familyCmp = compareTier(FAMILY_PRIORITY, a.family, b.family);
  if (familyCmp !== 0) return familyCmp;

  const viscCmp = compareTier(VISCOSITY_PRIORITY, va, vb);
  if (viscCmp !== 0) return viscCmp;

  const specCmp = compareTier(SPEC_PRIORITY, parseSpec(a.name), parseSpec(b.name));
  if (specCmp !== 0) return specCmp;

  const la = parseLiters(a.unit);
  const lb = parseLiters(b.unit);
  if (la != null && lb != null && la !== lb) return la - lb;
  if (la != null && lb == null) return -1;
  if (la == null && lb != null) return 1;

  return (a.name || "").localeCompare(b.name || "");
}

export function sortedBrands(products) {
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
  return brands.sort((a, b) => compareTier(BRAND_PRIORITY, a, b));
}
