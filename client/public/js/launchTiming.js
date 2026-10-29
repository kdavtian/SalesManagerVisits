// How long each app launch took on THIS device (owner, 2026-10-26: "takes like 5 seconds to open the app, white screen"). A slow start can only be
// judged on the phone it happens on, so every launch leaves a few numbers in localStorage and Settings > About shows the last ones. Nothing leaves
// the device.
//
// The clock (owner, 2026-10-29: "measure from tap on app icon to load"). Phones do not tell a web app when its icon was tapped, so the
// clock starts at the earliest moment anything of the app runs: the service worker waking up for this launch (or, when it was already
// running, receiving the start-page request). That matters on iPhone: Safari starts the page's own clock (performance.now() = 0) only
// AFTER the worker has handed over the start page, so the old record missed everything before the white screen. `pre` = how long before
// the page's clock that start was; page times (fp, ready, screen) are counted from the page's clock, totals add `pre`. A time is saved
// when the frame is DRAWN (after the next paint), not when the code asked for it: the browser paints later than the code runs.
import { APP_VERSION } from "./version.js";

const KEY = "fv_launch_timings";
const KEEP = 8;
let entry = null;
let screenDone = false;

// After the browser has painted the frame the caller just changed (one animation frame + one task).
function afterPaint(fn) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

function store() {
  try {
    const list = readLaunchTimings().filter((e) => e.at !== entry.at);
    list.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, KEEP)));
  } catch {
    /* private mode / storage blocked: no history, nothing else affected */
  }
}

function firstPaint() {
  const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
  return paints["first-paint"] ?? paints["first-contentful-paint"] ?? null;
}

// Called once, the moment the app's header and tab bar first appear.
export function markShellShown() {
  if (entry) return;
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    entry = {
      at: Date.now(),
      v: APP_VERSION,
      // service worker controlling this launch; pre / woke / found are filled in by askWorker() below (Safari reports the navigation's
      // worker and reply times as 0, so they are taken from the worker itself)
      sw: navigator.serviceWorker?.controller ? 1 : 0,
      pre: 0,
      woke: null,
      found: null,
      // first drawing = the end of the white screen (Safari reports only first-contentful-paint)
      fp: firstPaint(),
      // header + tab bar drawn; screen = the first screen (Home) drawn
      ready: Math.round(performance.now()),
      screen: null,
      // "reload" = the page was reloaded (Update button, a fix-up reload), not opened from the icon
      type: nav?.type === "reload" ? "reload" : "open",
    };
  } catch {
    return;
  }
  store();
  afterPaint(() => {
    entry.ready = Math.round(performance.now());
    entry.fp ??= firstPaint(); // the first drawing can come after the code showed the header
    store();
  });
  askWorker();
}

// The service worker's side of this launch (sw.js "launch-times"): when it started and when it got / answered the start-page request.
function askWorker() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker || typeof MessageChannel === "undefined") return;
  const channel = new MessageChannel();
  const timer = setTimeout(() => channel.port1.close(), 3000);
  channel.port1.onmessage = ({ data }) => {
    clearTimeout(timer);
    channel.port1.close();
    const origin = performance.timeOrigin;
    const launch = data?.launch;
    // only the request that opened THIS page (not one from an earlier page the worker also served)
    if (!launch || launch.at < origin - 30000 || launch.at > origin + 5000) return;
    // the start-page request was the first thing the worker handled: it was started (woken) for this launch
    const woke = launch.woke === true;
    const start = Math.min(woke ? data.workerStartedAt : launch.at, origin);
    entry.pre = Math.round(origin - start);
    entry.woke = woke ? 1 : 0;
    entry.found = launch.found ? Math.round(launch.found - start) : null;
    store();
  };
  worker.postMessage({ type: "launch-times" }, [channel.port2]);
}

// Called when the first screen after launch has rendered (app.js render()).
export function markFirstScreenShown() {
  if (!entry || screenDone) return;
  screenDone = true;
  afterPaint(() => {
    entry.screen = Math.max(entry.ready, Math.round(performance.now()));
    store();
  });
}

// A page time (fp, ready, screen) on the launch's own clock, which starts `pre` earlier (see the top of this file).
export function fromLaunchStart(e, ms) {
  return ms == null ? null : ms + (e?.pre ?? 0);
}

// The whole launch: until the first screen was drawn (older records: until the header).
export function launchTotal(e) {
  return fromLaunchStart(e, e?.screen ?? e?.ready ?? null);
}

export function readLaunchTimings() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
