// The competitor brands every screen offers (owner, 2026-11-19: "fix the brand filters everywhere including map"): the check-in sheet, the
// map's Brands filter, the customer chips and the reports read this one list instead of the fixed 18 of brandChips.js COMPETITORS.
// The server's list = the approved brands + the ones this user asked for that still wait (GET /api/competitor-brands). Cache first: the
// last list answers at once (also after a restart, from localStorage) and is read again in the background; the first time it waits at
// most 3 s, then the built-in list answers. Every list read also teaches brandChips.js the brands' real names (rememberCompetitorNames).
// The list belongs to the signed-in user (it holds their own waiting brands): stored with their id, never shown to another user, and a
// read that finishes after a sign-out or a change of user is thrown away (review, 2026-11-19).
import { api } from "./api.js";
import { state } from "./state.js";
import { COMPETITORS, rememberCompetitorNames } from "./brandChips.js";

const STORE = "fv.competitorBrands.v2";
let cached = null;
let cachedFor = null;
const listeners = new Set();

const userId = () => state.user?.id ?? null;

function readStored() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    const list = saved?.list;
    if (saved?.user == null || saved.user !== userId()) return null;
    return Array.isArray(list) && list.every((b) => b && typeof b.key === "string") ? list : null;
  } catch {
    return null;
  }
}

function fromCache() {
  if (cached && cachedFor !== userId()) cached = null; // another user signed in on this device
  if (!cached) {
    const stored = readStored();
    if (stored) {
      cached = stored;
      cachedFor = userId();
      rememberCompetitorNames(stored);
    }
  }
  return cached;
}

function keep(list, forUser) {
  if (forUser == null || forUser !== userId()) return cached; // signed out / another user meanwhile: not theirs
  cached = list;
  cachedFor = forUser;
  rememberCompetitorNames(list);
  try {
    localStorage.setItem(STORE, JSON.stringify({ user: forUser, list }));
  } catch {
    // private mode / full storage: the list still works for this visit
  }
  for (const fn of listeners) {
    try {
      fn(list);
    } catch {
      // one screen's redraw never stops another's
    }
  }
  return list;
}

export const builtInCompetitorBrands = () => COMPETITORS.map((key) => ({ key, name: "", status: "approved" }));

let inFlight = null;
function refresh() {
  const forUser = userId();
  if (forUser == null) return Promise.resolve(builtInCompetitorBrands());
  if (!inFlight) {
    inFlight = api
      .getCompetitorBrands()
      .then((r) => keep(Array.isArray(r?.brands) ? r.brands : builtInCompetitorBrands(), forUser))
      .finally(() => (inFlight = null));
  }
  return inFlight;
}

// [{ key, name, status: "approved" | "pending", mine }] in the check-in order
export async function loadCompetitorBrands() {
  if (fromCache()) {
    refresh().catch(() => {});
    return cached;
  }
  try {
    return await Promise.race([refresh(), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 3000))]);
  } catch {
    return builtInCompetitorBrands();
  }
}

// the list known so far, without waiting (first paint of a screen); reads the server's in the background when there is none yet
export function knownCompetitorBrands() {
  const list = fromCache();
  if (!list && userId() != null) refresh().catch(() => {});
  return list;
}

// a screen that stays open redraws when a newer list arrives; returns the way to stop
export function onCompetitorBrandsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// sign-out: the next user starts from their own list
export function forgetCompetitorBrands() {
  cached = null;
  cachedFor = null;
  try {
    localStorage.removeItem(STORE);
    localStorage.removeItem("fv.competitorBrands.v1");
  } catch {
    // nothing stored
  }
}
