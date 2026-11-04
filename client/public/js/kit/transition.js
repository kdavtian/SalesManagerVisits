// KAD kit - a short, calm change between screens (owner, 2026-11-04: "fluent"), with the browser's View Transitions API.
// Only the moment the new screen replaces the old one is animated (a fade of about 140 ms): `swap` must be the SYNCHRONOUS DOM change, never
// the loading (during a transition the old picture stays frozen until swap returns, and taps wait for it). No animation:
//   - on Back / Forward (the phones animate their own back swipe; a second animation was the "ghost" of 2026-10-26),
//   - with "reduce motion" on, in the app's power-saving mode (enabled: false), while the page is hidden, or a transition still runs,
//   - in a browser without the API (Safari < 18, older Android WebViews): swap simply runs, as before.
//
//   screenSwap(swap, { enabled, traverse })  -> returns whatever swap returns
//   CSS (in the app's stylesheet, see kit/README.md): the ::view-transition-* durations and the reduced-motion rule.
// IDENTICAL in KAD OS and Field Visits (js/kit/).
let running = null;

export function transitionsSupported() {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function";
}

export function screenSwap(swap, { enabled = true, traverse = false } = {}) {
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!enabled || traverse || calm || !transitionsSupported() || document.visibilityState !== "visible") return swap();
  if (running) {
    try {
      running.skipTransition();
    } catch {
      /* already finished */
    }
  }
  let result;
  try {
    running = document.startViewTransition(() => {
      result = swap();
    });
    running.finished.finally(() => {
      running = null;
    });
    // updateCallbackDone rejects when swap threw: surface it like a plain call would
    running.updateCallbackDone.catch((err) => console.error(err));
  } catch {
    running = null;
    return swap();
  }
  return result;
}
