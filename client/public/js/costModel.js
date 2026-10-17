// The cost model of the Castrol workbook (Products sheet, 2.1.0) as pure functions, shared by the Products-page
// calculator (costCalculator.js) and the server (discountPolicy.js: discount approvals) so both always agree.
// Version 2 (owner, 2026-10-17): per-brand freight (real) and legal transport, commissions by sales channel, the old
// "790 AMD per litre" replaced by cost items measured from the cash ledger, and an optional VAT-payer method.
//
// LANDING COST (what a pack costs once it is in our warehouse), per ITEM, USD -> AMD:
//   supplier price + legal transport + ecology + customs duty + excise + import VAT + real freight + clearance costs.
//   The LEGAL transport (invoice value declared to customs) is part of the customs value, so it feeds duty, ecology and VAT;
//   the REAL freight is what the carrier is actually paid and is not part of the customs value.
//
// NET COST (landing + what the sale itself costs us), per PACK at a given selling price:
//   method "workbook": landing (import VAT inside it) + commissions + overhead + 20 % "VAT tax" on the margin + 18 % profit
//     tax on the rest of the margin -- the workbook's way, kept as an option;
//   method "payer": KAD is a VAT payer, so import VAT is only advanced (it is credited against the VAT collected from
//     customers) -- net cost = landing + VAT to the state (price/6 - import VAT) + commissions + overhead + profit tax on the
//     real profit (revenue without VAT - landing without VAT - commissions - overhead). Prices are VAT-inclusive.
// Both are PER PACK (the workbook's 2.1.0 formula mixed a per-litre landing cost into a per-pack price, a bug).

// Channels that pay no commission at all (owner, 2026-10-17); every other channel pays the director's share, and channels
// run by a field sales manager ("SM ...") pay the rep's share as well: SM YVN 4 %, CVO/PCO/OEM 2 %, KF and CAS 0 %.
export const COMMISSION_FREE_CHANNELS = Object.freeze(["KF", "CAS"]);
export const BRAND_KEYS = Object.freeze(["Castrol", "Royal", "Lotos", "Other"]);

// Overhead items measured from the cash ledger (Cashflow sheet), 12 months to 2026-09: 320.1 M AMD of sales (1,537 orders,
// 89,581 L). pct = % of the selling price, liter = AMD per litre, pack = AMD per pack. Fixed monthly costs are spread as a
// share of the PRICE (a 9,000 AMD litre of Castrol carries more than a 2,400 AMD litre of Lotos); vehicle running costs
// follow the litres. `labelKey` names a built-in item; custom items carry their own `label`.
export const DEFAULT_COST_ITEMS = Object.freeze([
  Object.freeze({ id: "payroll", labelKey: "cc_item_payroll", kind: "pct", value: 8.22, on: true }),
  Object.freeze({ id: "payroll_tax", labelKey: "cc_item_payroll_tax", kind: "pct", value: 1.43, on: true }),
  Object.freeze({ id: "office", labelKey: "cc_item_office", kind: "pct", value: 4.61, on: true }),
  Object.freeze({ id: "marketing", labelKey: "cc_item_marketing", kind: "pct", value: 2.46, on: true }),
  Object.freeze({ id: "ecology_fee", labelKey: "cc_item_ecology", kind: "pct", value: 0.54, on: true }),
  Object.freeze({ id: "finance", labelKey: "cc_item_finance", kind: "pct", value: 0.23, on: true }),
  Object.freeze({ id: "fuel", labelKey: "cc_item_fuel", kind: "liter", value: 34.26, on: true }),
  Object.freeze({ id: "maintenance", labelKey: "cc_item_maintenance", kind: "liter", value: 6.57, on: true }),
  Object.freeze({ id: "vehicle_dep", labelKey: "cc_item_vehicle", kind: "liter", value: 9.07, on: true }),
]);

export const COST_RATES_DEFAULT = Object.freeze({
  rate: 366, // USD -> AMD: the market rate in the cash ledger (owner, 2026-10-18; the workbook's Products!A1 still says 377.5)
  // legal transport = the freight value declared on the customs invoice, USD per kg (customs value, hence duty/VAT base)
  tLegalCastrol: 2007 / 9280, // a 2,007 USD truck of 9,280 kg
  tLegalRoyal: 0.35,
  tLegalLotos: 0.35, // Orlen comes from the same factory: same freight, same legal value
  tLegalOther: 0.35,
  // real freight actually paid to carriers, USD per kg (cash ledger, 2025-2026 shipments)
  tRealCastrol: 0.252, // Sole Trans (all 2026 shipments average 0.251)
  tRealRoyal: 0.4, // Luk Oil trucks
  tRealLotos: 0.325, // Orlen Oil truck (Mira Trans)
  tRealOther: 0.252,
  eco: 2, // % of customs value (cost + legal transport)
  customs: 5, // % of customs value
  excise: 682, // AMD per kg netto (550 x 1.24 indexation in 2026)
  vat: 20, // import VAT, and the VAT inside a selling price, %
  handling: 157000 / 377.5 / 25000, // clearance, USD per litre (Products!U1)
  otherUsd: 0, // other costs, USD per item
  commDirector: 2, // % of the selling price: sales director, every channel except KF and CAS
  commRep: 2, // % of the selling price: the sales manager of an "SM ..." channel, own channel only
  vatMode: "payer", // "workbook" | "payer" -- KAD is a VAT payer (owner, 2026-10-18)
  vatTax: 20, // workbook method: % of the margin
  ptax: 18, // profit tax, %
  vatShare: 0.16, // payer method with a landing cost taken from the Excel: import VAT is ~16 % of landing cost
});

