import { t } from "./i18n.js";

// Full-screen photo viewer -- tap a photo to open it, swipe or use the
// arrow buttons/keys to move between the rest of that visit's photos,
// tap outside/the close button/Escape to dismiss.
export function openPhotoLightbox(urls, startIndex) {
  let index = startIndex;
  const overlay = document.createElement("div");
  overlay.className = "photo-lightbox-overlay";
  overlay.innerHTML = `
    <button type="button" class="photo-lightbox-close" aria-label="${t("cancel")}">&times;</button>
    <img class="photo-lightbox-img" src="${urls[index]}" alt="${t("photo_optional")}" />
    ${
      urls.length > 1
        ? `<button type="button" class="photo-lightbox-nav photo-lightbox-prev" aria-label="${t("previous")}">&#8249;</button>
           <button type="button" class="photo-lightbox-nav photo-lightbox-next" aria-label="${t("next")}">&#8250;</button>
           <div class="photo-lightbox-counter">${index + 1} / ${urls.length}</div>`
        : ""
    }
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const imgEl = overlay.querySelector(".photo-lightbox-img");
  const counterEl = overlay.querySelector(".photo-lightbox-counter");

  function show(i) {
    index = (i + urls.length) % urls.length;
    imgEl.src = urls[index];
    if (counterEl) counterEl.textContent = `${index + 1} / ${urls.length}`;
    resetZoom();
  }

  // --- Pinch / double-tap zoom, scoped to this one <img> ----------------
  // index.html's viewport meta disables native pinch/double-tap zoom for
  // the whole app on purpose (maximum-scale=1, user-scalable=no -- it stops
  // an accidental double-tap on a button from zooming the entire UI), and
  // that global choice shouldn't be unwound just for this screen. So the
  // lightbox implements its own zoom entirely in JS instead, scoped to the
  // image element: two-finger pinch or a double-tap scales it, a
  // single-finger drag pans it while zoomed. Swipe-to-change-photo and
  // tap-outside-to-close (wired below) only fire while at 1x.
  let scale = 1;
  let originX = 0;
  let originY = 0;
  let lastTapTime = 0;
  let pinchStartDist = null;
  let pinchStartScale = 1;
  let panStart = null;

  function applyTransform() {
    imgEl.style.transform = scale === 1 ? "" : `translate(${originX}px, ${originY}px) scale(${scale})`;
  }

  function resetZoom() {
    scale = 1;
    originX = 0;
    originY = 0;
    applyTransform();
  }

  function clampOrigin() {
    const maxOffsetX = ((scale - 1) * imgEl.clientWidth) / 2;
    const maxOffsetY = ((scale - 1) * imgEl.clientHeight) / 2;
    originX = Math.max(-maxOffsetX, Math.min(maxOffsetX, originX));
    originY = Math.max(-maxOffsetY, Math.min(maxOffsetY, originY));
  }

  function touchDistance(t0, t1) {
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  }

  function zoomTo(targetScale) {
    scale = targetScale;
    originX = 0;
    originY = 0;
    applyTransform();
  }

  imgEl.style.touchAction = "none";
  imgEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        pinchStartScale = scale;
        panStart = null;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          zoomTo(scale > 1 ? 1 : 2.5);
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
        panStart = scale > 1 ? { x: e.touches[0].clientX - originX, y: e.touches[0].clientY - originY } : null;
      }
    },
    { passive: true }
  );
  imgEl.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        const dist = touchDistance(e.touches[0], e.touches[1]);
        scale = Math.min(4, Math.max(1, pinchStartScale * (dist / pinchStartDist)));
        clampOrigin();
        applyTransform();
        e.preventDefault();
      } else if (e.touches.length === 1 && panStart && scale > 1) {
        originX = e.touches[0].clientX - panStart.x;
        originY = e.touches[0].clientY - panStart.y;
        clampOrigin();
        applyTransform();
        e.preventDefault();
      }
    },
    { passive: false }
  );
  imgEl.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
    if (e.touches.length === 0) {
      panStart = null;
      if (scale < 1.05) resetZoom();
    }
  });
  // A double-click stands in for a double-tap on non-touch input (trackpad,
  // and this is also what a Playwright test drives to exercise the path).
  imgEl.addEventListener("dblclick", () => zoomTo(scale > 1 ? 1 : 2.5));

  function close() {
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(index - 1);
    else if (e.key === "ArrowRight") show(index + 1);
  }

  overlay.querySelector(".photo-lightbox-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".photo-lightbox-prev")?.addEventListener("click", () => show(index - 1));
  overlay.querySelector(".photo-lightbox-next")?.addEventListener("click", () => show(index + 1));
  document.addEventListener("keydown", onKey);

  let touchStartX = null;
  overlay.addEventListener(
    "touchstart",
    (e) => {
      // Only track a swipe when it's a plain single-finger gesture that
      // starts at 1x zoom -- a pinch (2 touches) or a pan while zoomed in
      // must never be reinterpreted as "swipe to next/previous photo".
      touchStartX = e.touches.length === 1 && scale === 1 ? e.touches[0].clientX : null;
    },
    { passive: true }
  );
  overlay.addEventListener("touchend", (e) => {
    if (touchStartX == null || scale !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
    touchStartX = null;
  });
}
