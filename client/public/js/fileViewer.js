// Full-screen viewer for customer documents (photos of signed order blanks, payment slips, signed acts as PDF): look at it, turn it,
// share it, and (admin / CEO) delete it. The list it is given is the list on screen, so prev / next walk through the same documents.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { state } from "./state.js";
import { escapeHtml, formatDateTime, saveBlob, showToast } from "./util.js";
import { openFileReadySheet } from "./fileReadySheet.js";

export const fileKindLabel = (kind) => t(`file_kind_${kind}`);
export const isPdf = (file) => file.mime === "application/pdf";
const canRotate = (file) => ["admin", "ceo"].includes(state.user.role) || file.created_by === state.user.id;
const canDelete = () => ["admin", "ceo"].includes(state.user.role);

const ROTATE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>`;
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

// What the AI check found, in short lines (empty until the check is on and has run).
export function aiSummaryHtml(file) {
  if (!file.ai_status || file.ai_status === "pending") return "";
  if (file.ai_status === "ok") return `<p class="file-ai file-ai-ok">${t("file_ai_ok")}</p>`;
  const issues = file.ai_result?.issues ?? [];
  const lines = issues.length ? issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("") : "";
  return `<div class="file-ai file-ai-bad"><strong>${t(file.ai_status === "unreadable" ? "file_ai_unreadable" : "file_ai_issues")}</strong>${lines ? `<ul>${lines}</ul>` : ""}</div>`;
}

export function openFileViewer(files, startIndex = 0, { onChanged } = {}) {
  let index = startIndex;
  let changed = false;
  const list = files.map((f) => ({ ...f }));
  const overlay = document.createElement("div");
  overlay.className = "file-viewer";
  overlay.innerHTML = `
    <div class="file-viewer-top">
      <div class="file-viewer-title"></div>
      <button type="button" class="icon-btn file-viewer-close" aria-label="${t("close")}">${icons.close}</button>
    </div>
    <div class="file-viewer-stage"></div>
    ${list.length > 1 ? `<button type="button" class="photo-lightbox-nav photo-lightbox-prev" aria-label="${t("previous")}">&#8249;</button><button type="button" class="photo-lightbox-nav photo-lightbox-next" aria-label="${t("next")}">&#8250;</button>` : ""}
    <div class="file-viewer-info"></div>
    <div class="file-viewer-bar"></div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  const title = overlay.querySelector(".file-viewer-title");
  const stage = overlay.querySelector(".file-viewer-stage");
  const info = overlay.querySelector(".file-viewer-info");
  const bar = overlay.querySelector(".file-viewer-bar");

  const close = () => {
    overlay.remove();
    document.body.style.overflow = "";
    if (changed) onChanged?.();
  };
  overlay.querySelector(".file-viewer-close").addEventListener("click", close);

  async function fetchBlob(file) {
    const res = await fetch(api.fileUrl(file), { credentials: "same-origin" });
    if (!res.ok) throw new Error(t("pdf_failed"));
    return res.blob();
  }
  const fileName = (file) => `${fileKindLabel(file.kind)}-${String(file.created_at).slice(0, 10)}.${isPdf(file) ? "pdf" : "jpg"}`.replace(/\s+/g, "-");

  function show() {
    const file = list[index];
    title.textContent = `${fileKindLabel(file.kind)}${list.length > 1 ? ` · ${index + 1}/${list.length}` : ""}`;
    stage.innerHTML = isPdf(file)
      ? `<div class="file-viewer-pdf"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><button type="button" class="btn btn-primary" data-act="open-pdf">${t("file_open")}</button></div>`
      : `<img class="file-viewer-img" src="${api.fileUrl(file)}" alt="${escapeHtml(fileKindLabel(file.kind))}" />`;
    info.innerHTML = `
      <div class="file-viewer-meta">${escapeHtml(formatDateTime(file.created_at))}${file.user_name ? ` · ${escapeHtml(file.user_name)}` : ""}${file.customer_name ? ` · ${escapeHtml(file.customer_name)}` : ""}${file.order_codes?.length ? ` · ${escapeHtml(file.order_codes.join(", "))}` : ""}</div>
      ${file.note ? `<div class="file-viewer-note">${escapeHtml(file.note)}</div>` : ""}
      ${aiSummaryHtml(file)}`;
    bar.innerHTML = `
      ${!isPdf(file) && canRotate(file) ? `<button type="button" class="file-viewer-btn" data-act="rotate-left" aria-label="${t("rotate_left")}"><span style="display:inline-flex;transform:scaleX(-1)">${ROTATE_ICON}</span><span>${t("rotate_left")}</span></button><button type="button" class="file-viewer-btn" data-act="rotate-right" aria-label="${t("rotate_right")}">${ROTATE_ICON}<span>${t("rotate_right")}</span></button>` : ""}
      <button type="button" class="file-viewer-btn" data-act="share">${SHARE_ICON}<span>${t("file_share")}</span></button>
      ${canDelete() ? `<button type="button" class="file-viewer-btn file-viewer-btn-danger" data-act="delete">${icons.trash}<span>${t("delete_document")}</span></button>` : ""}`;
    bar.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => act(btn.dataset.act, btn)));
    stage.querySelector('[data-act="open-pdf"]')?.addEventListener("click", () => act("open-pdf"));
  }

  async function act(name, btn) {
    const file = list[index];
    try {
      if (name === "share" || name === "open-pdf") {
        const blob = await fetchBlob(file);
        if (name === "open-pdf") openFileReadySheet(blob, fileName(file));
        else await saveBlob(blob, fileName(file));
      } else if (name === "rotate-left" || name === "rotate-right") {
        btn.disabled = true;
        const res = await api.rotateFile(file.id, name === "rotate-right" ? 90 : 270);
        file.version = res.version;
        changed = true;
        show();
      } else if (name === "delete") {
        // No confirm() dialog: the first tap arms the button, the second one deletes.
        if (!btn.dataset.armed) {
          btn.dataset.armed = "1";
          btn.querySelector("span").textContent = t("delete_document_confirm");
          setTimeout(() => {
            if (btn.isConnected) {
              delete btn.dataset.armed;
              btn.querySelector("span").textContent = t("delete_document");
            }
          }, 4000);
          return;
        }
        await api.deleteFile(file.id);
        changed = true;
        list.splice(index, 1);
        if (!list.length) return close();
        index = Math.min(index, list.length - 1);
        show();
      }
    } catch (err) {
      if (btn) btn.disabled = false;
      showToast(err.message || t("pdf_failed"));
    }
  }

  overlay.querySelector(".photo-lightbox-prev")?.addEventListener("click", () => {
    index = (index - 1 + list.length) % list.length;
    show();
  });
  overlay.querySelector(".photo-lightbox-next")?.addEventListener("click", () => {
    index = (index + 1) % list.length;
    show();
  });
  document.addEventListener(
    "keydown",
    function onKey(e) {
      if (!overlay.isConnected) return document.removeEventListener("keydown", onKey);
      if (e.key === "Escape") close();
    },
    { passive: true }
  );
  show();
  return { close };
}
