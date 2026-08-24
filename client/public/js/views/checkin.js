import { api } from "../api.js";
import { escapeHtml, getCurrentPosition, compressImage, formatDistance, haversineMeters, activateDialog } from "../util.js";
import { enqueueCheckin } from "../offlineQueue.js";
import { t, getLang } from "../i18n.js";
import { icons } from "../icons.js";

const OUTCOME_OPTIONS = [
  { value: "order_placed", labelKey: "outcome_order_placed", icon: icons.cart },
  { value: "no_order", labelKey: "outcome_no_order", icon: icons.noOrder },
  { value: "payment_collected", labelKey: "outcome_payment_collected", icon: icons.payment },
  { value: "follow_up_required", labelKey: "outcome_follow_up_required", icon: icons.clock },
  { value: "assortment_check", labelKey: "outcome_assortment_check", icon: icons.clipboardCheck },
  { value: "customer_unavailable", labelKey: "outcome_customer_unavailable", icon: icons.door },
  { value: "complaint", labelKey: "outcome_complaint", icon: icons.warning },
  { value: "other", labelKey: "outcome_other", icon: icons.more },
];

// Castrol/Lotos/Royal each get their own status tags; Competitors is a flat
// list of brand names (presence is implied by ticking the name, no sub-status).
const BRAND_GROUPS = [
  {
    key: "castrol",
    labelKey: "brand_group_castrol",
    options: [
      "available",
      "unavailable",
      "full_range",
      "fake",
      "imported_us",
      "imported_dubai",
      "imported_ru",
      "imported_other",
    ].map((v) => ({ value: v, labelKey: `brand_status_${v}` })),
  },
  {
    key: "lotos",
    labelKey: "brand_group_lotos",
    options: ["available", "unavailable", "full_range"].map((v) => ({ value: v, labelKey: `brand_status_${v}` })),
  },
  {
    key: "royal",
    labelKey: "brand_group_royal",
    options: ["available", "unavailable", "full_range"].map((v) => ({ value: v, labelKey: `brand_status_${v}` })),
  },
  {
    key: "competitors",
    labelKey: "brand_group_competitors",
    options: ["mobil", "motul", "shell", "liquimoly", "bardahl", "aral", "oscar", "zic", "russian_oil"].map((v) => ({
      value: v,
      labelKey: `competitor_${v}`,
    })),
  },
];

