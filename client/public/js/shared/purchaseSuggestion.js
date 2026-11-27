// Smart purchase suggestions (owner, 2026-11-25): for every product that needs buying, how much to order from its supplier so the stock
// lasts the lead time plus the cover days after the goods arrive -- in the quantities suppliers sell. Pure rules, no database: the route
// (routes/purchases.js GET /suggestions) gathers the numbers, the screen (views/purchaseSuggestions.js) recomputes a line with the same
// formulas when the owner changes a quantity with − / +. ONE file for the server and the phone app (like roles.js): no imports, it runs unchanged
// in Node and in the browser; server/src/products/purchaseSuggestion.js re-exports it.
//
// ORDER STEPS (owner, 2026-11-25):
//   - a bottle (and anything else sold in packs, filters too) is bought in steps of 5 packs: 5, 10, 15, 20 packs ... (1 L: 12 a pack, so
//     60, 120, 180 bottles; 4 L: 4 a pack, so 20, 40, 60 bottles);
//   - a 20 L canister: steps of 5 pieces (5, 10, 15 ...);
//   - above 20 L (60 L and 208 L drums, any size in between): by 1.
//   Pack size: the Excel "Items per Pack" when it is known; otherwise a guess by size (flagged on the screen: pack_size_guessed).
//   An item with no size and no pack size (merchandise) is bought by the piece.
//
// THE NUMBERS OF ONE LINE (pieces; daily = sales a day from the demand model, demandModel.js):
//   stock now            = free stock (orders/appStock.js: Excel − held by orders + back on the shelf not in Excel yet)
//   coming               = already Ordered / On the way to us (purchases.js incomingQtyByProduct)
//   wanted               = submitted orders not confirmed yet (planning takes them as sold)
//   days left now        = stock now / daily
//   stock at arrival     = the days walked in order (stockAtArrival): the free stock sells, goods on the way join the shelf on their
//                          expected day, a day with an empty shelf is a lost sale (review 2026-11-25: the customer buys elsewhere, so
//                          those days are not bought for; and goods ordered earlier are not "sold" before they come)
//   safety (capped)      = the demand model's safety stock, at most half of the cover days' sales (owner, 2026-11-26, Q1a: a product
//                          bought by the box sells 0 one week and 12 the next, and the 95 % formula then asked for more safety than the
//                          cover itself -- Edge 0W-30 1L: 120 bottles = 168 days for a 45-day cover)
//   need                 = daily × cover days + safety (capped) + still owed to submitted orders − stock at arrival
//                          (while the stock lasts until the arrival: daily × (lead + cover) + safety + wanted − (stock now + coming))
//   base need            = the same without the safety stock
//   order                = need rounded UP to the step (nothing when need <= 0), then ONE STEP LESS (owner, 2026-11-26) when
//                          - that smaller order still covers the base need (Q2a: the cover days are bought; only the safety is short), or
//                          - sales are falling (trend down: never rounded up)
//                          ... but never below one step when something is needed
//   too much             = days after receiving > 2 × cover days (the screen warns; one step alone can be that much for a slow product)
//   after receiving      = stock at arrival + order − still owed
//   days after receiving = after receiving / daily   (counted from the day the goods arrive: today + lead time)
//   runs out before arrival: the shelf is empty (or owes submitted orders) on some day before the goods come
/** Litres in one piece: the Excel size when known, else read from the unit ("4 L", "208L", "1,5L"). Also used by stockForecast.js. */
export function sizeLiters(product) {
  const direct = Number(product?.size_l);
  if (direct > 0) return direct;
  const m = String(product?.unit ?? "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*l/i);
  return m ? Number(m[1]) : null;
}

export const STEP_PACKS = 5;
/** The safety stock bought is at most this share of the cover days' sales (owner, 2026-11-26). */
export const SAFETY_CAP_OF_COVER = 0.5;
/** "Too much" when the stock after receiving lasts more than this many times the cover days. */
export const TOO_MUCH_COVERS = 2;
export const BY_ONE_ABOVE_LITERS = 20;

/** How a product is bought: { kind: 'drum' | 'canister' | 'pack' | 'piece', packSize, stepPieces, packSizeGuessed }. */
export function orderStep(product) {
  const liters = sizeLiters(product);
  if (liters != null && liters > BY_ONE_ABOVE_LITERS) return { kind: "drum", packSize: 1, stepPieces: 1, packSizeGuessed: false };
  if (liters != null && liters >= BY_ONE_ABOVE_LITERS) return { kind: "canister", packSize: 1, stepPieces: STEP_PACKS, packSizeGuessed: false };
  const known = Number(product?.items_per_pack);
  let packSize = known > 0 ? Math.round(known) : null;
  // no size and no pack size (merchandise: a stand, a banner): by the piece, as before
  if (!packSize && liters == null) return { kind: "piece", packSize: 1, stepPieces: 1, packSizeGuessed: false };
  const packSizeGuessed = !packSize;
  if (!packSize) {
    if (liters <= 1) packSize = 12;
    else if (liters <= 2) packSize = 6;
    else if (liters <= 5) packSize = 4;
    else if (liters < 10) packSize = 3;
    else packSize = 1;
  }
  return { kind: "pack", packSize, stepPieces: packSize * STEP_PACKS, packSizeGuessed };
}

/** Pieces needed -> pieces ordered: 0 when nothing is needed, otherwise rounded UP to whole steps. */
export function roundUpToStep(pieces, stepPieces) {
  const step = Math.max(1, Math.round(Number(stepPieces) || 1));
  if (!(Number(pieces) > 0)) return 0;
  return Math.ceil(Number(pieces) / step) * step;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * What is left on the shelf the day a purchase ordered today arrives (after leadTimeDays), walking the days in order:
 *   - the free stock sells first; submitted orders (`wanted`) take their pieces before anyone else, and what the stock cannot give them
 *     stays owed (`backlog`) -- the next goods to come serve them first;
 *   - goods already ordered (`comingLots`: [{ qty, inDays }]) are on the shelf only from the day they are expected (no date: at the end of the
 *     lead time, the latest they can be); a lot expected after the lead time counts as coming at the end of it;
 *   - a day with nothing on the shelf is a lost sale (the customer buys elsewhere): it is not bought back later.
 * Returns { atArrival, backlog, ranOut }. ranOut = the shelf is empty (or owes pieces) at some point before the arrival.
 */
export function stockAtArrival({ stockNow, comingLots = [], wanted = 0, daily, leadTimeDays }) {
  const d = Number(daily) > 0 ? Number(daily) : 0;
  const lead = Math.max(0, Number(leadTimeDays) || 0);
  let s = (Number(stockNow) || 0) - (Number(wanted) || 0);
  let backlog = Math.max(0, -s);
  s = Math.max(0, s);
  let ranOut = backlog > 0;
  const lots = (comingLots ?? [])
    .map((l) => ({ qty: Math.max(0, Number(l?.qty) || 0), at: Math.min(lead, Math.max(0, l?.inDays == null ? lead : Number(l.inDays) || 0)) }))
    .filter((l) => l.qty > 0)
    .sort((a, b) => a.at - b.at);
  let t = 0;
  // lost = the sales of the empty days (pieces customers wanted while the shelf was empty; they buy elsewhere)
  let lost = 0;
  for (const lot of lots) {
    s -= d * (lot.at - t);
    if (s < 0) {
      ranOut = true;
      lost += -s;
      s = 0;
    }
    t = lot.at;
    const owed = Math.min(backlog, lot.qty);
    backlog -= owed;
    s += lot.qty - owed;
  }
  s -= d * (lead - t);
  if (s < 0) {
    ranOut = true;
    lost += -s;
    s = 0;
  }
  return { atArrival: s, backlog, ranOut, lost };
}

/**
 * One product's suggestion. `order` overrides the suggested quantity (the screen's − / +); it is NOT rounded here (the screen only moves it
 * by whole steps). `comingLots` = goods already ordered with the days until each is expected; `coming` (a plain number) = the same, all
 * expected at the end of the lead time. Returns the numbers the screen shows; days are null when there is no demand.
 *   need = daily × cover days + safety stock + still owed to submitted orders − stock at arrival
 *   after receiving = stock at arrival + order − still owed
 */
export function purchaseLine({ stockNow, coming = 0, comingLots = null, wanted = 0, daily, leadTimeDays, coverDays, safetyStock = 0, stepPieces, trend = null, order = null }) {
  const free = Number(stockNow) || 0;
  const d = Number(daily) > 0 ? Number(daily) : 0;
  const cover = Math.max(0, Number(coverDays) || 0);
  const lots = comingLots ?? (Number(coming) > 0 ? [{ qty: Number(coming), inDays: null }] : []);
  const { atArrival, backlog, ranOut, lost } = stockAtArrival({ stockNow: free, comingLots: lots, wanted, daily: d, leadTimeDays });
  const safety = Math.min(Math.max(0, Number(safetyStock) || 0), d * cover * SAFETY_CAP_OF_COVER);
  const baseNeed = d * cover + backlog - atArrival;
  const need = baseNeed + safety;
  const step = Math.max(1, Math.round(Number(stepPieces) || 1));
  let suggested = roundUpToStep(need, step);
  let rounding = suggested > 0 ? "up" : null;
  const smaller = suggested - step;
  if (smaller > 0 && smaller >= baseNeed) rounding = "down_covers";
  // falling sales: the rounding up is undone, never more (an order that is already exactly the need stays; review 2026-11-26)
  else if (smaller > 0 && trend === "down" && suggested - need > 1e-9) rounding = "down_trend";
  if (rounding === "down_covers" || rounding === "down_trend") suggested = smaller;
  const qty = order == null ? suggested : Math.max(0, Number(order) || 0);
  const after = Math.max(0, atArrival + qty - backlog);
  const daysAfter = d > 0 ? round1(after / d) : null;
  return {
    need: Math.max(0, Math.ceil(need)),
    base_need: Math.max(0, Math.ceil(baseNeed)),
    safety_used: Math.round(safety),
    rounding,
    suggested,
    order: qty,
    stock_at_arrival: Math.round(atArrival),
    // the "why" of the order (owner 2026-11-26 audit, step 3): cover days' sales + safety + still owed - left on arrival = need
    cover_need: Math.round(d * cover),
    backlog: Math.round(backlog),
    // sales lost before the goods can come (the shelf empty on those days), pieces
    lost_before_arrival: Math.round(lost),
    lost_days: d > 0 ? Math.round(lost / d) : 0,
    after_receiving: Math.round(after),
    days_now: d > 0 ? round1(Math.max(0, free) / d) : null,
    days_after_receiving: daysAfter,
    too_much: qty > 0 && daysAfter != null && cover > 0 && daysAfter > cover * TOO_MUCH_COVERS,
    runs_out_before_arrival: d > 0 && ranOut,
  };
}

/**
 * A purchase budget (owner, 2026-11-26 audit, step 4): the suggested orders filled by priority until the money runs out.
 * Priority: out of stock now, then runs out before the goods could come, then the fewest days left, then the better margin (our selling
 * price per piece / its cost per piece). A line that does not fit whole gets the most whole steps that fit; one that cannot get a single
 * step waits for the next order (0). Lines without a last price cost nothing here and keep their order (they cannot be weighed).
 * lines: [{ id, suggested, step, cost (USD a piece or null), stockNow, runsOut, daysNow, priceAmd }]
 * Returns { orders: Map(id -> pieces), cut: Set(ids that got less than suggested), spent }.
 */
export function fitToBudget(lines, budgetUsd) {
  const budget = Number(budgetUsd);
  const orders = new Map();
  const cut = new Set();
  let spent = 0;
  const rank = (l) => (Number(l.stockNow) <= 0 ? 0 : l.runsOut ? 1 : 2);
  const margin = (l) => (Number(l.cost) > 0 && Number(l.priceAmd) > 0 ? Number(l.priceAmd) / Number(l.cost) : 0);
  const sorted = [...lines].sort(
    (a, b) => rank(a) - rank(b) || (a.daysNow ?? Infinity) - (b.daysNow ?? Infinity) || margin(b) - margin(a) || String(a.id).localeCompare(String(b.id))
  );
  for (const l of sorted) {
    const want = Math.max(0, Number(l.suggested) || 0);
    const cost = Number(l.cost);
    if (!(cost > 0) || !(budget >= 0)) {
      orders.set(l.id, want);
      continue;
    }
    const step = Math.max(1, Math.round(Number(l.step) || 1));
    const left = budget - spent;
    const fitSteps = Math.floor((left + 1e-9) / (step * cost));
    const pieces = Math.min(want, fitSteps * step);
    orders.set(l.id, pieces);
    if (pieces < want) cut.add(l.id);
    spent += pieces * cost;
  }
  return { orders, cut, spent: Math.round(spent * 100) / 100 };
}
