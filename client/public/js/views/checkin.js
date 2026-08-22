import { api } from "../api.js";
import { escapeHtml, getCurrentPosition, compressImage, formatDistance } from "../util.js";
import { enqueueCheckin } from "../offlineQueue.js";

export async function renderCheckin(root, navigate, customerId) {
  root.innerHTML = `<div class="checkin-view"><p class="muted">Loading customer…</p></div>`;
  const container = root.querySelector(".checkin-view");

  let customer;
  try {
    customer = await api.getCustomer(customerId);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = `
    <h1>${escapeHtml(customer.name)}</h1>
    <div class="gps-status" id="gps-status">Getting your location…</div>

    <form id="checkin-form">
      <label>
        Note (optional)
        <textarea name="note" rows="3" placeholder="What did you cover during this visit?"></textarea>
      </label>
      <label class="photo-field">
        Photo (optional)
        <input type="file" name="photo" accept="image/*" capture="environment" />
        <img id="photo-preview" hidden />
      </label>
      <p class="form-error" id="checkin-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block" id="checkin-submit" disabled>
        Locating…
      </button>
    </form>
    <div id="checkin-result" hidden></div>
  `;

  const gpsStatus = container.querySelector("#gps-status");
  const submitBtn = container.querySelector("#checkin-submit");
  const form = container.querySelector("#checkin-form");
  const errorEl = container.querySelector("#checkin-error");
  const resultEl = container.querySelector("#checkin-result");
  const photoInput = container.querySelector('input[name="photo"]');
  const photoPreview = container.querySelector("#photo-preview");

  let position = null;
  let compressedPhoto = null;

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    if (!file) {
      photoPreview.hidden = true;
      compressedPhoto = null;
      return;
    }
    try {
      compressedPhoto = await compressImage(file);
      photoPreview.src = URL.createObjectURL(compressedPhoto);
      photoPreview.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  try {
    position = await getCurrentPosition();
    gpsStatus.textContent = `Location captured (±${Math.round(position.coords.accuracy)}m accuracy)`;
    gpsStatus.classList.add("gps-ok");
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit check-in";
  } catch (err) {
    gpsStatus.textContent = `Could not get your location: ${err.message}. Enable location access and reload.`;
    gpsStatus.classList.add("gps-error");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!position) return;
    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";

    const note = new FormData(form).get("note");
    const { latitude: lat, longitude: lng } = position.coords;

    const formData = new FormData();
    formData.set("customer_id", customerId);
    formData.set("lat", lat);
    formData.set("lng", lng);
    if (note) formData.set("note", note);
    if (compressedPhoto) formData.set("photo", compressedPhoto, "checkin.jpg");

    try {
      const checkin = await api.createCheckin(formData);
      showResult(checkin);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure — queue it instead of losing the visit.
        let photoDataUrl = null;
        if (compressedPhoto) photoDataUrl = await blobToDataUrl(compressedPhoto);
        enqueueCheckin({ customerId, lat, lng, note, photoDataUrl });
        showQueued();
      } else {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit check-in";
      }
    }
  });

  function showResult(checkin) {
    form.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="checkin-result ${checkin.within_range ? "result-success" : "result-warning"}">
        <div class="result-icon">${checkin.within_range ? "✓" : "!"}</div>
        <h2>${checkin.within_range ? "Location verified" : "Location mismatch"}</h2>
        <p>${
          checkin.within_range
            ? "You checked in on-site."
            : `You were ${formatDistance(checkin.distance_meters)} from ${escapeHtml(customer.name)}.`
        }</p>
        <button class="btn btn-primary btn-block" id="back-to-customer">Done</button>
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
        <h2>You're offline</h2>
        <p>Your check-in was saved on this device and will upload automatically once you're back online.</p>
        <button class="btn btn-primary btn-block" id="back-to-customer">Done</button>
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
