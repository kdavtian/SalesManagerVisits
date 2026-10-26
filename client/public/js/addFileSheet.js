// "Add document" for a customer: take (or pick) a photo of a signed order blank / payment slip / other paper, turn it upright if it was
// photographed sideways, optionally tie it to one or more of the customer's orders, and save it into the customer's Files.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, compressImage, rotateImageBlob, formatDateDMY, showToast } from "./util.js";

const KINDS = ["order_blank", "payment_slip", "other"];

export function openAddFileSheet({ customer, onAdded, kind = "order_blank" } = {}) {
  let chosenKind = kind;
  let blob = null;
  let previewUrl = null;
  const linked = new Set();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet add-file-sheet">
      <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("add_document")}</h2>
      <p class="muted">${escapeHtml(customer.name)}</p>
      <div class="add-file-kinds" role="radiogroup">
        ${KINDS.map((k) => `<button type="button" class="map-filter-chip ${k === chosenKind ? "chip-active" : ""}" data-kind="${k}" aria-pressed="${k === chosenKind}">${t(`file_kind_${k}`)}</button>`).join("")}
      </div>
      <input type="file" id="add-file-camera" accept="image/*" capture="environment" class="visually-hidden" />
      <input type="file" id="add-file-library" accept="image/*" class="visually-hidden" />
      <div class="add-file-preview" id="add-file-preview" hidden>
        <img alt="" />
        <div class="add-file-turn">
          <button type="button" class="btn btn-sm" data-turn="270">&#8634; ${t("rotate_left")}</button>
          <button type="button" class="btn btn-sm" data-turn="90">&#8635; ${t("rotate_right")}</button>
        </div>
      </div>
      <div class="add-file-pick" id="add-file-pick">
        <button type="button" class="camera-btn" id="add-file-take"><span>${t("take_photo")}</span></button>
        <button type="button" class="btn btn-block" id="add-file-choose">${t("choose_from_library")}</button>
      </div>
      <div id="add-file-orders" hidden>
        <p class="muted add-file-orders-title">${t("add_document_orders")}</p>
        <div class="add-file-order-list" id="add-file-order-list"></div>
      </div>
      <label><span>${t("note_optional")}</span><input type="text" id="add-file-note" maxlength="500" /></label>
      <p class="form-error" id="add-file-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" data-action="close-sheet">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="add-file-save" disabled>${t("save")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    overlay.remove();
  };
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelectorAll('[data-action="close-sheet"]').forEach((b) => b.addEventListener("click", close));

  const preview = overlay.querySelector("#add-file-preview");
  const saveBtn = overlay.querySelector("#add-file-save");
  const errorEl = overlay.querySelector("#add-file-error");

  overlay.querySelectorAll("[data-kind]").forEach((btn) =>
    btn.addEventListener("click", () => {
      chosenKind = btn.dataset.kind;
      overlay.querySelectorAll("[data-kind]").forEach((b) => {
        b.classList.toggle("chip-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
    })
  );

  function paintPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    preview.querySelector("img").src = previewUrl;
    preview.hidden = false;
    overlay.querySelector("#add-file-pick").hidden = true;
    saveBtn.disabled = false;
    loadOrders();
  }
  async function take(file) {
    if (!file) return;
    try {
      // Documents keep a size where small print and signatures stay readable.
      blob = await compressImage(file, { maxDimension: 2400, quality: 0.9 });
      errorEl.hidden = true;
      paintPreview();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }
  const camera = overlay.querySelector("#add-file-camera");
  const library = overlay.querySelector("#add-file-library");
  overlay.querySelector("#add-file-take").addEventListener("click", () => camera.click());
  overlay.querySelector("#add-file-choose").addEventListener("click", () => library.click());
  for (const input of [camera, library]) {
    input.addEventListener("change", () => {
      const file = input.files[0];
      input.value = "";
      take(file);
    });
  }
  preview.querySelectorAll("[data-turn]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        blob = await rotateImageBlob(blob, Number(btn.dataset.turn));
        paintPreview();
      } finally {
        btn.disabled = false;
      }
    })
  );

  // The customer's own orders, so the paper can be tied to the ones it proves (optional).
  let ordersLoaded = false;
  async function loadOrders() {
    if (ordersLoaded) return;
    ordersLoaded = true;
    const box = overlay.querySelector("#add-file-orders");
    try {
      const orders = ((await api.listOrders({ customer_id: customer.id }, { fresh: true })).rows ?? []).slice(0, 12);
      if (!orders.length) return;
      box.hidden = false;
      overlay.querySelector("#add-file-order-list").innerHTML = orders
        .map(
          (o) => `<label class="delivered-order-row"><input type="checkbox" value="${o.id}" /><span class="delivered-order-main"><strong>${escapeHtml(o.order_code || `#${o.id}`)}</strong><span class="muted">${escapeHtml(formatDateDMY(o.created_at))}</span></span></label>`
        )
        .join("");
      box.querySelectorAll('input[type="checkbox"]').forEach((cb) =>
        cb.addEventListener("change", () => (cb.checked ? linked.add(Number(cb.value)) : linked.delete(Number(cb.value))))
      );
    } catch {
      /* the link is optional */
    }
  }

  saveBtn.addEventListener("click", async () => {
    if (!blob) return;
    saveBtn.disabled = true;
    saveBtn.textContent = t("submitting");
    errorEl.hidden = true;
    const form = new FormData();
    form.set("file", blob, "document.jpg");
    form.set("kind", chosenKind);
    if (linked.size) form.set("order_ids", JSON.stringify([...linked]));
    const note = overlay.querySelector("#add-file-note").value.trim();
    if (note) form.set("note", note);
    try {
      await api.addCustomerFile(customer.id, form);
      close();
      showToast(t("document_added"));
      onAdded?.();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = t("save");
    }
  });
  return { close };
}
