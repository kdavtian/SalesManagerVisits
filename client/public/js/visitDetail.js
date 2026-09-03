// The full single-visit detail sheet (badges, brand tags, note, photos) --
// shared between the Customers > visit history list and the Activity tab,
// both of which tap a compact row to show the same full picture of one
// check-in. Kept as its own module (not exported from customerDetail.js)
// so neither view has to import the other's file to reuse it.
import { api } from "./api.js";
import { activateDialog, escapeHtml, formatDateTime, formatDistance } from "./util.js";
import { t } from "./i18n.js";
import { isAdmin } from "./state.js";

const BRAND_GROUP_LABEL_KEY = {
  castrol: "brand_group_castrol",
  lotos: "brand_group_lotos",
  royal: "brand_group_royal",
  competitors: "brand_group_competitors",
};

// New rows write `outcomes`/`brand_status`; rows from before the
// multi-outcome change only have the old singular `outcome`/`brands_found`.
export function checkinOutcomeLabels(ch) {
  const outcomes = ch.outcomes?.length ? ch.outcomes : ch.outcome ? [ch.outcome] : [];
  return outcomes.map((o) => t(`outcome_${o}`));
}

export function checkinBrandTags(ch) {
  if (ch.brand_status && Object.keys(ch.brand_status).length) {
    const tags = [];
    for (const [brand, values] of Object.entries(ch.brand_status)) {
      for (const v of values) {
        if (brand === "competitors") {
          tags.push(t(`competitor_${v}`));
        } else {
          tags.push(`${t(BRAND_GROUP_LABEL_KEY[brand])}: ${t(`brand_status_${v}`)}`);
        }
      }
    }
    return tags;
  }
  return (ch.brands_found ?? []).map((b) => t(`brand_${b}`));
}

// Full-screen photo viewer -- tap a photo to open it, swipe or use the
// arrow buttons/keys to move between the rest of that visit's photos,
// tap outside/the close button/Escape to dismiss.
function openPhotoLightbox(urls, startIndex) {
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
  }

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
      touchStartX = e.touches[0].clientX;
    },
    { passive: true }
  );
  overlay.addEventListener("touchend", (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
    touchStartX = null;
  });
}

// Full detail for one visit -- badges, brand tags, note, photos -- opened
// from a tap on its compact row. All the data is already in the checkin
// object the caller has (from either the customer's visit history or the
// Activity feed), so this needs no separate request.
export function openVisitDetailSheet(ch, onPhotoDeleted) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet visit-detail-sheet">
      <div class="visit-detail-header">
        <button type="button" class="icon-btn" id="visit-detail-back" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div>
          <h2>${escapeHtml(ch.user_name)}</h2>
          <p class="muted">${formatDateTime(ch.timestamp)}</p>
        </div>
      </div>
      <div class="checkin-card-badges">
        <span class="badge ${ch.within_range ? "badge-success" : "badge-danger"}">
          ${ch.within_range ? t("location_verified") : `${t("location_mismatch_away")} (${formatDistance(ch.distance_meters)} ${t("away")})`}
        </span>
        ${checkinOutcomeLabels(ch)
          .map((label) => `<span class="badge badge-neutral">${escapeHtml(label)}</span>`)
          .join("")}
      </div>
      ${
        checkinBrandTags(ch).length
          ? `<div class="brand-tags">${checkinBrandTags(ch).map((tag) => `<span class="brand-tag">${escapeHtml(tag)}</span>`).join("")}</div>`
          : ""
      }
      ${ch.note ? `<p class="checkin-note">${escapeHtml(ch.note)}</p>` : ""}
      ${
        ch.photos?.length
          ? `<div class="checkin-photo-grid">
              ${ch.photos
                .map(
                  (photo, i) => `
                <div class="checkin-photo-wrap">
                  <img class="checkin-photo" data-photo-index="${i}" src="${api.checkinPhotoByIdUrl(photo.id)}" alt="${t("photo_optional")}" loading="lazy" />
                  ${isAdmin() ? `<button class="photo-delete-btn" data-photo-id="${photo.id}" aria-label="${t("delete_photo")}">&times;</button>` : ""}
                </div>
              `
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#visit-detail-back").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  overlay.querySelectorAll(".checkin-photo").forEach((img) => {
    img.addEventListener("click", () => {
      openPhotoLightbox(
        ch.photos.map((p) => api.checkinPhotoByIdUrl(p.id)),
        Number(img.dataset.photoIndex)
      );
    });
  });

  overlay.querySelectorAll(".photo-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(t("confirm_delete_photo"))) return;
      await api.deleteCheckinPhotoById(btn.dataset.photoId);
      close();
      onPhotoDeleted();
    });
  });
}
