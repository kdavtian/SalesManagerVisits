import { api } from "./api.js";
import { broadcastsLocation } from "./state.js";

const INTERVAL_MS = 60000;
let timerId = null;

function ping() {
  if (document.hidden || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      api.postLocation(pos.coords.latitude, pos.coords.longitude).catch(() => {});
    },
    () => {},
    { maximumAge: 30000, timeout: 10000 }
  );
}

function onVisibilityChange() {
  if (!document.hidden) ping();
}

// Foreground-only: a single getCurrentPosition() ping on an interval,
// paused whenever the tab isn't visible. Never runs in a background
// service worker and never uses watchPosition, so it stops the moment the
// app is closed or backgrounded.
export function startLocationBroadcast() {
  if (timerId || !broadcastsLocation()) return;
  ping();
  timerId = setInterval(ping, INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

export function stopLocationBroadcast() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}
