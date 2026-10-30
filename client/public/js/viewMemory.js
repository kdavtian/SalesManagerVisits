// Where the person was, kept on the phone (owner, 2026-10-30): "reopening from the icon goes back to where you were: the last screen, at the same
// scroll, with its filters, tab and search". The app saves the screen on display (its address, how far it is scrolled, and -- for the lists that
// offer it: Customers, Orders, Activity -- the search, tab, sort and filters) whenever it goes to the background and now and then while it is
// open. A fresh start (the phone closed the app, an update reloaded it) opens that screen instead of Home, only for the same signed-in person
// and only within MAX_AGE_MS. A screen's address never carries anything private: the saved record has no customer data, only settings of the
// list (which tab, which filters).
const KEY = "fv_last_view";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Screens that are in the middle of doing something (a new order, a check-in, adding a place on the map): never reopened by themselves.
const NOT_RESTORED = /^#\/(?:login|checkin\/|orders\/new\/|payments\/new|map\?(?:.*&)?(?:add|relocate|plan)=|route-plan-sets\/)/;
const SCROLL_WAIT_MS = 4000;
const SAME_SCREEN_MS = 10 * 60 * 1000; // a reload onto the screen that was just left (an update)

// { hash, scroll, state, until } -- for the screen it belongs to, while the app is starting. The screen can be built twice at start-up (once from the
// saved user, once when the server confirms it), so the state stays readable for STATE_WAIT_MS instead of being used up by the first read.
const STATE_WAIT_MS = 8000;
let pending = null;

// Sets are saved as { "__set": [...] } and come back as Sets (the lists keep their filters in Sets).
const replacer = (_key, value) => (value instanceof Set ? { __set: [...value] } : value);
const reviver = (_key, value) => (value && typeof value === "object" && Array.isArray(value.__set) ? new Set(value.__set) : value);

function readRecord() {
  try {
    const record = JSON.parse(localStorage.getItem(KEY) || "null", reviver);
    return record && typeof record.hash === "string" ? record : null;
  } catch {
    return null;
  }
}

/** Saves the screen on display. `read()` gives { hash, scroll, state }; nothing is saved for a screen that must not be reopened. */
export function saveView(userId, read) {
  try {
    const view = read();
    if (!view || !view.hash || NOT_RESTORED.test(view.hash)) return;
    localStorage.setItem(KEY, JSON.stringify({ userId, savedAt: Date.now(), ...view }, replacer));
  } catch {
    // storage full or blocked: the app simply opens on Home as before
  }
}

export function forgetView() {
  pending = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}

/** The address to open instead of Home on a fresh start, or null. Keeps the rest (scroll, filters) for the screen that opens. */
export function viewToReopen(userId, currentHash) {
  const base = (currentHash || "").split("?")[0];
  const record = readRecord();
  if (base && base !== "#/" && base !== "#/dashboard") {
    // The app was opened ON a screen (a link, a notification, or a reload onto the same screen after an update): that screen stays; a reload of
    // the very screen that was just left (the page saves itself as it goes) also gets its scroll, search and filters back.
    if (record && record.userId === userId && Date.now() - record.savedAt < SAME_SCREEN_MS && record.hash.split("?")[0] === base) {
      pending = { hash: record.hash, scroll: Number(record.scroll) || 0, state: record.state ?? null, until: Date.now() + STATE_WAIT_MS };
    }
    return null;
  }
  if (!record || record.userId !== userId || Date.now() - record.savedAt > MAX_AGE_MS) return null;
  if (record.hash.split("?")[0] === "#/dashboard" || NOT_RESTORED.test(record.hash)) return null;
  pending = { hash: record.hash, scroll: Number(record.scroll) || 0, state: record.state ?? null, until: Date.now() + STATE_WAIT_MS };
  return record.hash;
}

/** The list settings saved for the screen named `name` (one of customers / orders / activity); null when the screen was not just reopened. */
export function takeViewState(name, hash = location.hash) {
  if (!pending?.state || Date.now() > pending.until || pending.hash.split("?")[0] !== hash.split("?")[0] || pending.state.screen !== name) return null;
  return pending.state;
}

/** Scrolls #app to where the person was, as soon as the screen is tall enough (lists fill in after they open). One try per reopened screen. */
export function restoreScroll(app, hash = location.hash) {
  if (!pending || !pending.scroll || pending.hash.split("?")[0] !== hash.split("?")[0]) return;
  const target = pending.scroll;
  pending.scroll = 0; // once per reopened screen
  const startedAt = Date.now();
  const step = () => {
    if (app.scrollHeight - app.clientHeight >= target || Date.now() - startedAt > SCROLL_WAIT_MS) {
      app.scrollTop = target;
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
