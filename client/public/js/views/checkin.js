import { api } from "../api.js";
import { escapeHtml, getCurrentPosition, compressImage, formatDistance, haversineMeters } from "../util.js";
import { enqueueCheckin } from "../offlineQueue.js";
import { t, getLang } from "../i18n.js";

const BRAND_OPTIONS = [
  { value: "castrol", labelKey: "brand_castrol" },
  { value: "lotos", labelKey: "brand_lotos" },
  { value: "royal", labelKey: "brand_royal" },
  { value: "fake", labelKey: "brand_fake" },
  { value: "other_imports", labelKey: "brand_other_imports" },
  { value: "none", labelKey: "brand_none" },
];

const OUTCOME_OPTIONS = [
  { value: "order_placed", labelKey: "outcome_order_placed", icon: "🛒" },
  { value: "no_order", labelKey: "outcome_no_order", icon: "⊘" },
  { value: "payment_collected", labelKey: "outcome_payment_collected", icon: "💳" },
  { value: "follow_up_required", labelKey: "outcome_follow_up_required", icon: "⏰" },
  { value: "customer_unavailable", labelKey: "outcome_customer_unavailable", icon: "🚪" },
  { value: "complaint", labelKey: "outcome_complaint", icon: "⚠️" },
  { value: "stock_issue", labelKey: "outcome_stock_issue", icon: "📦" },
  { value: "other", labelKey: "outcome_other", icon: "⋯" },
];

