// Customer card > files and photos (moved out of customerDetail.js with the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { dockSheet } from "../../dockSheet.js";
import { activateDialog, escapeHtml, formatDateDMY } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { state } from "../../state.js";
import { openPhotoLightbox } from "../../visitDetail.js";
import { loadWithCache } from "../../listCache.js";
import { photosSource } from "../../customerCardData.js";
import { fileKindLabel, openFileViewer } from "../../fileViewer.js";
import { openAddFileSheet } from "../../addFileSheet.js";

// The Files sheet shows fewer photos first so the Documents section below them stays one short scroll away.
export const FIRST_PHOTOS = 12;

// Everyone who works with customers can add a document; warehouse staff cannot (server: canAddCustomerFiles).
export const canAddFiles = () => state.user.role !== "warehouse_manager";

// "Files" of one customer (owner, 2026-10-26): Photos (everything captured at check-ins, newest first) and Documents (signed accounting
// documents today; payment slips and order blanks join them). Photos show small copies in a grid and open full size in the lightbox.
export async function openCustomerFiles(customer) {
  const customerId = customer.id;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet customer-files-sheet">
      <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("customer_files")}</h2>
      <p class="muted">${escapeHtml(customer.name)}</p>
      <h3 class="list-group-heading">${t("files_photos")}<span class="muted" id="files-photos-count"></span></h3>
      <div id="customer-photo-gallery-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <h3 class="list-group-heading">${t("files_documents")}<span class="muted" id="files-docs-count"></span></h3>
      <div id="customer-documents-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  document.body.appendChild(overlay);
  dockSheet(overlay, `customer-files:${customerId}`);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());

  const body = overlay.querySelector("#customer-photo-gallery-body");
  let shown = FIRST_PHOTOS;
  let lastJson = "";
  const renderPhotos = (photos) => {
    overlay.querySelector("#files-photos-count").textContent = photos.length ? ` · ${photos.length}` : "";
    if (!photos.length) {
      body.innerHTML = `<p class="empty-state">${t("no_photos_yet")}</p>`;
      return;
    }
    const urls = photos.map((p) => api.checkinPhotoByIdUrl(p.id));
    const visible = photos.slice(0, shown);
    const hidden = photos.length - visible.length;
    body.innerHTML = `
      <div class="checkin-photo-grid">
        ${visible
          .map(
            (p, i) => `
        <div class="checkin-photo-wrap">
          <img class="checkin-photo" data-photo-index="${i}" src="${api.checkinPhotoThumbUrl(p.id)}" alt="${t("photo_optional")}" loading="lazy" decoding="async" />
        </div>`
          )
          .join("")}
      </div>
      ${hidden > 0 ? `<button type="button" class="btn btn-block" id="more-photos-btn">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
    `;
    body.querySelectorAll(".checkin-photo").forEach((img) => {
      img.addEventListener("click", () => openPhotoLightbox(urls, Number(img.dataset.photoIndex)));
    });
    body.querySelector("#more-photos-btn")?.addEventListener("click", () => {
      shown = photos.length;
      renderPhotos(photos);
    });
  };
  const photoSource = photosSource(customerId);
  loadWithCache(photoSource.key, photoSource.fetch, (photos) => {
    if (!overlay.isConnected) return;
    const json = JSON.stringify(photos);
    if (json === lastJson) return;
    lastJson = json;
    renderPhotos(photos);
  }).catch((err) => {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  });

  // Documents: the signed order blanks photographed at deliveries, then the signed accounting documents (from Lily).
  const docsBody = overlay.querySelector("#customer-documents-body");
  const loadDocuments = async () => {
    try {
      const [docs, files] = await Promise.all([api.listCustomerDocuments(customerId), api.customerFiles(customerId).catch(() => [])]);
      if (!overlay.isConnected) return;
      overlay.querySelector("#files-docs-count").textContent = docs.length + files.length ? ` · ${docs.length + files.length}` : "";
      const acc = docs.length ? await import("../../accountingFiles.js") : null;
      docsBody.innerHTML = `
        ${
          files.length
            ? `<div class="files-blank-grid">
                 ${files
                   .map(
                     (f, i) => `
                   <button type="button" class="files-blank" data-file-index="${i}">
                     ${f.mime === "application/pdf" ? `<span class="files-blank-pdf">PDF</span>` : `<img src="${api.fileUrl(f, { thumb: true })}" alt="${escapeHtml(fileKindLabel(f.kind))}" loading="lazy" decoding="async" />`}
                     <span class="files-blank-cap"><strong>${escapeHtml(fileKindLabel(f.kind))}</strong><br />${escapeHtml(formatDateDMY(f.created_at))}${f.order_codes?.length ? ` · ${escapeHtml(f.order_codes.join(", "))}` : ""}</span>
                   </button>`
                   )
                   .join("")}
               </div>`
            : ""
        }
        ${docs.length ? `<div class="acc-docs">${acc.documentRowsHtml(docs)}</div>` : ""}
        ${!files.length && !docs.length ? `<p class="empty-state">${t("files_documents_empty")}</p>` : ""}
        ${canAddFiles() ? `<button type="button" class="btn btn-block btn-has-icon" id="add-document-btn">${icons.plus}${t("add_document")}</button>` : ""}`;
      docsBody.querySelectorAll(".files-blank").forEach((btn) => btn.addEventListener("click", () => openFileViewer(files, Number(btn.dataset.fileIndex), { onChanged: loadDocuments })));
      docsBody.querySelector("#add-document-btn")?.addEventListener("click", () => openAddFileSheet({ customer, onAdded: loadDocuments }));
      if (acc) acc.bindDocumentRows(docsBody);
    } catch (err) {
      docsBody.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  };
  await loadDocuments();
}
