// How long each app launch took on THIS device (owner, 2026-10-26: "takes like 5 seconds to open the app, white screen"). A slow start can only be
// judged on the phone it happens on, so every launch leaves a few numbers in localStorage and Settings > About shows the last ones. Nothing leaves
// the device. All times are milliseconds since the launch began (performance.now() starts at navigation start).
import { APP_VERSION } from "./version.js";

const KEY = "fv_launch_timings";
const KEEP = 8;
let saved = false;

// Called once, the moment the app's header and tab bar first appear.
export function markShellShown() {
  if (saved) return;
  saved = true;
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
    const entry = {
      at: Date.now(),
      v: APP_VERSION,
      // first-paint = how long the screen stayed white; ready = header + tab bar visible
      fp: paint["first-paint"] ?? null,
      ready: Math.round(performance.now()),
      // service worker: was it controlling this launch, and how long it took to start answering (iPhone: the worker has to wake up first)
      sw: navigator.serviceWorker?.controller ? 1 : 0,
      swStart: nav && nav.workerStart > 0 ? Math.round(nav.fetchStart - nav.workerStart) : null,
      reply: nav ? Math.round(nav.responseStart) : null,
    };
    const list = readLaunchTimings();
    list.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, KEEP)));
  } catch {
    /* private mode / storage blocked: no history, nothing else affected */
  }
}

export function readLaunchTimings() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