export async function renderCheckin(root, navigate, customerId) {
  root.innerHTML = `<div class="checkin-view"><p class="muted">…</p></div>`;
  const container = root.querySelector(".checkin-view");

  let customer, settings;
  try {
    [customer, settings] = await Promise.all([api.getCustomer(customerId), api.getSettings()]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const radiusMeters = settings.checkin_radius_meters;

  container.innerHTML = `
    <h1>${escapeHtml(customer.name)}</h1>
    <div class="gps-status" id="gps-status">${t("getting_location")}</div>
    <div class="verify-banner" id="verify-banner" hidden></div>

    <form id="checkin-form">
      <label class="outcome-label">
        ${t("visit_outcome")}
        <div class="outcome-grid">
          ${OUTCOME_OPTIONS.map(
            (o) => `
            <label class="outcome-chip">
              <input type="radio" name="outcome" value="${o.value}" />
              <span class="outcome-icon">${o.icon}</span>
              <span>${t(o.labelKey)}</span>
            </label>
          `
          ).join("")}
        </div>
      </label>

      <label class="brands-label">
        ${t("products_found")}
        <div class="brand-grid">
          ${BRAND_OPTIONS.map(
            (b) => `
            <label class="brand-chip">
              <input type="checkbox" name="brands" value="${b.value}" />
              <span>${t(b.labelKey)}</span>
            </label>
          `
          ).join("")}
        </div>
      </label>

      <label>
        ${t("note_optional")}
        <textarea name="note" rows="3" placeholder="${t("note_placeholder")}"></textarea>
      </label>

      <div class="camera-field">
        <input type="file" name="photo" accept="image/*" capture="environment" id="photo-input" class="visually-hidden" />
        <button type="button" class="camera-btn" id="camera-btn" aria-label="${t("take_photo")}">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
            <circle cx="12" cy="13" r="3.5"/>
          </svg>
          <span>${t("take_photo")}</span>
        </button>
        <div class="photo-preview-wrap" id="photo-preview-wrap" hidden>
          <img id="photo-preview" />
          <button type="button" class="photo-retake-btn" id="photo-retake-btn">${t("retake_photo")}</button>
        </div>
      </div>

      <p class="form-error" id="checkin-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block" id="checkin-submit" disabled>
        ${t("locating")}
      </button>
    </form>
    <div id="checkin-result" hidden></div>
  `;

  const gpsStatus = container.querySelector("#gps-status");
  const verifyBanner = container.querySelector("#verify-banner");
  const submitBtn = container.querySelector("#checkin-submit");
  const form = container.querySelector("#checkin-form");
  const errorEl = container.querySelector("#checkin-error");
  const resultEl = container.querySelector("#checkin-result");
  const photoInput = container.querySelector("#photo-input");
  const cameraBtn = container.querySelector("#camera-btn");
  const previewWrap = container.querySelector("#photo-preview-wrap");
  const photoPreview = container.querySelector("#photo-preview");
  const retakeBtn = container.querySelector("#photo-retake-btn");

  let position = null;
  let compressedPhoto = null;

  cameraBtn.addEventListener("click", () => photoInput.click());
  retakeBtn.addEventListener("click", () => photoInput.click());

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    if (!file) return;
    try {
      compressedPhoto = await compressImage(file);
      photoPreview.src = URL.createObjectURL(compressedPhoto);
      previewWrap.hidden = false;
      cameraBtn.hidden = true;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  try {
    position = await getCurrentPosition();
    const accuracy = Math.round(position.coords.accuracy);
    const unit = getLang() === "hy" ? "մ" : "m";
    gpsStatus.textContent = `${t("location_captured")} (±${accuracy}${unit} ${t("accuracy")})`;
    gpsStatus.classList.add("gps-ok");
    submitBtn.disabled = false;
    submitBtn.textContent = t("submit_checkin");

    const distance = haversineMeters(position.coords.latitude, position.coords.longitude, customer.lat, customer.lng);
    const withinRange = distance <= radiusMeters;
    verifyBanner.hidden = false;
    verifyBanner.className = `verify-banner ${withinRange ? "verify-banner-success" : "verify-banner-warning"}`;
    verifyBanner.innerHTML = `
      <span class="verify-banner-icon">${withinRange ? "✓" : "!"}</span>
      <div>
        <strong>${withinRange ? t("location_verified") : t("location_mismatch_away")}</strong>
        <span class="muted">${t("you_are")} ${formatDistance(distance)} ${t("from_customer")}</span>
      </div>
    `;
  } catch (err) {
    gpsStatus.textContent = `${t("location_error")}: ${err.message}. ${t("enable_location_reload")}`;
    gpsStatus.classList.add("gps-error");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!position) return;
    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("submitting");

    const data = new FormData(form);
    const note = data.get("note");
    const brands = data.getAll("brands");
    const outcome = data.get("outcome");
    const { latitude: lat, longitude: lng } = position.coords;

    const formData = new FormData();
    formData.set("customer_id", customerId);
    formData.set("lat", lat);
    formData.set("lng", lng);
    if (note) formData.set("note", note);
    if (outcome) formData.set("outcome", outcome);
    if (brands.length) formData.set("brands_found", JSON.stringify(brands));
    if (compressedPhoto) formData.set("photo", compressedPhoto, "checkin.jpg");

    try {
      const checkin = await api.createCheckin(formData);
      showResult(checkin);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure — queue it instead of losing the visit.
        let photoDataUrl = null;
        if (compressedPhoto) photoDataUrl = await blobToDataUrl(compressedPhoto);
        enqueueCheckin({ customerId, lat, lng, note, brands, outcome, photoDataUrl });
        showQueued();
      } else {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t("submit_checkin");
      }
    }
  });

  function showResult(checkin) {
    form.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="checkin-result ${checkin.within_range ? "result-success" : "result-warning"}">
        <div class="result-icon">${checkin.within_range ? "✓" : "!"}</div>
        <h2>${checkin.within_range ? t("location_verified") : t("location_mismatch_away")}</h2>
        <p>${
          checkin.within_range
            ? t("checked_in_onsite")
            : `${t("you_were")} ${formatDistance(checkin.distance_meters)} ${t("from")} ${escapeHtml(customer.name)}.`
        }</p>
        <button class="btn btn-primary btn-block" id="back-to-customer">${t("done")}</button>
      </div>
    `;
    resultEl.querySelector("#back-to-customer").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }

  function showQueued() {
    form.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="checkin-result result-warning">
        <div class="result-icon">⇪</div>
        <h2>${t("youre_offline")}</h2>
        <p>${t("offline_queued_message")}</p>
        <button class="btn btn-primary btn-block" id="back-to-customer">${t("done")}</button>
      </div>
    `;
    resultEl.querySelector("#back-to-customer").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
