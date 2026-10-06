// Touch-down prefetch: when a finger (or mouse) lands on something that opens
// a detail screen, start that screen's main GET right away so it is already
// in flight -- often finished -- by the time the tap completes. Only the one
// detail request is warmed, it is single-use and expires after a few seconds
// (see api.js prefetchGet), and a scroll or drag that starts on the row is
// cancelled by the browser (pointercancel) before the tap would count.
import { prefetchGet } from "./api.js";

// [selector, path builder] -- first match wins.
const TARGETS = [
  ["[data-order-id]", (el) => `/orders/${el.dataset.orderId}`],
  [".customer-name-link[data-customer-id], .activity-customer-name-btn[data-customer-id], .list-row-icon[data-customer-id]", (el) => `/customers/${el.dataset.customerId}`],
  ["button.list-row[data-id]", (el) => (location.hash === "#/customers" ? `/customers/${el.dataset.id}` : null)],
  ["[data-open-id]", (el) => `/products/${el.dataset.openId}`],
];

export function installTouchPrefetch() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button > 0 || !(e.target instanceof Element)) return;
      for (const [selector, buildPath] of TARGETS) {
        const el = e.target.closest(selector);
        if (!el) continue;
        const path = buildPath(el);
        if (path && !/\/(undefined|null)$/.test(path)) prefetchGet(path);
        return;
      }
    },
    { capture: true, passive: true }
  );
}
