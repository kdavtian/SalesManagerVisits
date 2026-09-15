import { api } from "./api.js";
import { loadWithCache } from "./listCache.js";

const CACHE_KEY = "product-catalog";

// Shared, persisted (IndexedDB via listCache.js) product/pricelist cache --
// read on almost every order build (Create Order, add-product-to-an-
// existing-order) but rarely changes minute to minute, so an instant paint
// from cache followed by a silent background refresh beats a network round
// trip on every single open. Same stale-while-revalidate shape as every
// other list screen using loadWithCache: a network failure with a cached
// copy already returned is swallowed (useful offline, not just for speed);
// a network failure with nothing cached yet still rethrows.
export async function getProductCatalog() {
  let result = null;
  await loadWithCache(CACHE_KEY, () => api.listProducts(), (data) => {
    result = data;
  });
  return result;
}

// Same call, used from Settings' manual "Refresh product catalog" action --
// loadWithCache always performs a real network fetch regardless of what's
// cached, so this already returns the freshest copy the server has; a
// separate name here is just for the call site's own clarity of intent.
export const refreshProductCatalog = getProductCatalog;
