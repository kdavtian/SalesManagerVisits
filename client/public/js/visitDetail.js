// The full single-visit detail sheet (badges, brand tags, note, photos) --
// shared between the Customers > visit history list and the Activity tab,
// both of which tap a compact row to show the same full picture of one
// check-in. Kept as its own module (not exported from customerDetail.js)
// so neither view has to import the other's file to reuse it.
import { api } from "./api.js";
import { dockSheet } from "./dockSheet.js";
import { activateDialog, escapeHtml, formatDateTime, formatDistance, formatAmd, categoryIcon, customerNameLinkHtml, activateCustomerNameLinks, leaveSheetTo } from "./util.js";
import { t } from "./i18n.js";
import { isAdmin } from "./state.js";
import { icons } from "./icons.js";
import { openOrderDetailSheet } from "./orderDetailSheet.js";
import { openPhotoLightbox } from "./photoLightbox.js";
import { openFileViewer, fileKindLabel } from "./fileViewer.js";

// Kept exported from here: customerDetail.js imports it from this module.
export { openPhotoLightbox };

const BRAND_GROUP_LABEL_KEY = {
  castrol: "brand_group_castrol",
  lotos: "brand_group_lotos",
  royal: "brand_group_royal",
  competitors: "brand_group_competitors",
};

// Mirrors views/checkin.js's OUTCOME_META icon choices, so an outcome reads
// the same visual way here as it did while the rep was picking it.
const OUTCOME_ICON = {
  order_placed: icons.cart,
  payment_collected: icons.payment,
  follow_up_required: icons.clock,
  assortment_check: icons.clipboardCheck,
  customer_unavailable: icons.truck,
  other: icons.more,
};

// New rows write `outcomes`/`brand_status`; rows from before the
// multi-outcome change only have the old singular `outcome`/`brands_found`.
export function checkinOutcomeValues(ch) {
  return ch.outcomes?.length ? ch.outcomes : ch.outcome ? [ch.outcome] : [];
}

