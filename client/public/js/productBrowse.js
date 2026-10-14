import { groupDigits } from "./util.js";

// Pieces shared by every screen that browses the product catalog the way the New order screen does (chips, search,
// categories, stars): New order and the gold customers' Special pricelist.
// Category filter groups, from the Product Family recorded in the workbook:
// the non-engine families are categories of their own, every other family
// (Edge, Magnatec, GTX, CRB, Vecton, ON, Engine Oil, ...) is engine oil.
export const NON_ENGINE_CATEGORIES = ["Transmission", "Hydraulic", "Antifreeze", "Grease", "EV fluids", "Merch", "Other"];
// Workbook family -> category where the names differ (Castrol ON = EV fluids).
const FAMILY_TO_CATEGORY = { on: "EV fluids" };
export const CATEGORY_LABEL_KEY = {
  "Engine oil": "category_engine_oil",
  Transmission: "category_transmission",
  Hydraulic: "category_hydraulic",
  Antifreeze: "category_antifreeze",
  Grease: "category_grease",
  "EV fluids": "category_ev_fluids",
  Merch: "category_merch",
  Other: "category_other",
};
export function productCategory(product) {
  const family = (product.family || "").trim();
  const match = FAMILY_TO_CATEGORY[family.toLowerCase()] || NON_ENGINE_CATEGORIES.find((c) => c.toLowerCase() === family.toLowerCase());
  return match || (family.toLowerCase() === "transmission oils" ? "Transmission" : "Engine oil");
}

// null/undefined stock_qty means the catalog doesn't track stock for this
// product -- treated as available, same as stockWarning below does.
export function isAvailable(product) {
  return product.stock_qty === null || product.stock_qty === undefined || Number(product.stock_qty) > 0;
}

// "−2,000" / "+17,000" / "0" -- the difference of a price to the Silver price.
export function priceDiffChipHtml(price, silver) {
  if (!(Number(silver) > 0) || price == null) return "";
  const diff = Math.round(Number(price) - Number(silver));
  const text = diff === 0 ? "0" : `${diff > 0 ? "+" : "−"}${groupDigits(Math.abs(diff))}`;
  return `<span class="price-diff ${diff < 0 ? "price-diff-down" : diff > 0 ? "price-diff-up" : ""}">${text}</span>`;
}

