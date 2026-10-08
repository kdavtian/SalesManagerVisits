// Signed accounting documents (PDF) that Lily stored in KAD: a list used on
// the order sheet and the customer card. Tapping a row fetches the file and
// hands it to saveBlob (native share / download -- never navigates the app
// to the PDF, which would leave no way back in an installed PWA).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, formatDateDMY as formatDate, saveBlob } from "./util.js";

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
      <button type="button" class="card list-row acc-doc-row" data-doc-id="${d.id}" data-doc-name="${escapeHtml(d.filename)}">
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
  root.querySelectorAll("[data-doc-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      row.disabled = true;
      try {
        const blob = await api.downloadOrderDocument(row.dataset.docId);
        await saveBlob(blob, row.dataset.docName);
      } catch (err) {
        alert(err.message || t("pdf_failed"));
      } finally {
        row.disabled = false;
      }
    });
  });
}

// The "Signed documents" block (heading + rows), or "" when there are none.
export function documentsSectionHtml(docs) {
  if (!docs.length) return "";
  return `<h3 class="list-group-heading">${t("acc_signed_docs")}</h3><div class="acc-docs">${documentRowsHtml(docs)}</div>`;
}
