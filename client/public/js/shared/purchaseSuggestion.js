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
//   stock at arrival     = max(0, stock now + coming − wanted − daily × lead time)
//   need                 = daily × (lead time + cover days) + safety stock + wanted − (stock now + coming)
//   order                = need rounded UP to the step (nothing when need <= 0)
//   after receiving      = stock at arrival + order
//   days after receiving = after receiving / daily   (counted from the day the goods arrive: today + lead time)
//   runs out before arrival: stock now + coming − wanted < daily × lead time
/** Litres in one piece: the Excel size when known, else read from the unit ("4 L", "208L", "1,5L"). Also used by stockForecast.js. */
export function sizeLiters(product) {
  const direct = Number(product?.size_l);
  if (direct > 0) return direct;
  const m = String(product?.unit ?? "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*l/i);
  return m ? Number(m[1]) : null;
}

export const STEP_PACKS = 5;
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
 * One product's suggestion. `order` overrides the suggested quantity (the screen's − / +); it is NOT rounded here (the screen only moves it
 * by whole steps). Returns the numbers the screen shows; days are null when there is no demand.
 */
export function purchaseLine({ stockNow, coming = 0, wanted = 0, daily, leadTimeDays, coverDays, safetyStock = 0, stepPieces, order = null }) {
  const free = Number(stockNow) || 0;
  const d = Number(daily) > 0 ? Number(daily) : 0;
  const onHandAndComing = free + (Number(coming) || 0) - (Number(wanted) || 0);
  const need = d * (leadTimeDays + coverDays) + (Number(safetyStock) || 0) + (Number(wanted) || 0) - (free + (Number(coming) || 0));
  const suggested = roundUpToStep(need, stepPieces);
  const qty = order == null ? suggested : Math.max(0, Number(order) || 0);
  const atArrival = Math.max(0, onHandAndComing - d * leadTimeDays);
  const after = atArrival + qty;
  return {
    need: Math.max(0, Math.ceil(need)),
    suggested,
    order: qty,
    stock_at_arrival: Math.round(atArrival),
    after_receiving: Math.round(after),
    days_now: d > 0 ? round1(Math.max(0, free) / d) : null,
    days_after_receiving: d > 0 ? round1(after / d) : null,
    runs_out_before_arrival: d > 0 && onHandAndComing < d * leadTimeDays,
  };
}
