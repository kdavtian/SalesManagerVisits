// The search field of Settings behaves like the one in iOS Settings (owner, 2026-11-05): when the page opens it is hidden under the title; a
// swipe down shows it, a swipe up hides it, and when a finger lets go half-way it slides to the nearer end (the same ease as iOS). It stays
// open while it is focused or holds text. Phones and tablets only: a computer shows it all the time.
//
// How: the field is the first thing under the (sticky) title, the page is scrolled down by the field's own height at start, and a short
// pause after the last scroll the position is moved to 0 or to that height with a smooth scroll. The bar fades with the distance.
const SNAP_PAUSE_MS = 110;

export function installSearchCollapse({ app, view, wrap, input }) {
  const phone = window.matchMedia("(max-width: 1023px)");
  let span = 0;
  let touching = false;
  let timer = 0;

  const measure = () => {
    if (!phone.matches || wrap.hidden || !wrap.offsetHeight) return (span = 0);
    const cs = getComputedStyle(wrap);
    return (span = wrap.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
  };
  // The page must be tall enough to scroll the field away, even when its list is short.
  const makeRoom = () => {
    view.style.paddingBottom = "";
    const need = span - (app.scrollHeight - app.clientHeight);
    if (span && need > 0) view.style.paddingBottom = `${Math.ceil(need)}px`;
  };
  const fade = () => {
    const ratio = span ? Math.min(1, Math.max(0, app.scrollTop / span)) : 0;
    wrap.style.opacity = String(1 - ratio * 0.85);
  };
  const keepOpen = () => document.activeElement === input || input.value.trim() !== "";
  const snap = () => {
    if (!span || touching || keepOpen()) return;
    const top = app.scrollTop;
    if (top <= 0 || top >= span) return;
    app.scrollTo({ top: top > span / 2 ? span : 0, behavior: "smooth" });
  };
  const gone = () => !view.isConnected;
  const cleanup = () => {
    app.removeEventListener("scroll", onScroll);
    app.removeEventListener("touchstart", onTouchStart);
    app.removeEventListener("touchend", onTouchEnd);
    app.removeEventListener("touchcancel", onTouchEnd);
    phone.removeEventListener("change", refresh);
    input.removeEventListener("focus", reveal);
    clearTimeout(timer);
  };
  function onScroll() {
    if (gone()) return cleanup();
    fade();
    clearTimeout(timer);
    timer = setTimeout(snap, SNAP_PAUSE_MS);
  }
  function onTouchStart() {
    touching = true;
  }
  function onTouchEnd() {
    touching = false;
    clearTimeout(timer);
    timer = setTimeout(snap, SNAP_PAUSE_MS);
  }
  function reveal() {
    if (span && app.scrollTop > 0) app.scrollTo({ top: 0, behavior: "smooth" });
  }
  /** Called when the page changes (a category opens, the search shows results): measures again; `hide` = start with the field hidden. */
  function refresh({ hide = false } = {}) {
    if (gone()) return cleanup();
    measure();
    makeRoom();
    if (hide && span && app.scrollTop < 1 && !keepOpen()) app.scrollTop = span;
    fade();
  }

  app.addEventListener("scroll", onScroll, { passive: true });
  app.addEventListener("touchstart", onTouchStart, { passive: true });
  app.addEventListener("touchend", onTouchEnd, { passive: true });
  app.addEventListener("touchcancel", onTouchEnd, { passive: true });
  phone.addEventListener("change", refresh);
  input.addEventListener("focus", reveal);
  // after the first layout
  requestAnimationFrame(() => refresh({ hide: true }));
  return refresh;
}
