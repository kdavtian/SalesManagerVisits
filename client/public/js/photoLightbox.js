import { t } from "./i18n.js";
import { createZoomStage, pictureSizes, preloadPicture } from "./zoomStage.js";

// Full-screen photo viewer, like the iPhone Photos app (owner, 2026-10-30: "I want an iPhone native photo viewer: the current one has
// no pinch to zoom, not fast"): pinch / double-tap zoom, swipe left / right through the photos, swipe down or the X to close, a tap
// shows / hides the bars. The small copy the list already showed appears at once, the screen copy right after (zoomStage.js).
// `urls`: the photos' addresses (a stored photo also gets its smaller copies), or { thumb, screen, full } per photo.
export function openPhotoLightbox(urls, startIndex = 0) {
  const items = urls.map((u) => (typeof u === "string" ? pictureSizes(u) : u));
  let index = Math.max(0, Math.min(items.length - 1, startIndex));
  const overlay = document.createElement("div");
  overlay.className = "photo-lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="photo-lightbox-stage"></div>
    <div class="photo-lightbox-top">
      <span class="photo-lightbox-counter" ${items.length > 1 ? "" : "hidden"}></span>
      <button type="button" class="photo-lightbox-close" aria-label="${t("close")}">&times;</button>
    </div>
    ${
      items.length > 1
        ? `<button type="button" class="photo-lightbox-nav photo-lightbox-prev" aria-label="${t("previous")}">&#8249;</button>
           <button type="button" class="photo-lightbox-nav photo-lightbox-next" aria-label="${t("next")}">&#8250;</button>`
        : ""
    }`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const counterEl = overlay.querySelector(".photo-lightbox-counter");

  const stage = createZoomStage(overlay.querySelector(".photo-lightbox-stage"), {
    onSwipe: items.length > 1 ? (dir) => show(index + dir) : null,
    onClose: () => close(),
    onTap: () => overlay.classList.toggle("is-bare"),
  });

  function show(i) {
    index = (i + items.length) % items.length;
    stage.show({ ...items[index], alt: t("photo_optional") });
    counterEl.textContent = `${index + 1} / ${items.length}`;
    // the neighbours are on their way before the swipe asks for them
    if (items.length > 1) {
      preloadPicture(items[(index + 1) % items.length].screen || items[(index + 1) % items.length].full);
      preloadPicture(items[(index - 1 + items.length) % items.length].screen || items[(index - 1 + items.length) % items.length].full);
    }
  }

  function close() {
    stage.destroy();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && items.length > 1) show(index - 1);
    else if (e.key === "ArrowRight" && items.length > 1) show(index + 1);
    else if (e.key === "+" || e.key === "=") stage.zoomIn();
    else if (e.key === "-") stage.zoomOut();
  }

  overlay.querySelector(".photo-lightbox-close").addEventListener("click", close);
  overlay.querySelector(".photo-lightbox-prev")?.addEventListener("click", () => show(index - 1));
  overlay.querySelector(".photo-lightbox-next")?.addEventListener("click", () => show(index + 1));
  document.addEventListener("keydown", onKey);
  show(index);
}
