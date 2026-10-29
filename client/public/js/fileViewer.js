// Full-screen viewer for customer documents (photos of signed order blanks, payment slips, signed acts as PDF) and the signed accounting
// documents: look at it, turn it, share it, save it as a picture, and (admin / CEO) delete it. The list it is given is the list on screen, so
// prev / next walk through the same documents.
// A PDF is shown as ONE picture the server makes from it (owner, 2026-10-27: PDFs opened slowly, needed extra steps, sometimes not at all):
// a progress bar while it loads, then the page(s) right here; tap = zoom. Share sends the PDF, Save puts the picture in the phone's photos.
// Both files are fetched as soon as the document is shown, so the tap on Share / Save hands them over at once (iOS refuses a share that
// waits on the network and used to need an extra "File ready" step).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { state } from "./state.js";
import { canManageSignedDocuments, seesAllCustomerFiles } from "./shared/roles.js";
import { escapeHtml, formatDateTime, saveBlob, showToast } from "./util.js";
import { createZoomStage, preloadPicture } from "./zoomStage.js";

export const fileKindLabel = (kind) => t(`file_kind_${kind}`);
export const isPdf = (file) => file.mime === "application/pdf";
// file.external: a document that is not a customer file (a signed accounting document): its own urls, no turning, no deleting here.
const canRotate = (file) => !file.external && (canManageSignedDocuments(state.user.role) || file.created_by === state.user.id);
const canDelete = (file) => !file.external && canManageSignedDocuments(state.user.role);
const SAVE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>`;

// A GET with a progress callback (0..1, or null when the size is unknown).
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const err = new Error(t("pdf_failed"));
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !total) {
    onProgress?.(null);
    return res.blob();
  }
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  return new Blob(parts, { type: res.headers.get("Content-Type") || "" });
}

const ROTATE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg>`;
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

// What the AI check found, in short lines (empty until the check is on and has run). Each issue is a code the app words itself.
const issueText = (issue) => t(`ai_issue_${issue.code}`).replace("{found}", escapeHtml(String(issue.found ?? ""))).replace("{expected}", escapeHtml(String(issue.expected ?? "")));
export function aiSummaryHtml(file) {
  if (!file.ai_status || file.ai_status === "pending") return "";
  if (file.ai_status === "ok") return `<p class="file-ai file-ai-ok">${t("file_ai_ok")}</p>`;
  const issues = file.ai_result?.issues ?? [];
  const lines = issues.length ? issues.map((i) => `<li>${issueText(i)}</li>`).join("") : "";
  return `<div class="file-ai file-ai-bad"><strong>${t(file.ai_status === "unreadable" ? "file_ai_unreadable" : "file_ai_issues")}</strong>${lines ? `<ul>${lines}</ul>` : ""}</div>`;
}