export function checkinOutcomeLabels(ch) {
  return checkinOutcomeValues(ch).map((o) => t(`outcome_${o}`));
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

// Full detail for one visit -- badges, brand tags, note, photos -- opened
// from a tap on its compact row. All the data is already in the checkin
// object the caller has (from either the customer's visit history or the
// Activity feed), so this needs no separate request.
export function openVisitDetailSheet(ch, onPhotoDeleted, navigate) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  const outcomeValues = checkinOutcomeValues(ch);
  const outcomeLabels = checkinOutcomeLabels(ch);
  const brandTags = checkinBrandTags(ch);
  const hasCustomer = Boolean(ch.customer_name);
  // Tapping the location row opens the map: the customer's pin next to where the last check-ins really were.
  const canShowSpots = Boolean(navigate && ch.customer_id);
  // The visit's photos, and the documents added at this visit (the signed order blank photographed at a delivery, the signed act).
  const visitPhotos = ch.photos ?? [];
  const visitFiles = ch.files ?? [];
  const photoSectionHtml = (titleKey, list) =>
    list.length
      ? `<h3 class="visit-detail-section-title">${t(titleKey)}</h3>
         <div class="checkin-photo-grid">
          ${list
            .map(
              (photo, i) => `
            <div class="checkin-photo-wrap">
              <img class="checkin-photo" data-photo-index="${i}" src="${api.checkinPhotoThumbUrl(photo.id)}" alt="${t(titleKey)}" loading="lazy" decoding="async" />
              ${isAdmin() ? `<button class="photo-delete-btn" data-photo-id="${photo.id}" aria-label="${t("delete_photo")}">&times;</button>` : ""}
            </div>
          `
            )
            .join("")}
        </div>`
      : "";
  const filesSectionHtml = () =>
    visitFiles.length
      ? `<h3 class="visit-detail-section-title">${t("files_documents")}</h3>
         <div class="files-blank-grid">
          ${visitFiles
            .map(
              (f, i) => `<button type="button" class="files-blank" data-visit-file="${i}">${f.mime === "application/pdf" ? `<span class="files-blank-pdf">PDF</span>` : `<img src="${api.fileUrl(f, { thumb: true })}" alt="" loading="lazy" decoding="async" />`}<span class="files-blank-cap">${escapeHtml(fileKindLabel(f.kind))}</span></button>`
            )
            .join("")}
         </div>`
      : "";

  overlay.innerHTML = `
    <div class="sheet visit-detail-sheet">
      <div class="visit-detail-header">
        <button type="button" class="icon-btn" id="visit-detail-back" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        ${hasCustomer ? `<span class="visit-detail-avatar">${categoryIcon(ch.customer_category)}</span>` : ""}
        <div>
          <h2>${hasCustomer ? customerNameLinkHtml(ch.customer_name, ch.customer_id) : escapeHtml(ch.user_name)}</h2>
          <p class="muted">${hasCustomer ? `${escapeHtml(ch.user_name)} · ` : ""}${formatDateTime(ch.timestamp)}</p>
        </div>
      </div>

      <div class="visit-detail-info-card">
        <${canShowSpots ? 'button type="button" data-checkin-spots' : "div"} class="visit-detail-info-row${canShowSpots ? " visit-detail-info-row-btn" : ""}">
          <span class="visit-detail-info-icon">${ch.within_range ? icons.checkCircle : icons.mapWarning}</span>
          <span class="${ch.within_range ? "" : "visit-detail-danger-text"}">
            ${ch.within_range ? t("location_verified") : `${t("location_mismatch_away")} (${formatDistance(ch.distance_meters)} ${t("away")})`}
          </span>
          ${canShowSpots ? '<span class="chevron" aria-hidden="true">&#8250;</span>' : ""}
        </${canShowSpots ? "button" : "div"}>
        ${
          ch.amount_collected_amd != null
            ? `<div class="visit-detail-info-row">
                <span class="visit-detail-info-icon">${icons.payment}</span>
                <span><span class="text-amount">${formatAmd(Number(ch.amount_collected_amd))}</span> ${t("outcome_payment_collected")}</span>
              </div>`
            : ""
        }
      </div>

      ${
        outcomeValues.length
          ? `<h3 class="visit-detail-section-title">${t("visit_outcome_label")}</h3>
             <div class="visit-detail-outcome-list">
               ${outcomeValues
                 .flatMap((o, i) => {
                   // "Order placed" opens the order this visit created (checkins.js's order_id); "Products delivered" opens the order(s)
                   // delivered at this visit (delivered_order_ids, owner 2026-10-27). Other outcomes have nothing to open.
                   const ids = o === "order_placed" && ch.order_id ? [ch.order_id] : o === "customer_unavailable" && ch.delivered_order_ids?.length ? ch.delivered_order_ids : [null];
                   return ids.map((orderId, n) => {
                     const tag = orderId ? "button" : "div";
                     const label = ids.length > 1 ? `${outcomeLabels[i]} · ${n + 1}/${ids.length}` : outcomeLabels[i];
                     return `
                 <${tag} ${orderId ? `type="button" data-order-id="${orderId}"` : ""} class="visit-detail-outcome-row${orderId ? " visit-detail-outcome-row-link" : ""}">
                   <span class="visit-detail-outcome-icon">${OUTCOME_ICON[o] || icons.more}</span>
                   <span>${escapeHtml(label)}</span>
                   ${orderId ? `<span class="chevron">&#8250;</span>` : ""}
                 </${tag}>`;
                   });
                 })
                 .join("")}
             </div>`
          : ""
      }

      ${
        brandTags.length
          ? `<h3 class="visit-detail-section-title">${t("brands_found_label")}</h3>
             <div class="brand-tags">${brandTags.map((tag) => `<span class="brand-tag">${escapeHtml(tag)}</span>`).join("")}</div>`
          : ""
      }

      ${
        ch.note
          ? `<h3 class="visit-detail-section-title">${t("note_optional")}</h3>
             <p class="checkin-note"><span class="visit-detail-note-icon">${icons.note}</span>${escapeHtml(ch.note)}</p>`
          : ""
      }

      ${photoSectionHtml("photo_optional", visitPhotos)}
      ${filesSectionHtml()}
    </div>
  `;
  document.body.appendChild(overlay);
  dockSheet(overlay, `visit:${ch.id}`);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#visit-detail-back").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  // Close this sheet before navigating, not after -- otherwise it's still
  // sitting open (as dead DOM behind the new route) once the customer card
  // renders underneath it.
  if (navigate) {
    activateCustomerNameLinks(overlay, (hash) => leaveSheetTo(overlay, navigate, hash));
  }

  overlay.querySelector("[data-checkin-spots]")?.addEventListener("click", () => {
    leaveSheetTo(overlay, navigate, `#/customers/${ch.customer_id}/spots?checkin=${ch.id}`);
  });

  overlay.querySelectorAll("[data-order-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openOrderDetailSheet(Number(btn.dataset.orderId), { navigate });
    });
  });

  overlay.querySelectorAll(".checkin-photo").forEach((img) => {
    img.addEventListener("click", () => {
      openPhotoLightbox(
        visitPhotos.map((p) => api.checkinPhotoByIdUrl(p.id)),
        Number(img.dataset.photoIndex)
      );
    });
  });
  overlay.querySelectorAll("[data-visit-file]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      // The visit row only carries id / kind / version; the viewer needs who and when too.
      let list = visitFiles;
      try {
        const all = await api.customerFiles(ch.customer_id);
        const byId = new Map(all.map((f) => [f.id, f]));
        list = visitFiles.map((f) => byId.get(f.id) ?? f);
      } catch {
        /* the bare rows still open */
      }
      openFileViewer(list, Number(btn.dataset.visitFile), { onChanged: onPhotoDeleted });
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
