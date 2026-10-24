// iPhone: a tap on the status bar (the clock / battery strip at the very top) scrolls to the top (owner, 2026-10-24: it only worked when
// tapping right under the front camera). iOS sends that tap to the DOCUMENT's scroll view, but this app scrolls inside #app (the document itself is
// locked, see styles.css), so the system gesture had nothing to scroll; only the middle of the strip reached our own top-bar handler.
// Trick: on iPhone (installed app only) the document gets 1 px of scroll room and rests at 1 px. The status-bar tap then scrolls the document
// to 0, which we notice as a scroll event, scroll the real list (or the open sheet) to its top and put the document back at 1 px.
const isIPhone = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isInstalled = () => navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;

// OFF by default (owner, 2026-10-24, twice: "the app scrolls up by itself on all pages"): the 1 px trick makes the whole document scrollable, and iOS
// moves it for reasons we cannot see from here (toolbars, rubber-band, layout changes). A person who wants the status-bar tap turns it on in Settings.
const PREF_KEY = "fieldvisits_statusbar_tap";
export function statusBarTapAvailable() {
  return isIPhone() && isInstalled();
}
export function getStatusBarTapPref() {
  try {
    return localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}
export function setStatusBarTapPref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {}
  if (on) installStatusBarTap({ force: true });
  else uninstallStatusBarTap();
}

const scrollableIn = (root) =>
  [root, ...root.querySelectorAll("*")].find((el) => {
    const o = getComputedStyle(el).overflowY;
    return (o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight + 1;
  });

// What the person is looking at: the topmost open sheet that scrolls, else the page.
export function scrollTargetForStatusTap() {
  const overlays = document.querySelectorAll('.sheet-overlay, [role="dialog"]');
  for (let i = overlays.length - 1; i >= 0; i--) {
    const found = scrollableIn(overlays[i]);
    if (found) return found;
  }
  return document.getElementById("app");
}

// `force` is for tests (a desktop browser is not an installed iPhone app).
let active = false;
let installed = false;
export function uninstallStatusBarTap() {
  active = false;
  document.documentElement.classList.remove("ios-statusbar-scroll");
  window.scrollTo(0, 0);
}

export function installStatusBarTap({ force = false } = {}) {
  if (!force && !(statusBarTapAvailable() && getStatusBarTapPref())) return false;
  const html = document.documentElement;
  html.classList.add("ios-statusbar-scroll");
  active = true;
  if (installed) {
    window.scrollTo(0, 1);
    return true;
  }
  installed = true;
  let quietUntil = Date.now() + 800; // the first moments, a keyboard closing, the app coming back: iOS may reset the scroll by itself
  const quiet = (ms = 800) => (quietUntil = Date.now() + ms);
  const rest = () => window.scrollTo(0, 1);
  let busy = false;
  // A real status-bar tap reaches the page as a bare scroll to 0 with NO finger on the screen. A finger that drags the top bar / the nav bar /
  // a sheet backdrop, or a list whose momentum runs out at its edge, also moves the 1 px document to 0 -- and that must never throw the list
  // back to its top (owner, 2026-10-24: "the app is scrolling up constantly"). So a scroll to 0 only counts when no touch is active and none
  // ended in the last TOUCH_GRACE_MS (a long flick keeps scrolling for a while after the finger lifts).
  const TOUCH_GRACE_MS = 2500;
  let touching = 0;
  let lastTouchAt = 0;
  const touchNote = (e) => {
    lastTouchAt = Date.now();
    touching = e.touches ? e.touches.length : 0;
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) document.addEventListener(type, touchNote, { capture: true, passive: true });
  window.addEventListener("wheel", () => (lastTouchAt = Date.now()), { capture: true, passive: true });
  window.addEventListener(
    "scroll",
    () => {
      if (!active || busy || window.scrollY >= 1) return;
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing || Date.now() < quietUntil || touching > 0 || Date.now() - lastTouchAt < TOUCH_GRACE_MS) {
        rest();
        return;
      }
      busy = true;
      scrollTargetForStatusTap()?.scrollTo({ top: 0, behavior: "instant" });
      requestAnimationFrame(() => {
        rest();
        busy = false;
      });
    },
    { passive: true }
  );
  document.addEventListener("focusin", () => quiet(), true);
  document.addEventListener("focusout", () => quiet(), true);
  window.addEventListener("pageshow", () => quiet());
  window.addEventListener("orientationchange", () => quiet());
  window.visualViewport?.addEventListener("resize", () => quiet());
  rest();
  return true;
}
