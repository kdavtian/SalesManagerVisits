// The cost model of the Castrol workbook (Products sheet, 2.1.0) as pure functions, shared by the Products-page
// calculator (costCalculator.js) and the server (discountPolicy.js: discount approvals) so both always agree.
//
// Landing cost (what a pack costs once it is in our warehouse): supplier price + legal transport + ecology + customs
// + excise + import VAT + real freight + clearance costs, all per ITEM, USD -> AMD.
// Net cost (landing + what the sale itself costs us): 4 % manager salary of the price + 20 % "VAT tax" on the margin +
// 18 % profit tax on the rest of the margin + 790 AMD of allocated fixed cost per litre -- all PER PACK, at the
// selling price in question (the workbook mixes a per-litre landing cost into a per-pack price for packs > 1 L, a bug
// that overstates its net cost by ~18 %; here it is done per pack).
export const COST_RATES_DEFAULT = Object.freeze({
  rate: 377.5, // Products!A1, USD -> AMD
  tCastrol: 2007 / 9280, // legal transport, USD per kg, Castrol
  tLotos: 0.35, // Products!O1 is the "other brands" rate; Lotos has the same value
  tOther: 0.35,
  tReal: 0.252, // real freight, USD per kg
  eco: 2, // % of (cost + legal transport)
  customs: 5, // % of (cost + legal transport)
  excise: 682, // AMD per kg
  vat: 20, // import VAT %
  handling: 157000 / 377.5 / 25000, // clearance, USD per litre (Products!U1)
  otherUsd: 0, // other costs, USD per item
  mgr: 4, // manager salary, % of the selling price (Products!Z1)
  vatTax: 20, // % of the margin (Products!AB1)
  ptax: 18, // profit tax, % of the margin after VAT tax (Products!AA1)
  fixedPerL: 790, // allocated fixed cost, AMD per litre (Products!AD1)
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// pack: { brand: "Castrol" | "Lotos" | other, size (L per item), items (per pack), packKg, packCostUsd }
export function landingCost(pack, rates = COST_RATES_DEFAULT) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const items = num(pack.items);
  const netto = items > 0 ? num(pack.packKg) / items : 0;
  const cost = items > 0 ? num(pack.packCostUsd) / items : 0;
  const tLegal = netto * (pack.brand === "Castrol" ? r.tCastrol : pack.brand === "Lotos" ? r.tLotos : r.tOther);
  const tReal = netto * r.tReal;
  const eco = ((cost + tLegal) * r.eco) / 100;
  const customs = ((cost + tLegal) * r.customs) / 100;
  const excise = r.rate ? (netto * r.excise) / r.rate : 0;
  const vat = ((cost + tLegal + customs + excise) * r.vat) / 100;
  const handling = num(pack.size) * r.handling;
  const other = r.otherUsd;
  const usd = cost + tLegal + tReal + eco + customs + excise + vat + handling + other;
  return { netto, cost, tLegal, tReal, eco, customs, excise, vat, handling, other, usd, amd: usd * r.rate };
}

// landing = AMD per pack, price = AMD per pack, liters = litres in the pack. withFixed=false leaves the allocated fixed
// cost out (variable cost only).
export function netCost({ landing, price, liters }, rates = COST_RATES_DEFAULT, { withFixed = true } = {}) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const L = num(landing);
  const p = num(price);
  const margin = Math.max(0, p - L); // no tax refund below landing cost
  const mgr = (p * r.mgr) / 100;
  const vatTax = (margin * r.vatTax) / 100;
  const ptax = ((margin - vatTax) * r.ptax) / 100;
  const fixed = withFixed ? num(liters) * r.fixedPerL : 0;
  const net = L + mgr + vatTax + ptax + fixed;
  return { landing: L, price: p, mgr, vatTax, ptax, fixed, net, profit: p - net, margin: p > 0 ? (p - L) / p : null, netMargin: p > 0 ? (p - net) / p : null };
}

// The selling price at which the net margin ((price - net cost) / price) equals `targetPct` percent. net cost is linear in
// the price on each side of the landing cost, so this is closed form. 0 % = break-even. null when no price can reach it.
export function priceForNetMargin({ landing, liters }, targetPct, rates = COST_RATES_DEFAULT, { withFixed = true } = {}) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const L = num(landing);
  const g = num(targetPct) / 100;
  const m = r.mgr / 100;
  const v = r.vatTax / 100;
  const t = r.ptax / 100;
  const F = withFixed ? num(liters) * r.fixedPerL : 0;
  const a = m + v + t * (1 - v);
  const b = L * (1 - v - t * (1 - v)) + F;
  const above = 1 - g - a;
  if (above > 0) {
    const p = b / above;
    if (p >= L) return p;
  }
  const below = 1 - g - m;
  if (below > 0) {
    const p = (L + F) / below;
    if (p <= L) return p;
  }
  return null;
}

// "4L" / "0.5L" / "208 L" -> 4 / 0.5 / 208 (0 when the unit says nothing about litres)
export function litersOfUnit(unit) {
  const n = parseFloat(String(unit ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
