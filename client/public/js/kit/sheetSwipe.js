// KAD kit - pull a bottom sheet down to close it, like an iPhone sheet (owner, 2026-11-04).
// The drag starts on the grab handle / header, or anywhere in the sheet while its content is scrolled to the top; a list that can still
// scroll up keeps scrolling. Released past a quarter of the sheet's height (or flicked down fast) the sheet slides away and onClose runs;
// otherwise it springs back. Only where the sheet IS a bottom sheet (phone width by default); a centred desktop dialog is left alone.
//
//   enableSwipeDown(panel, { onClose, handle, when, isLocked })
//     panel    - the sheet element that moves (translateY)
//     onClose  - () => void: close it the app's own way (called once the slide-out finished)
//     handle   - CSS selector inside the panel that always starts a drag (grab bar, header); default ".sheet-grab, .sheet-head, .sheet-header"
//     when     - media query where this applies; default "(max-width: 767px)"
//     isLocked - () => bool: a sheet that must be answered first does not move
// Touch events (not pointer events): a pointer drag would make the browser cancel it as soon as it starts its own scrolling.
// IDENTICAL in KAD OS and Field Visits (js/kit/).
const THRESHOLD = 0.25;
const FLICK = 0.6; // px per ms
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function scrollerAbove(target, panel) {
  for (let n = target; n && n !== panel.parentNode; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
    if (n === panel) break;
  }
  return null;
}

export function enableSwipeDown(panel, { onClose, handle = ".sheet-grab, .sheet-head, .sheet-header", when = "(max-width: 767px)", isLocked = () => false } = {}) {
  if (!panel || panel.dataset.kadSwipe) return;
  panel.dataset.kadSwipe = "1";
  let y0 = 0;
  let x0 = 0;
  let t0 = 0;
  let dy = 0;
  let state = "idle"; // idle | maybe | drag | off

  panel.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || isLocked() || !window.matchMedia?.(when).matches) {
        state = "off";
        return;
      }
      const target = e.target;
      if (target.closest?.("input, textarea, select, [contenteditable], .no-swipe")) {
        state = "off";
        return;
      }
      const onHandle = Boolean(target.closest?.(handle));
      const scroller = onHandle ? null : scrollerAbove(target, panel);
      state = onHandle || !scroller || scroller.scrollTop <= 0 ? "maybe" : "off";
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      t0 = performance.now();
      dy = 0;
    },
    { passive: true }
  );

  panel.addEventListener(
    "touchmove",
    (e) => {
      if (state === "off" || state === "idle") return;
      const ny = e.touches[0].clientY - y0;
      const nx = e.touches[0].clientX - x0;
      if (state === "maybe") {
        if (Math.abs(nx) > Math.abs(ny) || ny < 0) {
          state = "off"; // sideways, or up: the content's own gesture
          return;
        }
        if (ny < 8) return;
        state = "drag";
        panel.style.transition = "none";
        panel.style.willChange = "transform";
      }
      dy = Math.max(0, ny);
      panel.style.transform = `translateY(${dy}px)`;
      e.preventDefault(); // the page and the list underneath stay still
    },
    { passive: false }
  );

  const end = () => {
    if (state !== "drag") {
      state = "idle";
      return;
    }
    state = "idle";
    const speed = dy / Math.max(1, performance.now() - t0);
    const out = dy > panel.offsetHeight * THRESHOLD || speed > FLICK;
    panel.style.willChange = "";
    if (out) {
      if (reduced()) {
        onClose?.();
        return;
      }
      panel.style.transition = "transform 180ms cubic-bezier(.2,.8,.2,1)";
      panel.style.transform = "translateY(100%)";
      setTimeout(() => onClose?.(), 170);
    } else {
      panel.style.transition = reduced() ? "none" : "transform 200ms cubic-bezier(.2,.8,.2,1)";
      panel.style.transform = "";
      setTimeout(() => {
        panel.style.transition = "";
      }, 210);
    }
  };
  panel.addEventListener("touchend", end, { passive: true });
  panel.addEventListener("touchcancel", end, { passive: true });
}
