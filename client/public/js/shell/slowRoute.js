// A screen that does not open (owner, 2026-10-29/30: "Settings is not opening, just spinning", on a computer, not reproducible here).
// While a screen is being opened, shell/routes.js notes which step it is on (styles, texts, its code, drawing it). If the screen has not
// appeared after SLOW_MS, a bar at the top says so and offers a plain reload and a CLEAN reload (the app's installed copy is thrown away
// and downloaded again: the cure for a stuck service worker or a half-updated copy), and the step it hung on is reported to the server
// (Settings > System health > app errors), so the real cause can be found.
import { t } from "../i18n.js";
import { api } from "../api.js";
import { APP_VERSION } from "../version.js";

export const SLOW_MS = 6000;
let bar = null;

export async function cleanReload() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await globalThis.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // whatever could be cleared is cleared; the reload below still helps
  }
  location.reload();
}

export function hideSlowBar() {
  bar?.remove();
  bar = null;
}

export function showSlowBar({ hash, stage, startedAt }) {
  const waited = Math.round((Date.now() - startedAt) / 1000);
  api.reportClientError({
    kind: "slow_screen",
    message: `Screen ${hash} not open after ${waited}s (step: ${stage}; app ${APP_VERSION}; service worker ${navigator.serviceWorker?.controller ? "on" : "off"}; ${navigator.onLine ? "online" : "offline"}; width ${innerWidth})`,
    url: location.href,
    duration_ms: Date.now() - startedAt,
  }).catch(() => {});
  if (bar) return;
  bar = document.createElement("div");
  bar.className = "slow-route-bar";
  bar.setAttribute("role", "alert");
  bar.innerHTML = `
    <span class="slow-route-text">${t("slow_route_text")}</span>
    <button type="button" class="btn" id="slow-route-reload">${t("slow_route_reload")}</button>
    <button type="button" class="btn btn-primary" id="slow-route-clean">${t("slow_route_clean")}</button>`;
  bar.querySelector("#slow-route-reload").addEventListener("click", () => location.reload());
  bar.querySelector("#slow-route-clean").addEventListener("click", (e) => {
    e.currentTarget.disabled = true;
    cleanReload();
  });
  document.body.appendChild(bar);
}
