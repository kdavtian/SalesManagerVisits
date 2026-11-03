// Usage analytics (owner, 2026-11-03): which screens are opened, for how long, and which menu / tab / Home buttons are tapped. Sends a small batch
// every minute (and when the app goes to the background) ONLY while the admin's switch is on: the server answers { enabled: false } to the
// first batch otherwise and the tracker stops for the rest of the session. No ids, search text, names or amounts are ever collected: a screen is
// its address with numbers turned into ":id" (also done again on the server), a tap is the button's own id.
import { api } from "./api.js";

const FLUSH_MS = 60000;
const FIRST_FLUSH_MS = 30000;
const MAX_BUFFER = 150;
let started = false;
let off = false;
let events = [];
let page = null; // { key, seconds, since }
let timer = null;

const keyOf = (hash) => {
  const h = String(hash || "#/dashboard").split("?")[0];
  return h.replace(/\/\d+(?=\/|$)/g, "/:id");
};

function closePage() {
  if (!page) return;
  const now = Date.now();
  if (page.since) page.seconds += (now - page.since) / 1000;
  const seconds = Math.round(page.seconds);
  if (seconds >= 1) events.push({ kind: "page", target: page.key, seconds });
  page = null;
}

function openPage() {
  page = { key: keyOf(location.hash), seconds: 0, since: document.hidden ? null : Date.now() };
}

function tapTarget(el) {
  const nav = el.closest(".nav-item, .nav-item-center");
  if (nav?.dataset.hash) return `nav:${keyOf(nav.dataset.hash)}`;
  const home = el.closest(".quick-action[id]");
  if (home) return `home:${home.id}`;
  const top = el.closest(".topbar-menu-btn[id]");
  if (top) return `top:${top.id}`;
  return null;
}

async function flush() {
  if (off) return;
  // the screen that is open right now counts up to this moment, and goes on
  if (page) {
    const keep = page.key;
    closePage();
    page = { key: keep, seconds: 0, since: document.hidden ? null : Date.now() };
  }
  if (!events.length) return;
  const batch = events.splice(0, events.length);
  try {
    const r = await api.postUsageEvents(batch);
    if (r?.enabled === false) {
      off = true;
      events = [];
    }
  } catch {
    events = [...batch, ...events].slice(-MAX_BUFFER); // offline: try again with the next batch
  }
}

export function startUsageTracking() {
  if (started) return;
  started = true;
  openPage();
  window.addEventListener("hashchange", () => {
    if (off) return;
    closePage();
    openPage();
  });
  document.addEventListener("visibilitychange", () => {
    if (off || !page) return;
    if (document.hidden) {
      if (page.since) page.seconds += (Date.now() - page.since) / 1000;
      page.since = null;
      flush();
    } else {
      page.since = Date.now();
    }
  });
  document.addEventListener(
    "click",
    (e) => {
      if (off || !(e.target instanceof Element)) return;
      const target = tapTarget(e.target);
      if (target && events.length < MAX_BUFFER) events.push({ kind: "tap", target });
    },
    { capture: true, passive: true }
  );
  setTimeout(flush, FIRST_FLUSH_MS);
  timer = setInterval(flush, FLUSH_MS);
}

export function stopUsageTracking() {
  clearInterval(timer);
}
