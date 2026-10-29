// A photo stage that feels like the iPhone Photos app (owner, 2026-10-30: "I want an iPhone native photo viewer in my app. The current one
// is awful: no pinch to zoom, not fast"). One engine for every photo and PDF picture in the app (photoLightbox.js, fileViewer.js):
//   - pinch to zoom around the fingers (up to 6x), double tap to zoom in where you tapped / back out, drag to move a zoomed picture
//     (it stops at the edges, with a little give), and a release outside the picture springs back;
//   - at normal size: swipe left / right for the previous / next picture, swipe down to close;
//   - a computer: the wheel (or a trackpad pinch) zooms at the pointer, drag moves, double click zooms, arrow keys / Esc;
//   - fast: the small copy the list already showed appears at once, the screen-size copy replaces it as soon as it arrives, and the
//     full original is fetched only when the person zooms in past what the screen copy can show.
// The page itself never zooms (index.html turns the browser's own zoom off for the app), so all of this is done here on one element.
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const SWIPE_PX = 60;

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// Fetch a picture before it is needed (the neighbours of the one on screen).
const warmed = new Set();
export function preloadPicture(src) {
  if (!src || warmed.has(src)) return;
  if (warmed.size > 60) warmed.clear();
  warmed.add(src);
  loadImage(src).catch(() => warmed.delete(src));
}

