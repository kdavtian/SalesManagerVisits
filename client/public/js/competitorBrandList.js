// The competitor brands every screen offers (owner, 2026-11-19: "fix the brand filters everywhere including map"): the check-in sheet, the
// map's Brands filter, the customer chips and the reports read this one list instead of the fixed 18 of brandChips.js COMPETITORS.
// The server's list = the approved brands + the ones this user asked for that still wait (GET /api/competitor-brands). Cache first: the
// last list answers at once (also after a restart, from localStorage) and is read again in the background; the first time it waits at
// most 3 s, then the built-in list answers. Every list read also teaches brandChips.js the brands' real names (rememberCompetitorNames).
import { api } from "./api.js";
import { COMPETITORS, rememberCompetitorNames } from "./brandChips.js";

const STORE = "fv.competitorBrands.v1";
let cached = null;

function readStored() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) || "null");
    return Array.isArray(list) && list.every((b) => b && typeof b.key === "string") ? list : null;
  } catch {
    return null;
  }
}

function keep(list) {
  cached = list;
  rememberCompetitorNames(list);
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // private mode / full storage: the list still works for this visit
  }
  return list;
}

export const builtInCompetitorBrands = () => COMPETITORS.map((key) => ({ key, name: "", status: "approved" }));

function refresh() {
  return api.getCompetitorBrands().then((r) => keep(Array.isArray(r?.brands) ? r.brands : builtInCompetitorBrands()));
}

// [{ key, name, status: "approved" | "pending", mine }] in the check-in order
export async function loadCompetitorBrands() {
  if (!cached) {
    const stored = readStored();
    if (stored) {
      cached = stored;
      rememberCompetitorNames(stored);
    }
  }
  if (cached) {
    refresh().catch(() => {});
    return cached;
  }
  try {
    return await Promise.race([refresh(), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 3000))]);
  } catch {
    return builtInCompetitorBrands();
  }
}

// the names known so far, without waiting (first paint of a screen); null until a list was read once
export function knownCompetitorBrands() {
  if (!cached) {
    const stored = readStored();
    if (stored) {
      cached = stored;
      rememberCompetitorNames(stored);
    }
  }
  return cached;
}

// sign-out: the next user starts from their own list
export function forgetCompetitorBrands() {
  cached = null;
  try {
    localStorage.removeItem(STORE);
  } catch {
    // nothing stored
  }
}
