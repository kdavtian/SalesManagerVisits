// Touch-down prefetch: when a finger (or mouse) lands on something that opens
// a detail screen, start that screen's main GET right away so it is already
// in flight -- often finished -- by the time the tap completes. Only the one
// detail request is warmed, it is single-use and expires after a few seconds
// (see api.js prefetchGet), and a scroll or drag that starts on the row is
// cancelled by the browser (pointercancel) before the tap would count.
import { prefetchGet } from "./api.js";
import { warmCustomerCard } from "./customerCardLoader.js";

// [selector, path builder] -- first match wins.
const TARGETS = [
  // Only this app's own orders (numeric ids): ERP order rows reuse data-order-id with the workbook's
  // order number, which is not an /orders/:id -- the prefetch used to 404/500 on every tap.
  ["[data-order-id]", (el) => (/^\d+$/.test(el.dataset.orderId || "") && !el.hasAttribute("data-erp-customer-id") && !el.classList.contains("erp-order-row") ? `/orders/${el.dataset.orderId}` : null)],
  [".customer-name-link[data-customer-id], .activity-customer-name-btn[data-customer-id], .list-row-icon[data-customer-id]", (el) => `/customers/${el.dataset.customerId}`],
  ["button.list-row[data-id]", (el) => (location.hash === "#/customers" ? `/customers/${el.dataset.id}` : null)],
  ["[data-open-id]", (el) => `/products/${el.dataset.openId}`],
];

// The customer card's whole bundle (customerCardLoader.js) is bigger than one request, so it starts after a short pause that a scroll or a
// cancelled touch (pointercancel) cancels -- a finger that lands only to scroll a long list does not fire ten requests per row it crosses.
const CARD_PATH = /^\/customers\/(\d+)$/;
const TOUCH_DELAY_MS = 60;
const HOVER_DELAY_MS = 150; // a mouse resting on a row: the card is usually the next click on a desktop
let cardTimer = null;
const cancelCardWarm = () => {
  clearTimeout(cardTimer);
  cardTimer = null;
};
function scheduleCardWarm(path, delay) {
  const match = CARD_PATH.exec(path || "");
  if (!match) return;
  cancelCardWarm();
  cardTimer = setTimeout(() => {
    cardTimer = null;
    warmCustomerCard(match[1]);
  }, delay);
}
const pathFor = (target) => {
  if (!(target instanceof Element)) return null;
  for (const [selector, buildPath] of TARGETS) {
    const el = target.closest(selector);
    if (el) return buildPath(el);
  }
  return null;
};

export function installTouchPrefetch() {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button > 0 || !(e.target instanceof Element)) return;
      for (const [selector, buildPath] of TARGETS) {
        const el = e.target.closest(selector);
        if (!el) continue;
        const path = buildPath(el);
        if (path && !/\/(undefined|null)$/.test(path)) {
          // A customer card loads as one bundle (customerCardLoader.js), whose first request is this very GET.
          if (CARD_PATH.test(path)) scheduleCardWarm(path, TOUCH_DELAY_MS);
          else prefetchGet(path);
        }
        return;
      }
    },
    { capture: true, passive: true }
  );
  // Lifting the finger is a tap that is about to navigate: start the card now rather than after the delay.
  document.addEventListener(
    "pointerup",
    (e) => {
      if (cardTimer === null) return;
      const path = pathFor(e.target);
      cancelCardWarm();
      const match = CARD_PATH.exec(path || "");
      if (match) warmCustomerCard(match[1]);
    },
    { capture: true, passive: true }
  );
  document.addEventListener("pointercancel", cancelCardWarm, { capture: true, passive: true });
  window.addEventListener("scroll", cancelCardWarm, { capture: true, passive: true });
  document.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType !== "mouse") return;
      const path = pathFor(e.target);
      if (path) scheduleCardWarm(path, HOVER_DELAY_MS);
      else cancelCardWarm();
    },
    { capture: true, passive: true }
  );
}
