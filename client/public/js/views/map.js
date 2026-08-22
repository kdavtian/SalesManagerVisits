import { api } from "../api.js";
import { escapeHtml } from "../util.js";

export function renderMap(root, navigate) {
  root.innerHTML = `
    <div class="map-view">
      <div id="leaflet-map"></div>
      <button class="fab" id="add-customer-fab" title="Add customer">+</button>
      <div class="map-hint" id="map-hint" hidden>Tap the map to place a pin for the new customer</div>
    </div>
  `;

  const mapEl = root.querySelector("#leaflet-map");
  const hint = root.querySelector("#map-hint");
  const fab = root.querySelector("#add-customer-fab");

  const map = L.map(mapEl, { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  // The container can report zero size right after being inserted into the
  // DOM (e.g. mid-transition); re-measure once the browser has settled.
  requestAnimationFrame(() => map.invalidateSize());

  let addMode = false;
  let placingMarker = null;
  const markerLayer = L.layerGroup().addTo(map);

  function customerIcon(visited) {
    return L.divIcon({
      className: "",
      html: `<div class="pin ${visited ? "pin-visited" : "pin-pending"}"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -22],
    });
  }

  async function loadCustomers() {
    const customers = await api.listCustomers();
    markerLayer.clearLayers();

    const bounds = [];
    for (const c of customers) {
      const marker = L.marker([c.lat, c.lng], { icon: customerIcon(c.visited_this_week) });
      marker.bindPopup(`
        <div class="map-popup">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.category ? `<div class="popup-category">${escapeHtml(c.category)}</div>` : ""}
          <div class="popup-actions">
            <button data-action="details" data-id="${c.id}">Details</button>
            <button data-action="checkin" data-id="${c.id}" class="btn-accent">Check In</button>
          </div>
        </div>
      `);
      marker.on("popupopen", (e) => {
        const popupEl = e.popup.getElement();
        popupEl.querySelector('[data-action="details"]').addEventListener("click", () => {
          navigate(`#/customers/${c.id}`);
        });
        popupEl.querySelector('[data-action="checkin"]').addEventListener("click", () => {
          navigate(`#/checkin/${c.id}`);
        });
      });
      marker.addTo(markerLayer);
      bounds.push([c.lat, c.lng]);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 13),
        () => {}
      );
    }
  }

  fab.addEventListener("click", () => {
    addMode = !addMode;
    fab.classList.toggle("fab-active", addMode);
    hint.hidden = !addMode;
    mapEl.classList.toggle("map-picking", addMode);
  });

  map.on("click", (e) => {
    if (!addMode) return;

    if (placingMarker) map.removeLayer(placingMarker);
    placingMarker = L.marker(e.latlng, { icon: customerIcon(false) }).addTo(map);

    addMode = false;
    fab.classList.remove("fab-active");
    hint.hidden = true;
    mapEl.classList.remove("map-picking");

    openNewCustomerForm(e.latlng);
  });

  function openNewCustomerForm(latlng) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>New customer</h2>
        <form id="new-customer-form">
          <label>Name<input name="name" required /></label>
          <label>Category<input name="category" placeholder="e.g. garage, lube shop" /></label>
          <label>Phone<input name="phone" type="tel" /></label>
          <label>Address<input name="address" /></label>
          <label>Notes<textarea name="notes" rows="2"></textarea></label>
          <p class="form-error" id="new-customer-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-new-customer">Cancel</button>
            <button type="submit" class="btn btn-primary">Save customer</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      if (placingMarker) {
        map.removeLayer(placingMarker);
        placingMarker = null;
      }
    }

    overlay.querySelector("#cancel-new-customer").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const form = overlay.querySelector("#new-customer-form");
    const errorEl = overlay.querySelector("#new-customer-error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.createCustomer({
          name: data.get("name"),
          category: data.get("category") || null,
          phone: data.get("phone") || null,
          address: data.get("address") || null,
          notes: data.get("notes") || null,
          lat: latlng.lat,
          lng: latlng.lng,
        });
        overlay.remove();
        placingMarker = null;
        loadCustomers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  loadCustomers();

  return () => map.remove();
}