// The market USD rate the cash ledger shows (366-370 AMD in 2026-06..09) -- the default rate since 1.359.0 (owner's decision);
// the workbook's Products!A1 still says 377.5, so the settings button stays for a phone that saved another rate.
export const RATE_MARKET_HINT = Object.freeze({ value: 366, asOf: "2026-09" });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Freight and legal values are kept per factory: Orlen = Lotos, anything that is not Castrol/Royal/Lotos/Orlen = Other.
export function brandKey(brand) {
  const b = String(brand ?? "").trim().toLowerCase();
  if (b === "castrol") return "Castrol";
  if (b === "royal") return "Royal";
  if (b === "lotos" || b === "orlen") return "Lotos";
  return "Other";
}

// Commission in % of the selling price for a sales channel. Without a channel (a product's own net cost) it is the dearest
// case: the director's share plus the rep's (SM YVN).
export function commissionPct(channel, rates = COST_RATES_DEFAULT) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  if (channel == null || String(channel).trim() === "") return num(r.commDirector) + num(r.commRep);
  const c = String(channel).trim().toUpperCase();
  if (COMMISSION_FREE_CHANNELS.includes(c)) return 0;
  return num(r.commDirector) + (/^SM(\s|$)/.test(c) ? num(r.commRep) : 0);
}

// pack: { brand, size (L per item), items (per pack), packKg, packCostUsd }
export function landingCost(pack, rates = COST_RATES_DEFAULT) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const key = brandKey(pack.brand);
  const items = num(pack.items);
  const netto = items > 0 ? num(pack.packKg) / items : 0;
  const cost = items > 0 ? num(pack.packCostUsd) / items : 0;
  const tLegal = netto * num(r[`tLegal${key}`]);
  const tReal = netto * num(r[`tReal${key}`]);
  const eco = ((cost + tLegal) * r.eco) / 100;
  const customs = ((cost + tLegal) * r.customs) / 100;
  const excise = r.rate ? (netto * r.excise) / r.rate : 0;
  const vat = ((cost + tLegal + customs + excise) * r.vat) / 100;
  const handling = num(pack.size) * r.handling;
  const other = r.otherUsd;
  const usd = cost + tLegal + tReal + eco + customs + excise + vat + handling + other;
  return { netto, cost, tLegal, tReal, eco, customs, excise, vat, handling, other, usd, amd: usd * r.rate };
}

// The cost items that count (all on, or only the ones switched on).
function activeItems(rates, withFixed) {
  if (!withFixed) return [];
  const list = Array.isArray(rates.items) ? rates.items : DEFAULT_COST_ITEMS;
  return list.filter((i) => i && i.on !== false && num(i.value) !== 0);
}

// % of the price, AMD per litre, AMD per pack -> the three coefficients the formulas need
function itemTotals(items, liters) {
  let pctOfPrice = 0;
  let fixedAmd = 0;
  for (const i of items) {
    const v = num(i.value);
    if (i.kind === "pct") pctOfPrice += v / 100;
    else if (i.kind === "liter") fixedAmd += v * num(liters);
    else fixedAmd += v; // per pack
  }
  return { pctOfPrice, fixedAmd };
}

