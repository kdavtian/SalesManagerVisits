// KAD kit - was the screen change a Back / Forward, or a tap in the app? (owner, 2026-11-04: Navigation API where the browser has it).
// The browser's Navigation API tells it exactly (Chrome / Edge / Android; Safari in its newest versions). Without it the answer is null and
// the app keeps its own guess (Field Visits: the 0.8 s "programmatic" flag; KAD OS: "not from a tap").
//
//   lastNavigation()  -> { type: "push" | "replace" | "traverse" | "reload", back: bool|null, at } for the last 1.5 s, else null
//   navigationApi     -> true when the browser has it
// IDENTICAL in KAD OS and Field Visits (js/kit/).
const nav = typeof window !== "undefined" ? window.navigation : undefined;
export const navigationApi = Boolean(nav?.addEventListener);
let last = null;

if (navigationApi) {
  nav.addEventListener("navigate", (e) => {
    const from = nav.currentEntry?.index ?? 0;
    const to = e.destination?.index ?? -1;
    last = { type: e.navigationType, back: e.navigationType === "traverse" ? to < from : null, at: performance.now() };
  });
}

export function lastNavigation() {
  return last && performance.now() - last.at < 1500 ? last : null;
}

/** true / false when the browser said whether the last change was Back/Forward; null when it cannot tell. */
export function wasTraverse() {
  const l = lastNavigation();
  return l ? l.type === "traverse" : null;
}