export function createZoomStage(host, { onSwipe = null, onClose = null, onTap = null } = {}) {
  host.classList.add("zoom-stage");
  host.innerHTML = `<img class="zoom-stage-img" alt="" draggable="false" />`;
  const img = host.querySelector(".zoom-stage-img");
  let natural = { w: 1, h: 1 }; // the picture's own proportions
  let fit = { w: 1, h: 1, x: 0, y: 0 }; // its size and place at scale 1
  let s = 1;
  let tx = 0;
  let ty = 0;
  let item = null;
  let fullLoading = false;
  let token = 0;

  const box = () => host.getBoundingClientRect();
  function layout() {
    const b = box();
    const k = Math.min(b.width / natural.w, b.height / natural.h);
    fit = { w: natural.w * k, h: natural.h * k, x: (b.width - natural.w * k) / 2, y: (b.height - natural.h * k) / 2 };
    img.style.width = `${fit.w}px`;
    img.style.height = `${fit.h}px`;
    img.style.left = `${fit.x}px`;
    img.style.top = `${fit.y}px`;
  }
  // Keep a zoomed picture covering the stage (centred along a side where it is smaller than the stage).
  function clamp(soft = 0) {
    const b = box();
    const w = fit.w * s;
    const h = fit.h * s;
    const limit = (t, size, view, start) => {
      if (size <= view) return (view - size) / 2 - start;
      const min = view - size - start;
      const max = -start;
      return Math.min(max + soft, Math.max(min - soft, t));
    };
    tx = limit(tx, w, b.width, fit.x);
    ty = limit(ty, h, b.height, fit.y);
  }
  function apply(animate = false) {
    img.style.transition = animate ? "transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
    host.classList.toggle("is-zoomed", s > 1.01);
    if (s > 1.6) loadFull();
  }
  // Zoom to `next` keeping the point (px, py) of the stage under the same spot of the picture.
  function zoomAt(next, px, py, animate = false) {
    const k = Math.min(MAX_SCALE, Math.max(1, next)) / s;
    tx = px - fit.x - (px - fit.x - tx) * k;
    ty = py - fit.y - (py - fit.y - ty) * k;
    s *= k;
    if (s <= 1.001) {
      s = 1;
      tx = 0;
      ty = 0;
    }
    clamp();
    apply(animate);
  }
  function reset(animate = false) {
    s = 1;
    tx = 0;
    ty = 0;
    apply(animate);
  }

  function loadFull() {
    if (!item?.full || item.full === img.dataset.src || fullLoading) return;
    fullLoading = true;
    const mine = token;
    loadImage(item.full)
      .then(() => {
        if (mine === token) {
          img.src = item.full;
          img.dataset.src = item.full;
        }
      })
      .catch(() => {})
      .finally(() => (fullLoading = false));
  }

  // Show a picture: { thumb, screen, full, alt } -- any may be missing; the best one already in hand goes up first.
  function show(next) {
    item = next;
    token += 1;
    const mine = token;
    fullLoading = false;
    reset();
    img.alt = next.alt || "";
    const first = next.thumb || next.screen || next.full;
    const setSrc = (src, el) => {
      natural = { w: el?.naturalWidth || natural.w, h: el?.naturalHeight || natural.h };
      layout();
      img.src = src;
      img.dataset.src = src;
    };
    loadImage(first)
      .then((el) => mine === token && setSrc(first, el))
      .catch(() => {});
    const better = next.screen && next.screen !== first ? next.screen : next.full && next.full !== first ? next.full : null;
    if (better)
      loadImage(better)
        .then((el) => mine === token && setSrc(better, el))
        .catch(() => {});
  }

  // --- gestures (pointer events: touch, pen and mouse alike) ---
  const pointers = new Map();
  let gesture = null; // { kind: "pan" | "pinch" | "swipe", ... }
  let lastTap = { at: 0, x: 0, y: 0 };
  let tapTimer = null;
  const local = (e) => {
    const b = box();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const pinchInfo = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  host.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    try {
      host.setPointerCapture?.(e.pointerId); // the moves keep coming here even outside the picture
    } catch {
      // a pointer the browser no longer knows: the gesture still works inside the stage
    }
    const p = local(e);
    pointers.set(e.pointerId, { ...p, startX: p.x, startY: p.y, at: Date.now() });
    if (pointers.size === 2) {
      const info = pinchInfo();
      gesture = { kind: "pinch", d0: info.d, s0: s, tx0: tx, ty0: ty, x0: info.x, y0: info.y };
    } else if (pointers.size === 1) {
      gesture = { kind: s > 1.01 ? "pan" : "swipe", x0: p.x, y0: p.y, tx0: tx, ty0: ty, axis: null };
    }
  });
  host.addEventListener("pointermove", (e) => {
    const ptr = pointers.get(e.pointerId);
    if (!ptr || !gesture) return;
    Object.assign(ptr, local(e));
    if (gesture.kind === "pinch" && pointers.size >= 2) {
      const info = pinchInfo();
      // scale around the starting midpoint, then follow the fingers as they move together
      const next = Math.min(MAX_SCALE * 1.15, Math.max(0.7, gesture.s0 * (info.d / gesture.d0)));
      const k = next / gesture.s0;
      s = next;
      tx = info.x - fit.x - (gesture.x0 - fit.x - gesture.tx0) * k;
      ty = info.y - fit.y - (gesture.y0 - fit.y - gesture.ty0) * k;
      img.style.transition = "none";
      img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
    } else if (gesture.kind === "pan") {
      tx = gesture.tx0 + (ptr.x - gesture.x0);
      ty = gesture.ty0 + (ptr.y - gesture.y0);
      clamp(40);
      apply();
    } else if (gesture.kind === "swipe") {
      const dx = ptr.x - gesture.x0;
      const dy = ptr.y - gesture.y0;
      if (!gesture.axis && Math.hypot(dx, dy) > 8) gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (gesture.axis === "x" && onSwipe) {
        img.style.transition = "none";
        img.style.transform = `translate3d(${dx}px, 0, 0)`;
      } else if (gesture.axis === "y" && dy > 0 && onClose) {
        img.style.transition = "none";
        img.style.transform = `translate3d(0, ${dy}px, 0) scale(${Math.max(0.75, 1 - dy / 1200)})`;
        host.style.setProperty("--zoom-stage-fade", String(Math.max(0.3, 1 - dy / 500)));
      }
    }
  });
  const end = (e) => {
    const ptr = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!gesture || !ptr) return;
    if (gesture.kind === "pinch") {
      if (pointers.size === 1) {
        // one finger left on the glass: it keeps moving the picture
        const [rest] = [...pointers.values()];
        if (s < 1) reset(true);
        else {
          clamp();
          apply(true);
        }
        gesture = { kind: s > 1.01 ? "pan" : "swipe", x0: rest.x, y0: rest.y, tx0: tx, ty0: ty, axis: null };
        return;
      }
      if (s < 1.01) reset(true);
      else {
        if (s > MAX_SCALE) zoomAt(MAX_SCALE, gesture.x0, gesture.y0, true);
        clamp();
        apply(true);
      }
      gesture = null;
      return;
    }
    const moved = Math.hypot(ptr.x - ptr.startX, ptr.y - ptr.startY);
    if (gesture.kind === "pan") {
      clamp();
      apply(true);
    } else if (gesture.kind === "swipe") {
      const dx = ptr.x - gesture.x0;
      const dy = ptr.y - gesture.y0;
      host.style.removeProperty("--zoom-stage-fade");
      if (gesture.axis === "x" && Math.abs(dx) > SWIPE_PX && onSwipe) {
        img.style.transition = "transform 0.18s ease-out";
        img.style.transform = `translate3d(${dx > 0 ? box().width : -box().width}px, 0, 0)`;
        setTimeout(() => onSwipe(dx > 0 ? -1 : 1), 150);
      } else if (gesture.axis === "y" && dy > 110 && onClose) {
        onClose();
      } else {
        reset(true);
      }
    }
    gesture = null;
    // a tap (no movement): a second one soon after at the same place zooms in there, or back out
    if (moved < 10 && e.type === "pointerup") {
      const now = Date.now();
      clearTimeout(tapTimer);
      if (now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(ptr.x - lastTap.x, ptr.y - lastTap.y) < 30) {
        if (s > 1.01) reset(true);
        else zoomAt(DOUBLE_TAP_SCALE, ptr.x, ptr.y, true);
        lastTap = { at: 0, x: 0, y: 0 };
      } else {
        lastTap = { at: now, x: ptr.x, y: ptr.y };
        // a single tap (no second one follows): shows / hides the bars, as in Photos
        if (onTap) tapTimer = setTimeout(onTap, DOUBLE_TAP_MS);
      }
    }
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", end);
  host.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = local(e);
      // a trackpad pinch arrives as a wheel with ctrlKey and small steps; a mouse wheel as big steps
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomAt(s * factor, p.x, p.y);
    },
    { passive: false }
  );
  const onResize = () => {
    layout();
    clamp();
    apply();
  };
  window.addEventListener("resize", onResize);

  return {
    show,
    reset,
    zoomIn: () => zoomAt(s * 1.6, box().width / 2, box().height / 2, true),
    zoomOut: () => zoomAt(s / 1.6, box().width / 2, box().height / 2, true),
    get scale() {
      return s;
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      token += 1;
    },
  };
}

// The sizes of one stored picture by its address: the server makes ?size=thumb (grids) and ?size=screen (the viewer) copies of photos
// (/api/files/:id/content, /api/checkins/photos/:id); a picture made on the phone (blob:) or anything else has only itself.
export function pictureSizes(url) {
  if (!url || !url.startsWith("/api/") || /[?&]size=/.test(url) || !/\/api\/(files\/\d+\/content|checkins\/photos\/\d+)/.test(url)) return { full: url };
  const join = url.includes("?") ? "&" : "?";
  return { thumb: `${url}${join}size=thumb`, screen: `${url}${join}size=screen`, full: url };
}