// landing = AMD per pack, price = AMD per pack (VAT inclusive), liters = litres in the pack.
// opts: withFixed=false leaves the overhead items out (variable cost only: commissions and taxes remain);
//       channel = sales channel for the commission (default: dearest case); vatIn = import VAT inside `landing`
//       (payer method; default landing x vatShare).
export function netCost({ landing, price, liters }, rates = COST_RATES_DEFAULT, { withFixed = true, channel = null, vatIn = null } = {}) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const L = num(landing);
  const p = num(price);
  const c = commissionPct(channel, r) / 100;
  const items = activeItems(r, withFixed);
  const { pctOfPrice, fixedAmd } = itemTotals(items, liters);
  const commission = p * c;
  const itemAmounts = items.map((i) => ({
    id: i.id,
    label: i.label,
    labelKey: i.labelKey,
    kind: i.kind,
    value: num(i.value),
    amount: i.kind === "pct" ? (p * num(i.value)) / 100 : i.kind === "liter" ? num(i.value) * num(liters) : num(i.value),
  }));
  const overhead = p * pctOfPrice + fixedAmd;
  let vatTax;
  let ptax;
  let vatInAmd = 0;
  if (r.vatMode === "payer") {
    const k = 1 / (1 + num(r.vat) / 100);
    vatInAmd = Math.min(L, vatIn != null ? num(vatIn) : L * num(r.vatShare));
    const Lx = L - vatInAmd;
    const revenueEx = p * k;
    vatTax = p - revenueEx - vatInAmd; // VAT paid to the state after crediting the import VAT
    ptax = (Math.max(0, revenueEx - Lx - commission - overhead) * r.ptax) / 100;
  } else {
    const margin = Math.max(0, p - L); // no tax refund below landing cost
    vatTax = (margin * r.vatTax) / 100;
    ptax = ((margin - vatTax) * r.ptax) / 100;
  }
  const net = L + commission + overhead + vatTax + ptax;
  return {
    mode: r.vatMode === "payer" ? "payer" : "workbook",
    landing: L,
    price: p,
    commissionPct: c * 100,
    commission,
    items: itemAmounts,
    overhead,
    vatTax,
    vatIn: vatInAmd,
    ptax,
    net,
    profit: p - net,
    margin: p > 0 ? (p - L) / p : null,
    netMargin: p > 0 ? (p - net) / p : null,
  };
}

// The selling price at which the net margin ((price - net cost) / price) equals `targetPct` percent. The net cost is linear in
// the price on each side of its kink (landing cost / zero profit), so this is closed form. 0 % = break-even. null when no
// price can reach it. Same options as netCost.
export function priceForNetMargin({ landing, liters }, targetPct, rates = COST_RATES_DEFAULT, { withFixed = true, channel = null, vatIn = null } = {}) {
  const r = { ...COST_RATES_DEFAULT, ...rates };
  const L = num(landing);
  const g = num(targetPct) / 100;
  const items = activeItems(r, withFixed);
  const { pctOfPrice, fixedAmd: F } = itemTotals(items, liters);
  const co = commissionPct(channel, r) / 100 + pctOfPrice; // everything that is a share of the price
  const t = num(r.ptax) / 100;
  if (r.vatMode === "payer") {
    const k = 1 / (1 + num(r.vat) / 100);
    const Lx = L - Math.min(L, vatIn != null ? num(vatIn) : L * num(r.vatShare));
    // profit above zero: P(1 - g - A) = (Lx + F)(1 - t),  A = (1 - k) + co(1 - t) + t k
    const A = 1 - k + co * (1 - t) + t * k;
    if (1 - g - A > 0) {
      const p = ((Lx + F) * (1 - t)) / (1 - g - A);
      if (p * k - Lx - co * p - F >= -1e-9) return p;
    }
    // no profit tax to pay: P(1 - g - (1 - k) - co) = Lx + F
    const B = 1 - g - (1 - k) - co;
    if (B > 0) {
      const p = (Lx + F) / B;
      if (p * k - Lx - co * p - F <= 1e-9) return p;
    }
    return null;
  }
  const v = num(r.vatTax) / 100;
  const a = co + v + t * (1 - v);
  const b = L * (1 - v - t * (1 - v)) + F;
  const above = 1 - g - a;
  if (above > 0) {
    const p = b / above;
    if (p >= L) return p;
  }
  const below = 1 - g - co;
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

// Saved calculator rates (per phone) -> a complete, current rates object. Anything saved by the first calculator (before the
// per-brand freight, commissions and cost items existed) is dropped except the plain numbers that kept their meaning.
export function mergeSavedRates(saved) {
  const base = { ...COST_RATES_DEFAULT, items: DEFAULT_COST_ITEMS.map((i) => ({ ...i })) };
  if (!saved || typeof saved !== "object") return base;
  for (const k of Object.keys(COST_RATES_DEFAULT)) {
    if (k === "items" || k === "vatMode") continue;
    if (Number.isFinite(Number(saved[k]))) base[k] = Number(saved[k]);
  }
  if (saved.vatMode === "payer" || saved.vatMode === "workbook") base.vatMode = saved.vatMode;
  if (Array.isArray(saved.items)) {
    const byId = new Map(saved.items.filter((i) => i && i.id).map((i) => [i.id, i]));
    base.items = DEFAULT_COST_ITEMS.map((d) => {
      const s = byId.get(d.id);
      return s ? { ...d, value: Number.isFinite(Number(s.value)) ? Number(s.value) : d.value, on: s.on !== false } : { ...d };
    });
    for (const s of saved.items) {
      if (s && s.custom && s.id && s.label && ["pct", "liter", "pack"].includes(s.kind)) {
        base.items.push({ id: String(s.id), label: String(s.label).slice(0, 60), kind: s.kind, value: num(s.value), on: s.on !== false, custom: true });
      }
    }
  }
  return base;
}
