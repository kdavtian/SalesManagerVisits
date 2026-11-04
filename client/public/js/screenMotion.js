// The short, calm change between screens (owner, 2026-11-04: "fluent"), with the shared KAD kit (js/kit/transition.js).
// - A tab that comes back with its pages (shell/tabs.js) fades from the old screen to the kept one (View Transitions API, ~140 ms).
// - A screen opened by a tap fades in as it is drawn (a CSS fade on #app's new content; the loading itself is never held back).
// Never on Back / Forward (the phone animates its own back swipe; a second animation was the "ghost" of 2026-10-26), never with "reduce
// motion" on, and never in the power-saving performance mode (Settings).
import { screenSwap } from "./kit/transition.js";
import { getPerfMode } from "./perfMode.js";

const ENTER_CLASS = "screen-enter";
const ENTER_MS = 500;
let enterTimer = 0;

const motionAllowed = () => {
  try {
    return getPerfMode() !== "efficiency";
  } catch {
    return true;
  }
};

/** Runs `swap` (a synchronous DOM change) inside a view transition when allowed. The DOM change may happen a frame later. */
export function swapScreen(swap, { traverse = false } = {}) {
  return screenSwap(swap, { enabled: motionAllowed(), traverse });
}

/** Marks #app so the screen drawn next fades in (css/styles.css .screen-enter); cleared after ENTER_MS so later redraws do not fade. */
export function markScreenEnter(app, { traverse = false } = {}) {
  clearTimeout(enterTimer);
  app.classList.remove(ENTER_CLASS);
  if (traverse || !motionAllowed() || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  app.classList.add(ENTER_CLASS);
  enterTimer = setTimeout(() => app.classList.remove(ENTER_CLASS), ENTER_MS);
}
