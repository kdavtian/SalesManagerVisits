// The company-wide "Frequent" ranking (most ordered products), cached for 10 minutes. Only the fallback of the
// Frequent chip for a customer with no order history of their own.
import { api } from "./api.js";

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
