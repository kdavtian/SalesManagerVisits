// iPhone: a tap on the status bar (the clock / battery strip at the very top) scrolls to the top (owner, 2026-10-24: it only worked when
// tapping right under the front camera). iOS sends that tap to the DOCUMENT's scroll view, but this app scrolls inside #app (the document itself is
// locked, see styles.css), so the system gesture had nothing to scroll; only the middle of the strip reached our own top-bar handler.
// Trick: on iPhone (installed app only) the document gets 1 px of scroll room and rests at 1 px. The status-bar tap then scrolls the document
// to 0, which we notice as a scroll event, scroll the real list (or the open sheet) to its top and put the document back at 1 px.
const isIPhone = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isInstalled = () => navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;

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
export function installStatusBarTap({ force = false } = {}) {
  if (!force && !(isIPhone() && isInstalled())) return false;
  const html = document.documentElement;
  html.classList.add("ios-statusbar-scroll");
  let quietUntil = Date.now() + 800; // the first moments, a keyboard closing, the app coming back: iOS may reset the scroll by itself
  const quiet = (ms = 800) => (quietUntil = Date.now() + ms);
  const rest = () => window.scrollTo(0, 1);
  let busy = false;
  window.addEventListener(
    "scroll",
    () => {
      if (busy || window.scrollY >= 1) return;
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing || Date.now() < quietUntil) {
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