// Whether the AI check is switched on (App configuration, OFF by default): read once, so the "Check again" button only exists when it can work.
let aiCheckOn = null;
const aiCheckSwitch = () => (aiCheckOn ??= api.getSettings().then((s) => Boolean(s.ai_blank_check_enabled)).catch(() => false));

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
    <div class="file-viewer-stage"><div class="file-viewer-zoom"></div><div class="file-viewer-msg" hidden></div></div>
    ${list.length > 1 ? `<button type="button" class="photo-lightbox-nav photo-lightbox-prev" aria-label="${t("previous")}">&#8249;</button><button type="button" class="photo-lightbox-nav photo-lightbox-next" aria-label="${t("next")}">&#8250;</button>` : ""}
    <div class="file-viewer-info"></div>
    <div class="file-viewer-bar"></div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  let aiOn = false;
  aiCheckSwitch().then((on) => {
    if (on && overlay.isConnected) {
      aiOn = true;
      show();
    }
  });
  const title = overlay.querySelector(".file-viewer-title");
  // The picture itself: pinch / double-tap zoom, swipe to the next document, swipe down to close, as in Photos (zoomStage.js).
  // `stage` holds what is shown instead of it (the PDF's progress bar, the "Open" button when no picture can be made).
  const zoomHost = overlay.querySelector(".file-viewer-zoom");
  const stage = overlay.querySelector(".file-viewer-msg");
  const zoom = createZoomStage(zoomHost, {
    onSwipe: list.length > 1 ? (dir) => go(dir) : null,
    onClose: () => close(),
    onTap: () => overlay.classList.toggle("is-bare"),
  });
  const zoomImg = zoomHost.querySelector("img");
  function showPictureMode(on) {
    zoomHost.hidden = !on;
    stage.hidden = on;
    if (on) stage.innerHTML = "";
  }
  function go(dir) {
    index = (index + dir + list.length) % list.length;
    show();
  }
  const info = overlay.querySelector(".file-viewer-info");
  const bar = overlay.querySelector(".file-viewer-bar");

  const close = () => {
    zoom.destroy();
    overlay.remove();
    document.body.style.overflow = "";
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    if (changed) onChanged?.();
  };
  overlay.querySelector(".file-viewer-close").addEventListener("click", close);

  const srcUrl = (file) => file.url ?? api.fileUrl(file);
  const previewUrl = (file) => file.previewUrl ?? api.filePreviewUrl(file);
  const baseName = (file) => (file.name ? file.name.replace(/\.pdf$/i, "") : `${fileKindLabel(file.kind)}-${String(file.created_at).slice(0, 10)}`).replace(/\s+/g, "-");
  const fileName = (file) => `${baseName(file)}.${isPdf(file) ? "pdf" : "jpg"}`;

  // Per document: the file itself and its picture, fetched once and kept while the viewer is open (blob: settled value, promise: in flight).
  const cache = new Map();
  const entry = (file) => {
    const key = srcUrl(file);
    if (!cache.has(key)) cache.set(key, {});
    return cache.get(key);
  };
  function loadFile(file) {
    const e = entry(file);
    e.filePromise ??= fetchWithProgress(srcUrl(file)).then(
      (b) => (e.fileBlob = b),
      (err) => {
        e.filePromise = null; // a failed download is tried again on the next tap
        throw err;
      }
    );
    return e.filePromise;
  }
  function loadPicture(file, onProgress) {
    const e = entry(file);
    if (!isPdf(file)) {
      e.picturePromise ??= loadFile(file).then(
        (b) => (e.pictureBlob = b),
        (err) => {
          e.picturePromise = null;
          throw err;
        }
      );
    } else {
      e.picturePromise ??= fetchWithProgress(previewUrl(file), onProgress).then(
        (b) => (e.pictureBlob = b),
        (err) => {
          e.picturePromise = null;
          throw err;
        }
      );
    }
    return e.picturePromise;
  }
  const objectUrls = [];
  const blobUrl = (blob) => {
    const u = URL.createObjectURL(blob);
    objectUrls.push(u);
    return u;
  };

  function show() {
    const file = list[index];
    title.textContent = `${file.name && file.external ? file.name : fileKindLabel(file.kind)}${list.length > 1 ? ` · ${index + 1}/${list.length}` : ""}`;
    if (isPdf(file)) showPdf(file);
    else {
      // a stored photo: its small copy at once, the screen copy right after, the original only when zoomed in
      showPictureMode(true);
      zoomImg.className = "zoom-stage-img file-viewer-img";
      zoom.show({ ...(file.external ? { full: srcUrl(file) } : { thumb: api.fileUrl(file, { thumb: true }), screen: `${srcUrl(file)}&size=screen`, full: srcUrl(file) }), alt: fileKindLabel(file.kind) });
    }
    // the neighbours are on their way before a swipe asks for them
    if (list.length > 1) for (const n of [list[(index + 1) % list.length], list[(index - 1 + list.length) % list.length]]) if (!isPdf(n) && !n.external) preloadPicture(`${srcUrl(n)}&size=screen`);
    info.innerHTML = `
      <div class="file-viewer-meta">${escapeHtml(formatDateTime(file.created_at))}${file.user_name ? ` · ${escapeHtml(file.user_name)}` : ""}${file.customer_name ? ` · ${escapeHtml(file.customer_name)}` : ""}${file.order_codes?.length ? ` · ${escapeHtml(file.order_codes.join(", "))}` : ""}</div>
      ${file.note ? `<div class="file-viewer-note">${escapeHtml(file.note)}</div>` : ""}
      ${aiSummaryHtml(file)}`;
    // Share, then Save (as a picture), then Delete (owner, 2026-10-27).
    bar.innerHTML = `
      ${!isPdf(file) && canRotate(file) ? `<button type="button" class="file-viewer-btn" data-act="rotate-left" aria-label="${t("rotate_left")}"><span style="display:inline-flex;transform:scaleX(-1)">${ROTATE_ICON}</span><span>${t("rotate_left")}</span></button><button type="button" class="file-viewer-btn" data-act="rotate-right" aria-label="${t("rotate_right")}">${ROTATE_ICON}<span>${t("rotate_right")}</span></button>` : ""}
      <button type="button" class="file-viewer-btn" data-act="share">${SHARE_ICON}<span>${t("file_share_short")}</span></button>
      <button type="button" class="file-viewer-btn" data-act="save-image">${SAVE_ICON}<span>${t("file_save_image")}</span></button>
      ${aiOn && file.kind === "order_blank" && !isPdf(file) && seesAllCustomerFiles(state.user.role) ? `<button type="button" class="file-viewer-btn" data-act="ai-check">${icons.sparkles}<span>${t("file_ai_recheck")}</span></button>` : ""}
      ${canDelete(file) ? `<button type="button" class="file-viewer-btn file-viewer-btn-danger" data-act="delete">${icons.trash}<span>${t("delete_document")}</span></button>` : ""}`;
    bar.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => act(btn.dataset.act, btn)));
    // Have both files ready before a tap asks for them.
    loadFile(file).catch(() => {});
    if (!isPdf(file)) loadPicture(file).catch(() => {});
  }

  // The PDF as a picture: a progress bar, then the page(s). If the server cannot make the picture, the PDF opens in the phone's own reader.
  function showPdf(file) {
    const e = entry(file);
    const showPicture = (blob) => {
      showPictureMode(true);
      zoomImg.className = "zoom-stage-img file-viewer-img file-viewer-page";
      zoom.show({ full: blobUrl(blob), alt: fileKindLabel(file.kind) });
    };
    if (e.pictureBlob) return showPicture(e.pictureBlob);
    showPictureMode(false);
    stage.innerHTML = `<div class="file-viewer-loading" role="status" aria-live="polite"><div class="file-viewer-progress"><span></span></div><span class="muted">${t("loading")}</span></div>`;
    const bar = stage.querySelector(".file-viewer-progress span");
    const progress = stage.querySelector(".file-viewer-progress");
    loadPicture(file, (p) => {
      if (p == null) progress.classList.add("file-viewer-progress-busy");
      else bar.style.width = `${Math.round(p * 100)}%`;
    })
      .then((blob) => {
        if (list[index] !== file || !overlay.isConnected) return;
        showPicture(blob);
      })
      .catch(() => {
        if (list[index] !== file || !overlay.isConnected) return;
        entry(file).picturePromise = null;
        stage.innerHTML = `<div class="file-viewer-pdf"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><button type="button" class="btn btn-primary" data-act="open-pdf">${t("file_open")}</button></div>`;
        stage.querySelector('[data-act="open-pdf"]').addEventListener("click", (ev) => act("open-pdf", ev.currentTarget));
      });
  }

  // Runs `fn(blob)` straight away when the blob is already here (the share sheet then opens in the same tap); otherwise shows the button busy
  // until it arrives.
  async function withBlob(btn, settled, promise, fn) {
    if (settled) return fn(settled);
    btn?.classList.add("file-viewer-btn-busy");
    if (btn) btn.disabled = true;
    try {
      return fn(await promise);
    } finally {
      btn?.classList.remove("file-viewer-btn-busy");
      if (btn) btn.disabled = false;
    }
  }

  async function act(name, btn) {
    const file = list[index];
    try {
      if (name === "share") {
        const e = entry(file);
        await withBlob(btn, e.fileBlob, loadFile(file), (blob) => saveBlob(blob, fileName(file)));
      } else if (name === "save-image") {
        const e = entry(file);
        await withBlob(btn, e.pictureBlob, loadPicture(file), (blob) => saveBlob(blob, `${baseName(file)}.jpg`));
      } else if (name === "open-pdf") {
        const blob = await withBlob(btn, entry(file).fileBlob, loadFile(file), (b) => b);
        const url = blobUrl(blob);
        if (!window.open(url, "_blank")) await saveBlob(blob, fileName(file));
      } else if (name === "rotate-left" || name === "rotate-right") {
        btn.disabled = true;
        const res = await api.rotateFile(file.id, name === "rotate-right" ? 90 : 270);
        file.version = res.version;
        changed = true;
        show();
      } else if (name === "ai-check") {
        btn.disabled = true;
        const res = await api.recheckFile(file.id);
        file.ai_status = res.ai_status;
        file.ai_result = res.ai_result;
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
      if (err?.status === 501 && name === "save-image") showToast(t("file_save_image_unavailable"));
      else showToast(err.message || t("pdf_failed"));
    }
  }

  overlay.querySelector(".photo-lightbox-prev")?.addEventListener("click", () => go(-1));
  overlay.querySelector(".photo-lightbox-next")?.addEventListener("click", () => go(1));
  document.addEventListener(
    "keydown",
    function onKey(e) {
      if (!overlay.isConnected) return document.removeEventListener("keydown", onKey);
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && list.length > 1) go(-1);
      else if (e.key === "ArrowRight" && list.length > 1) go(1);
    },
    { passive: true }
  );
  show();
  return { close };
}
