// Frontend error monitoring + basic performance metrics (improvement list
// area 7.5): before this, a client-side JS error or a slow page load left
// no trace anywhere except a user happening to mention it. Best-effort
// only -- never lets a report itself throw or block the page it's
// reporting on.
import { api } from "./api.js";

const SLOW_LOAD_MS = 3000;

function report(kind, fields) {
  api.reportClientError({ kind, ...fields }).catch(() => {});
}

export function startErrorMonitoring() {
  window.addEventListener("error", (event) => {
    report("error", {
      message: String(event.message || event.error?.message || "Unknown error"),
      stack: event.error?.stack || null,
      url: location.hash || location.pathname,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    report("unhandledrejection", {
      message: String(reason?.message || reason || "Unhandled rejection"),
      stack: reason?.stack || null,
      url: location.hash || location.pathname,
    });
  });

  // Navigation Timing: how long the initial page load actually took, from
  // the browser's own measurement -- only reported past the threshold, the
  // same "only log what's actually slow" approach as the server's own
  // requestTiming middleware.
  if (window.performance?.getEntriesByType) {
    window.addEventListener("load", () => {
      setTimeout(() => {
        const [nav] = performance.getEntriesByType("navigation");
        if (nav && nav.loadEventEnd > SLOW_LOAD_MS) {
          report("slow_load", {
            message: `Page load took ${Math.round(nav.loadEventEnd)}ms`,
            url: location.hash || location.pathname,
            duration_ms: Math.round(nav.loadEventEnd),
          });
        }
      }, 0);
    });
  }
}
