// "File is ready" step shared by the PDF builders (order blanks, debt statement): the file is kept
// in the sheet so it can be opened to look at before it is shared/saved (Open uses a blob URL in a
// new tab -- the sheet stays here, so the app is never left on the file with no way back).
import { t } from "./i18n.js";
import { activateDialog, saveBlob, escapeHtml, showToast } from "./util.js";
import { api } from "./api.js";

// Fills an existing sheet element; `close` removes the whole overlay.
export function renderFileReady(sheet, blob, name, close) {
  const url = URL.createObjectURL(blob);
  sheet.innerHTML = `
    <h2>${t("file_ready")}</h2>
    <p class="muted">${escapeHtml(name)}</p>
    <div class="sheet-actions">
      <button type="button" class="btn" data-action="done">${t("close")}</button>
      <button type="button" class="btn" data-action="share">${t("file_share")}</button>
      <button type="button" class="btn btn-primary" data-action="open">${t("file_open")}</button>
    </div>
    <button type="button" class="btn btn-block file-ready-image" data-action="image">${t("file_save_image_long")}</button>`;
  const finish = () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    close();
  };
  sheet.querySelector('[data-action="done"]').addEventListener("click", finish);
  sheet.querySelector('[data-action="share"]').addEventListener("click", () => saveBlob(blob, name));
  // "Save as image" (owner, 2026-10-27): the PDF as one JPEG for the phone's photos. Converted as soon as the sheet opens, so the tap shares
  // it at once (iOS refuses a share that waits on the network).
  let picture = null;
  const picturePromise = blob.type === "application/pdf" || /\.pdf$/i.test(name)
    ? api.pdfToImage(blob).then((b) => (picture = b))
    : Promise.resolve((picture = blob));
  picturePromise.catch(() => {});
  const imageBtn = sheet.querySelector('[data-action="image"]');
  imageBtn.addEventListener("click", async () => {
    const jpgName = name.replace(/\.pdf$/i, "") + ".jpg";
    if (picture) return saveBlob(picture, jpgName);
    imageBtn.disabled = true;
    try {
      await saveBlob(await picturePromise, jpgName);
    } catch {
      showToast(t("file_save_image_unavailable"));
    } finally {
      imageBtn.disabled = false;
    }
  });
  sheet.querySelector('[data-action="open"]').addEventListener("click", () => {
    if (!window.open(url, "_blank")) saveBlob(blob, name); // popup blocked
  });
}

// A standalone ready-sheet on top of the current screen.
export function openFileReadySheet(blob, name) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  renderFileReady(overlay.querySelector(".sheet"), blob, name, close);
}