export async function renderCheckin(root, navigate, customerId) {
  root.innerHTML = `<div class="checkin-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
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
              <input type="checkbox" name="outcomes" value="${o.value}" />
              <span class="outcome-icon">${o.icon}</span>
              <span>${t(o.labelKey)}</span>
            </label>
          `
          ).join("")}
        </div>
        <p class="form-error" id="outcome-error" hidden>${t("select_outcome_required")}</p>
      </label>

      <label class="brands-label">
        ${t("products_found")}
        <div class="brand-group-grid" id="brand-group-grid">
          ${BRAND_GROUPS.map(
            (g) => `
            <button type="button" class="brand-group-btn" data-brand-group="${g.key}">${t(g.labelKey)}</button>
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
          <img id="photo-preview" alt="${t("photo_optional")}" />
          <button type="button" class="photo-remove-btn" id="photo-remove-btn" aria-label="${t("remove_photo")}">&times;</button>
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
  const removePhotoBtn = container.querySelector("#photo-remove-btn");
  const outcomeError = container.querySelector("#outcome-error");

  let position = null;
  let compressedPhoto = null;
  const brandStatus = Object.fromEntries(BRAND_GROUPS.map((g) => [g.key, []]));

  function paintBrandGroupButtons() {
    container.querySelectorAll("[data-brand-group]").forEach((btn) => {
      btn.classList.toggle("brand-group-btn-active", brandStatus[btn.dataset.brandGroup].length > 0);
    });
  }

  function openBrandSheet(group) {
    const selected = new Set(brandStatus[group.key]);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${escapeHtml(t(group.labelKey))}</h2>
        <div class="brand-grid">
          ${group.options
            .map(
              (o) => `
            <label class="brand-chip">
              <input type="checkbox" value="${o.value}" ${selected.has(o.value) ? "checked" : ""} />
              <span>${escapeHtml(t(o.labelKey))}</span>
            </label>
          `
            )
            .join("")}
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn btn-primary btn-block" id="brand-sheet-done">${t("done")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    // "Available" and "Not available" are contradictory -- picking one
    // clears the other, while every other tag stays freely combinable.
    overlay.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked && (input.value === "available" || input.value === "unavailable")) {
          const other = input.value === "available" ? "unavailable" : "available";
          const otherInput = overlay.querySelector(`input[value="${other}"]`);
          if (otherInput) otherInput.checked = false;
        }
      });
    });

    overlay.querySelector("#brand-sheet-done").addEventListener("click", () => {
      brandStatus[group.key] = [...overlay.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
      paintBrandGroupButtons();
      close();
    });
  }

  container.querySelectorAll("[data-brand-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = BRAND_GROUPS.find((g) => g.key === btn.dataset.brandGroup);
      if (group) openBrandSheet(group);
    });
  });

  container.querySelectorAll('input[name="outcomes"]').forEach((input) => {
    input.addEventListener("change", () => {
      outcomeError.hidden = true;
    });
  });

  cameraBtn.addEventListener("click", () => photoInput.click());
  retakeBtn.addEventListener("click", () => photoInput.click());
  removePhotoBtn.addEventListener("click", () => {
    compressedPhoto = null;
    photoInput.value = "";
    photoPreview.src = "";
    previewWrap.hidden = true;
    cameraBtn.hidden = false;
  });

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

  async function acquirePosition() {
    position = null;
    submitBtn.disabled = true;
    submitBtn.textContent = t("locating");
    verifyBanner.hidden = true;
    gpsStatus.className = "gps-status";
    gpsStatus.textContent = t("getting_location");
    gpsStatus.setAttribute("aria-busy", "true");
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
      gpsStatus.textContent = `${t("location_error")}: ${err.message}. `;
      gpsStatus.classList.add("gps-error");
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn btn-sm gps-retry-btn";
      retryBtn.textContent = t("retry");
      retryBtn.addEventListener("click", acquirePosition);
      gpsStatus.appendChild(retryBtn);
    } finally {
      gpsStatus.removeAttribute("aria-busy");
    }
  }

  await acquirePosition();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!position) return;

    const data = new FormData(form);
    const outcomes = data.getAll("outcomes");
    if (!outcomes.length) {
      outcomeError.hidden = false;
      outcomeError.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("submitting");
    form.setAttribute("aria-busy", "true");

    const note = data.get("note");
    const brandStatusPayload = Object.fromEntries(Object.entries(brandStatus).filter(([, v]) => v.length));
    const { latitude: lat, longitude: lng } = position.coords;

    const formData = new FormData();
    formData.set("customer_id", customerId);
    formData.set("lat", lat);
    formData.set("lng", lng);
    if (note) formData.set("note", note);
    formData.set("outcomes", JSON.stringify(outcomes));
    if (Object.keys(brandStatusPayload).length) formData.set("brand_status", JSON.stringify(brandStatusPayload));
    if (compressedPhoto) formData.set("photo", compressedPhoto, "checkin.jpg");

    try {
      const checkin = await api.createCheckin(formData);
      showResult(checkin);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure — queue it instead of losing the visit.
        let photoDataUrl = null;
        if (compressedPhoto) photoDataUrl = await blobToDataUrl(compressedPhoto);
        enqueueCheckin({ customerId, lat, lng, note, brandStatus: brandStatusPayload, outcomes, photoDataUrl });
        showQueued();
      } else {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = t("submit_checkin");
        form.removeAttribute("aria-busy");
      }
    }
  });

  function showResult(checkin) {
    form.removeAttribute("aria-busy");
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
    form.removeAttribute("aria-busy");
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
