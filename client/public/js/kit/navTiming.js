// KAD kit - how long a tap takes to become a screen, measured on the real phones (owner, 2026-11-04: "measure every tap").
// Start: the last finger / mouse / key press (any, caught here). End: the app calls screenReady(route) once the screen shows its content.
// Also the slow interactions the browser itself reports (Event Timing, the base of INP), with the screen they happened on.
// Nothing private is recorded: a route is the screen's address with numbers replaced by ":id" and no query (routeKey).
// Samples are sent in batches (every minute while there are any, and when the app goes to the background) through the app's `send`.
//
//   installNavTiming({ send, currentRoute })   send(batch) -> void (use navigator.sendBeacon or a keepalive fetch); currentRoute() -> string
//   screenReady(route)                         call when a screen is drawn (the router, after the view's first paint)
//   routeKey(hashOrPath)                       "#/customers/123?tab=2" -> "#/customers/:id"
// Batch item: { route, ms, kind: "nav" | "inp", at: ISO time }. Kept small: at most 40 per batch, nav > 15 s ignored (a tap that was not one).
// IDENTICAL in KAD OS and Field Visits (js/kit/).
const MAX_BATCH = 40;
const MAX_MS = 15000;
const FLUSH_MS = 60000;
let lastInput = 0;
let queue = [];
let sendRef = null;
let routeRef = () => location.hash;
let timer = 0;

export function routeKey(hash) {
  return (
    String(hash || "")
      .split("?")[0]
      .replace(/\/\d+(?=\/|$)/g, "/:id")
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
      .slice(0, 80) || "#/"
  );
}

function push(item) {
  if (!sendRef) return;
  queue.push(item);
  if (queue.length >= MAX_BATCH) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(timer);
  timer = 0;
  if (!queue.length || !sendRef) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    sendRef(batch);
  } catch {
    /* measuring never breaks the app */
  }
}

export function screenReady(route) {
  if (!lastInput) return;
  const ms = Math.round(performance.now() - lastInput);
  lastInput = 0; // one screen per press
  if (ms < 0 || ms > MAX_MS) return;
  push({ route: routeKey(route), ms, kind: "nav", at: new Date().toISOString() });
}

export function installNavTiming({ send, currentRoute } = {}) {
  if (installNavTiming.done) return;
  installNavTiming.done = true;
  sendRef = send;
  if (currentRoute) routeRef = currentRoute;
  const mark = () => {
    lastInput = performance.now();
  };
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, mark, { capture: true, passive: true });
  window.addEventListener("popstate", mark, { capture: true }); // a Back swipe is a press too
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.interactionId || entry.duration < 200) continue;
        push({ route: routeKey(routeRef()), ms: Math.round(entry.duration), kind: "inp", at: new Date().toISOString() });
      }
    }).observe({ type: "event", durationThreshold: 200, buffered: false });
  } catch {
    /* Event Timing not in this browser (Safari): only the screen timings are sent */
  }
}

/** For tests: what is waiting to be sent. */
export const pendingTimings = () => queue.slice();
