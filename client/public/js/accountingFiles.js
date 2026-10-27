// Signed accounting documents (PDF) that Lily stored in KAD: a list used on
// the order sheet and the customer card. Tapping a row opens the document viewer (fileViewer.js): the PDF shown as a picture at once,
// Share sends the PDF, Save puts the picture in the phone's photos (owner, 2026-10-27; it used to go straight to the share sheet).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, formatDateDMY as formatDate } from "./util.js";
import { openFileViewer } from "./fileViewer.js";

function sizeLabel(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const pdfIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`;

// docs: rows from GET /orders/:id/documents or /customers/:id/documents
// (the latter also carries order_code).
export function documentRowsHtml(docs) {
  return docs
    .map(
      (d) => `
      <button type="button" class="card list-row acc-doc-row" data-doc-id="${d.id}" data-doc-name="${escapeHtml(d.filename)}" data-doc-date="${escapeHtml(String(d.created_at ?? ""))}" data-doc-order="${escapeHtml(d.order_code ?? "")}">
        <span class="list-row-icon">${pdfIcon}</span>
        <div class="list-row-body">
          <div class="list-row-top"><strong>${escapeHtml(d.filename)}</strong></div>
          <div class="muted list-row-meta">${d.order_code ? `${escapeHtml(d.order_code)} · ` : ""}${d.hc_doc_number ? `№ ${escapeHtml(d.hc_doc_number)} · ` : ""}${formatDate(d.created_at)} · ${sizeLabel(d.size_bytes)}</div>
        </div>
      </button>`
    )
    .join("");
}

export function bindDocumentRows(root) {
  const rows = [...root.querySelectorAll("[data-doc-id]")];
  const docs = rows.map((row) => ({
    external: true,
    id: row.dataset.docId,
    kind: "accounting",
    name: row.dataset.docName,
    mime: /\.pdf$/i.test(row.dataset.docName) ? "application/pdf" : "application/octet-stream",
    url: api.orderDocumentUrl(row.dataset.docId),
    previewUrl: api.orderDocumentPreviewUrl(row.dataset.docId),
    created_at: row.dataset.docDate,
    order_codes: row.dataset.docOrder ? [row.dataset.docOrder] : [],
  }));
  rows.forEach((row, i) => row.addEventListener("click", () => openFileViewer(docs, i)));
}

// The "Signed documents" block (heading + rows), or "" when there are none.
export function documentsSectionHtml(docs) {
  if (!docs.length) return "";
  return `<h3 class="list-group-heading">${t("acc_signed_docs")}</h3><div class="acc-docs">${documentRowsHtml(docs)}</div>`;
}
