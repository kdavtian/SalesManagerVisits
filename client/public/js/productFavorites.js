// Favorite products (the star on the New order screen) and the company-wide "Frequent" ranking. Favorites live on
// the server per user (so they follow the person to another phone); a copy in localStorage keeps the stars
// showing when the phone is offline.
import { api } from "./api.js";
import { state } from "./state.js";

const cacheKey = () => `fv_favorite_products_${state.user?.id ?? 0}`;
function readCache() {
  try {
    return new Set(JSON.parse(localStorage.getItem(cacheKey()) || "[]"));
  } catch {
    return new Set();
  }
}
function writeCache(set) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify([...set]));
  } catch {
    /* private mode / storage blocked: favorites just do not persist offline */
  }
}

export async function loadFavorites() {
  try {
    const set = new Set(await api.getFavoriteProducts());
    writeCache(set);
    return set;
  } catch {
    return readCache();
  }
}

// Optimistic: the star flips at once; if the server cannot be reached it flips back and false is returned.
export async function setFavorite(set, productId, on) {
  if (on) set.add(productId);
  else set.delete(productId);
  writeCache(set);
  try {
    await (on ? api.addFavoriteProduct(productId) : api.removeFavoriteProduct(productId));
    return true;
  } catch {
    if (on) set.delete(productId);
    else set.add(productId);
    writeCache(set);
    return false;
  }
}

let frequentCache = null; // { at, ids }
export async function loadFrequentIds() {
  if (frequentCache && Date.now() - frequentCache.at < 10 * 60 * 1000) return frequentCache.ids;
  try {
    const ids = await api.getFrequentProducts();
    frequentCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return frequentCache?.ids ?? [];
  }
}
