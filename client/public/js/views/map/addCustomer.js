// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { CATEGORY_LIST, REGION_LIST, SALES_CHANNELS, YEREVAN_DISTRICTS, activateCategorySelector, activateCombobox, activateDialog, activateTierSelector, categorySelectorHtml, escapeHtml, formatAmd, getCurrentPosition, matchRegion, matchSubregion, normalizePhone, regionLabelHy, setTierSelectorValue, showToast, subregionLabelHy, tierSelectorHtml } from "../../util.js";
import { api } from "../../api.js";
import { canEditDirectly, canReassignCustomers, state } from "../../state.js";
import { movesAnyPinAtOnce } from "../../shared/roles.js";
import { placeNoticeText, wirePlaceInput } from "../../places.js";
import { installInlineClearButton } from "../../searchBar.js";

export function onMapTouchEnd(ctx, e) {
  if (e.touches.length > 0 || e.changedTouches.length !== 1) {
    ctx.lastTapTime = 0;
    ctx.lastTapPoint = null;
    return;
  }
  if (e.target.closest(".leaflet-control, .leaflet-popup")) return;
  const point = ctx.map.mouseEventToContainerPoint(e.changedTouches[0]);
  const now = Date.now();
  if (ctx.lastTapPoint && now - ctx.lastTapTime < 350 && point.distanceTo(ctx.lastTapPoint) < 30) {
    e.preventDefault();
    ctx.map.setZoomAround(ctx.map.containerPointToLatLng(point), ctx.map.getZoom() + 1);
    ctx.lastTapTime = 0;
    ctx.lastTapPoint = null;
  } else {
    ctx.lastTapTime = now;
    ctx.lastTapPoint = point;
  }
}

export function cancelLongPress(ctx) {
  clearTimeout(ctx.longPressTimer);
  ctx.longPressTimer = null;
  ctx.longPressStart = null;
}

export function triggerAddAtPoint(ctx, latlng) {
  if (ctx.relocateCustomerId || ctx.addMode) return;
  if (navigator.vibrate) navigator.vibrate(15);
  ctx.addMode = true;
  ctx.fab.classList.add("fab-active");
  ctx.fab.setAttribute("aria-pressed", "true");
  ctx.mapEl.classList.add("map-picking");
  ctx.placeLocationPin(latlng, { source: "dragged_pin", onConfirm: ctx.handoffToCustomerForm });
}

// "Tap the map to place a pin" is only true while add mode is waiting for that tap: it used to stay on screen for the
// whole session (the add flow's own pin, the form, and after saving), telling the rep to tap when taps did nothing.
export function syncAddHint(ctx) {
  ctx.hint.hidden = !(ctx.addMode && !ctx.placingMarker && !ctx.relocateCustomerId);
}

export function removePlacingMarker(ctx) {
  if (ctx.placingMarker) {
    ctx.map.removeLayer(ctx.placingMarker);
    ctx.placingMarker = null;
  }
  ctx.syncAddHint();
}

export function closeLocationPanel(ctx) {
  ctx.locationPanel.hidden = true;
  ctx.locationPanel.innerHTML = "";
  if (!ctx.relocateCustomerId) ctx.fab.hidden = false;
}

// Full abandon: closes the panel and removes the pin entirely. Used when
// the rep backs out of picking a location altogether (tapping the FAB a
// second time to cancel). Not used when handing off to the customer-
// details form below -- that keeps the pin on the map and takes over its
// lifecycle itself.
export function cancelLocationPicker(ctx) {
  ctx.closeLocationPanel();
  ctx.removePlacingMarker();
  if (!ctx.relocateCustomerId) {
    ctx.addMode = false;
    ctx.fab.classList.remove("fab-active");
    ctx.fab.setAttribute("aria-pressed", "false");
    ctx.mapEl.classList.remove("map-picking");
    ctx.syncAddHint();
    // The add flow is over: the address must stop saying so, or Back / a later visit re-enters add mode.
    if (ctx.startInAddMode) {
      ctx.startInAddMode = false;
      ctx.navigate.rewrite?.("#/map");
    }
  }
}

// Location confirmed -- resets the picker's own UI state but leaves the
// pin on the map for openNewCustomerForm to keep showing (and to remove
// itself, on that form's own cancel/save).
export function handoffToCustomerForm(ctx, latlng) {
  ctx.closeLocationPanel();
  ctx.addMode = false;
  ctx.syncAddHint();
  ctx.fab.classList.remove("fab-active");
  ctx.fab.setAttribute("aria-pressed", "false");
  ctx.mapEl.classList.remove("map-picking");
  // Freeze the pin in place -- the details form below doesn't listen for
  // further drags (it reverse-geocodes once, at open), so leaving it
  // draggable would let a drag here reopen the location panel on top of
  // that form instead of updating it.
  ctx.placingMarker?.dragging?.disable();
  ctx.openNewCustomerForm(latlng);
}

// Places (or moves) the one draggable "proposed location" pin, distinct
// from the blue "me" dot (.me-dot, only shown via the Locate button) so
// there's never any doubt which marker is about to be saved. Dragging it
// re-runs the same confirm step against the new spot -- nothing is
// written until Confirm is tapped.
export function placeLocationPin(ctx, latlng, opts) {
  if (ctx.placingMarker) {
    ctx.placingMarker.setLatLng(latlng);
  } else {
    ctx.placingMarker = L.marker(latlng, {
      icon: L.divIcon({ className: "", html: ctx.NEW_PIN_HTML, iconSize: [26, 26], iconAnchor: [13, 26] }),
      draggable: true,
      autoPan: true,
    }).addTo(ctx.map);
    ctx.placingMarker.on("dragend", () => {
      ctx.showLocationPanel(ctx.placingMarker.getLatLng(), { ...opts, source: "dragged_pin", accuracy: undefined, onConfirm: opts.onConfirm });
    });
  }
  ctx.syncAddHint();
  ctx.showLocationPanel(latlng, opts);
}

// The panel is bottom-docked at the same spot the FAB sits in, so the two
// would visually stack -- hide the FAB for as long as the panel is open
// and give the panel its own close (X) instead, consistent with the
// rest of the app's dismiss-vs-back convention (this is a temporary
// overlay panel, not a pushed page, so X rather than a back arrow).
export function renderLocationPanelShell(ctx, bodyHtml) {
  ctx.fab.hidden = true;
  ctx.locationPanel.hidden = false;
  ctx.locationPanel.innerHTML = `
    <button type="button" class="icon-btn location-picker-close" id="location-panel-close" aria-label="${t("cancel")}">${icons.close}</button>
    ${bodyHtml}
  `;
  ctx.locationPanel.querySelector("#location-panel-close").addEventListener("click", ctx.cancelLocationPicker);
}

// The one confirm panel for "here's the proposed location" -- title and
// accuracy line vary with how the pin got there, everything else
// (address line, Confirm/Change-address actions, drag-to-adjust hint) is
// identical whether it came from a fresh GPS fix, a dragged pin, a
// searched address, or an existing customer's saved location.
export function showLocationPanel(ctx, latlng, { source, accuracy, onConfirm }) {
  const title =
    source === "dragged_pin"
      ? t("new_selected_address")
      : source === "geocoded_address"
        ? t("location_updated_title")
        : t("selected_location");
  const lowAccuracy = accuracy != null && accuracy > 50;
  ctx.renderLocationPanelShell(`
    <h2>${title}</h2>
    <p class="location-picker-address" id="location-panel-address"><span class="skeleton-bar" role="status" aria-label="${escapeHtml(t("loading"))}"></span></p>
    ${
      accuracy != null
        ? `<p class="location-picker-accuracy ${lowAccuracy ? "location-picker-accuracy-low" : ""}">${icons.locate}${
            lowAccuracy
              ? t("low_accuracy_warning").replace("{m}", String(Math.round(accuracy)))
              : t("gps_accuracy_label").replace("{m}", String(Math.round(accuracy)))
          }</p>`
        : ""
    }
    <p class="muted location-picker-hint">${t("drag_pin_hint")}</p>
    <div class="location-picker-actions">
      <button type="button" class="btn" id="location-panel-address-btn">${t("change_address")}</button>
      <button type="button" class="btn btn-primary" id="location-panel-confirm-btn">${t("confirm_location")}</button>
    </div>
  `);

  const myToken = ++ctx.geocodeToken;
  api
    .reverseGeocode(latlng.lat, latlng.lng)
    .then((result) => {
      if (myToken !== ctx.geocodeToken) return; // pin moved again since this request went out
      const addressEl = document.getElementById("location-panel-address");
      if (addressEl) addressEl.textContent = result?.address || t("address_unknown");
    })
    .catch(() => {
      if (myToken !== ctx.geocodeToken) return;
      const addressEl = document.getElementById("location-panel-address");
      if (addressEl) addressEl.textContent = t("address_unknown");
    });

  ctx.locationPanel.querySelector("#location-panel-address-btn").addEventListener("click", () => {
    ctx.openAddressSearchSheet((result) => {
      const newLatLng = L.latLng(result.lat, result.lng);
      ctx.map.panTo(newLatLng);
      ctx.placeLocationPin(newLatLng, { source: "geocoded_address", onConfirm });
    });
  });
  ctx.locationPanel.querySelector("#location-panel-confirm-btn").addEventListener("click", () => {
    const finalLatLng = ctx.placingMarker ? ctx.placingMarker.getLatLng() : latlng;
    ctx.closeLocationPanel();
    onConfirm(finalLatLng);
  });
}

export function showLocationErrorPanel(ctx, onRetry, onEnterAddress) {
  ctx.renderLocationPanelShell(`
    <h2>${t("location_failed_title")}</h2>
    <div class="location-picker-actions">
      <button type="button" class="btn" id="location-panel-error-address">${t("enter_address")}</button>
      <button type="button" class="btn btn-primary" id="location-panel-error-retry">${t("try_again")}</button>
    </div>
  `);
  ctx.locationPanel.querySelector("#location-panel-error-retry").addEventListener("click", onRetry);
  ctx.locationPanel.querySelector("#location-panel-error-address").addEventListener("click", onEnterAddress);
}

// Debounced address search -- only geocodes on an explicit result tap,
// never per keystroke, so typing never jumps the map or burns API calls
// on every character.
export function openAddressSearchSheet(ctx, onSelect) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("search_address_title")}</h2>
      <label class="visually-hidden" for="address-search-input">${t("search_address_placeholder")}</label>
      <input type="search" id="address-search-input" placeholder="${t("search_address_placeholder")}" />
      <div class="address-search-results" id="address-search-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const input = overlay.querySelector("#address-search-input");
  installInlineClearButton(input);
  const resultsEl = overlay.querySelector("#address-search-results");
  let searchTimer;
  let searchToken = 0;

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) {
      resultsEl.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(async () => {
      const myToken = ++searchToken;
      resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      let results;
      try {
        results = await api.searchAddress(q);
      } catch (err) {
        if (myToken !== searchToken) return;
        resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      if (myToken !== searchToken) return; // a newer query already superseded this one
      if (!results.length) {
        resultsEl.innerHTML = `<p class="empty-state">${t("no_address_results")}</p>`;
        return;
      }
      resultsEl.innerHTML = results
        .map((r, i) => `<button type="button" class="address-search-result" data-index="${i}">${escapeHtml(r.address)}</button>`)
        .join("");
      resultsEl.querySelectorAll("[data-index]").forEach((btn) => {
        btn.addEventListener("click", () => {
          overlay.remove();
          onSelect(results[Number(btn.dataset.index)]);
        });
      });
    }, 400);
  });

  // Focused synchronously, not via requestAnimationFrame -- mobile
  // browsers (iOS Safari especially) only reliably raise the on-screen
  // keyboard for a focus() call that happens within the same tick as the
  // triggering tap/click; deferring it a frame (as this used to, and as
  // activateDialog's own auto-focus below still does) silently focuses
  // the input without the keyboard actually opening.
  input.focus();
}

export function startAddCustomerFlow(ctx) {
  ctx.renderLocationPanelShell(`<p class="location-picker-address">${escapeHtml(t("locating_you"))}</p>`);
  getCurrentPosition({ timeout: 8000 })
    .then((pos) => {
      const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
      ctx.map.setView(latlng, Math.max(ctx.map.getZoom(), 16));
      ctx.placeLocationPin(latlng, {
        source: "gps",
        accuracy: pos.coords.accuracy,
        onConfirm: ctx.handoffToCustomerForm,
      });
    })
    .catch(() => {
      ctx.showLocationErrorPanel(
        () => ctx.startAddCustomerFlow(),
        () => {
          ctx.openAddressSearchSheet((result) => {
            const latlng = L.latLng(result.lat, result.lng);
            ctx.map.setView(latlng, 16);
            ctx.placeLocationPin(latlng, {
              source: "geocoded_address",
              onConfirm: ctx.handoffToCustomerForm,
            });
          });
        }
      );
    });
}

// Final "save this?" step for an existing customer once a location has
// already been confirmed via the shared picker above -- kept separate
// from openNewCustomerForm because relocating writes immediately (or
// files an edit request) instead of opening the full customer-details
// form again.
export function openRelocateConfirmDetails(ctx, latlng) {
  ctx.closeLocationPanel();
  // A pin correction is applied at once for the rep's own customers and for management (server:
  // editRequests.js canAutoApprovePin); only someone else's customer still waits for approval.
  const pinAppliesAtOnce = canEditDirectly() || movesAnyPinAtOnce(state.user?.role) || state.user?.role === "sales_manager";
  ctx.placingMarker?.dragging?.disable();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("confirm_new_location")}</h2>
      <p class="muted">${pinAppliesAtOnce ? t("confirm_new_location_hint") : t("confirm_new_location_hint_request")}</p>
      <p class="form-error" id="relocate-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="cancel-relocate-confirm">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="save-relocate">${pinAppliesAtOnce ? t("save") : t("submit_request")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  // Cancelling this step doesn't abandon the whole picker -- it goes back
  // to the draggable-pin confirm panel so the rep can still adjust or
  // re-search before deciding again, rather than dead-ending with a
  // frozen pin and no visible way to continue.
  function backToPicker() {
    overlay.remove();
    ctx.placingMarker?.dragging?.enable();
    ctx.showLocationPanel(latlng, { source: "existing_customer", onConfirm: ctx.openRelocateConfirmDetails });
  }
  overlay.querySelector("#cancel-relocate-confirm").addEventListener("click", backToPicker);
  overlay.addEventListener("click", (e) => e.target === overlay && backToPicker());

  overlay.querySelector("#save-relocate").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    const errorEl = overlay.querySelector("#relocate-error");
    const changes = { lat: latlng.lat, lng: latlng.lng };
    try {
      if (canEditDirectly()) {
        await api.updateCustomer(ctx.relocateCustomerId, changes);
      } else {
        await api.createEditRequest(ctx.relocateCustomerId, changes);
      }
      overlay.remove();
      // Replace (not push) the flow's history entry: Back from the customer card must not reopen "change location".
      (ctx.navigate.replace ?? ctx.navigate)(`#/customers/${ctx.relocateCustomerId}`);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}

export function openNewCustomerForm(ctx, latlng) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("new_customer")}</h2>
      <form id="new-customer-form">
        ${tierSelectorHtml("potential")}
        ${categorySelectorHtml(CATEGORY_LIST[0].value)}
        <label>${t("new_customer_name")}<input name="name" required /></label>
        <label>${t("phone")}<input name="phone" type="tel" value="+374 " /></label>
        <label>${t("address")}<input name="address" id="new-customer-address" /></label>
        <div class="form-row-2">
          <label>${t("region")}
            <select name="region" id="new-customer-region">
              <option value="">${t("select_placeholder")}</option>
              ${REGION_LIST.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(regionLabelHy(r))}</option>`).join("")}
            </select>
          </label>
          <label id="new-customer-subregion-wrap">${t("subregion")}<input name="subregion" id="new-customer-subregion" /></label>
        </div>
        <div class="form-row-2">
          <label>${t("sales_channel")}
            <select name="sales_channel" id="new-customer-channel">
              <option value="">${t("select_placeholder")}</option>
              ${SALES_CHANNELS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
            </select>
          </label>
          <label id="new-customer-manager-wrap" ${canReassignCustomers() ? "" : "hidden"}>${t("assigned_manager")}
            <select name="assigned_manager_id" id="new-customer-manager">
              <option value="">${t("unassigned")}</option>
            </select>
          </label>
        </div>
        <div class="form-row-2">
          <label class="erp-suggest-wrap" id="new-customer-erp-label">${t("erp_customer_id")} <b class="req-mark" id="new-customer-erp-req" hidden>*</b>
            <input type="text" name="erp_customer_id" id="new-customer-erp-input" autocomplete="off" />
            <div class="erp-suggest-list" id="new-customer-erp-suggest" hidden></div>
          </label>
          <label>${t("tin")}<input name="tin" /></label>
        </div>
        <label>${t("notes")}<textarea name="notes" rows="2"></textarea></label>
        <p class="form-error" id="new-customer-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-new-customer">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save_customer")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  // The potential level is NOT asked here (owner, 2026-10-25): adding a customer must stay as fast as possible; it is filled in at the visit
  // (the check-in screen and the customer card ask for it).
  // Bronze / Silver / Gold customers exist in Excel: their ERP customer ID is mandatory (owner, 2026-10-24).
  const needsErpId = (tier) => ["bronze", "silver", "gold"].includes(tier);
  activateTierSelector(overlay, (tier) => {
    overlay.querySelector("#new-customer-erp-req").hidden = !needsErpId(tier);
    overlay.querySelector("#new-customer-erp-label").classList.remove("field-invalid");
    // the next thing a Bronze / Silver / Gold customer needs is its ERP ID: bring the field into view if it is below the fold
    if (needsErpId(tier)) overlay.querySelector("#new-customer-erp-input")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  activateCategorySelector(overlay, () => refreshNameSuggestion());

  // Keep the dropped pin visible above the sheet -- measured against the
  // sheet's actual rendered height (it varies with content/keyboard),
  // not a guessed fraction of the screen, so the pin reliably stays clear
  // of the sheet's top edge instead of being hidden behind it.
  const sheetEl = overlay.querySelector(".sheet");
  const point = ctx.map.latLngToContainerPoint(latlng);
  const sheetTop = ctx.mapEl.clientHeight - sheetEl.getBoundingClientRect().height - 40;
  if (point.y > sheetTop) {
    ctx.map.panBy([0, point.y - sheetTop], { animate: true });
  }

  function close() {
    overlay.remove();
    if (ctx.placingMarker) {
      ctx.map.removeLayer(ctx.placingMarker);
      ctx.placingMarker = null;
    }
    ctx.syncAddHint();
    // Cancelled from the details form: the add flow is over (see cancelLocationPicker).
    if (ctx.startInAddMode) {
      ctx.startInAddMode = false;
      ctx.navigate.rewrite?.("#/map");
    }
  }

  overlay.querySelector("#cancel-new-customer").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  // The dropped pin itself doubles as a cancel target -- tapping it (its
  // X glyph makes that discoverable) closes the sheet the same as the
  // Cancel button.
  ctx.placingMarker?.on("click", close);

  // Auto-fill address/region/subregion from the dropped pin's coordinates
  // -- the rep can still correct any of these by hand, this just saves
  // typing/picking from scratch. Region/subregion are best-effort matches
  // against the fixed lists (see matchRegion/matchSubregion in util.js),
  // never silently trusted as exact.
  const addressInput = overlay.querySelector("#new-customer-address");
  const nameInput = overlay.querySelector('input[name="name"]');
  const regionSelect = overlay.querySelector("#new-customer-region");
  const subregionWrap = overlay.querySelector("#new-customer-subregion-wrap");

  // Suggest a default name "{subregion} / {type word}{number}" -- e.g. "Ajapnyak / Yuxman ket1", "Ajapnyak /
  // Avtopahestamaser2" -- once a subregion is known. The number is the next free one among the customers already
  // named that way (server: GET /customers/name-suggestion), so same-type customers of one subregion can be told
  // apart. Only a name the rep has not typed themselves is (re)filled: empty, or still equal to our last
  // suggestion (so changing the type or the subregion updates it); manual entry is never clobbered (same "fill,
  // don't lock" pattern as address/region/subregion/channel/manager below). Customer names are always Latin
  // script: inside Yerevan, subregionField.value is already English (matched against the fixed YEREVAN_DISTRICTS
  // list -- see matchSubregion in util.js). Outside Yerevan there's no fixed list, so that same field starts
  // pre-filled with the geocoder's own raw guess, which is in Armenian (accept-language=hy) -- using it here would
  // leak Armenian text into the name. The selected region code itself is always English (REGION_LIST), and for a
  // non-Yerevan customer the "subregion" is usually just that region's own city anyway (per matchSubregion's
  // comment), so it stands in as the English default.
  let lastSuggestedName = "";
  let nameSeq = 0;
  function refreshNameSuggestion() {
    if (nameInput.value && nameInput.value !== lastSuggestedName) return;
    const region = regionSelect.value;
    if (!region) return;
    const location =
      region === "Yerevan" ? overlay.querySelector("#new-customer-subregion")?.value || "" : region;
    if (!location) return;
    const category = overlay.querySelector('input[name="category"]')?.value;
    const word = CATEGORY_LIST.find((c) => c.value === category)?.nameWord || CATEGORY_LIST[0].nameWord;
    const base = `${location} / ${word}`;
    const mine = ++nameSeq;
    const apply = (name) => {
      // a newer request, or the rep typing in the meantime, wins
      if (mine !== nameSeq || (nameInput.value && nameInput.value !== lastSuggestedName)) return;
      nameInput.value = name;
      lastSuggestedName = name;
    };
    api
      .suggestCustomerNameNumber(base)
      .then((r) => apply(`${base}${r?.next ?? ""}`))
      .catch(() => apply(base));
  }

  function renderSubregionField(region, guess) {
    if (region === "Yerevan") {
      subregionWrap.innerHTML = `${t("subregion")}
        <select name="subregion" id="new-customer-subregion">
          <option value="">${t("select_placeholder")}</option>
          ${YEREVAN_DISTRICTS.map(
            (d) => `<option value="${escapeHtml(d)}" ${d === guess ? "selected" : ""}>${escapeHtml(subregionLabelHy(d))}</option>`
          ).join("")}
        </select>`;
    } else {
      subregionWrap.innerHTML = `${t("subregion")}<input name="subregion" id="new-customer-subregion" value="${escapeHtml(guess || "")}" />`;
      wirePlaceInput(subregionWrap.querySelector("#new-customer-subregion"), () => regionSelect.value);
    }
  }
  wirePlaceInput(overlay.querySelector("#new-customer-subregion"), () => regionSelect.value);
  const channelSelect = overlay.querySelector("#new-customer-channel");
  // A sales manager never picks the channel: it is preset from their position and the field is hidden (the server sets it from
  // the rep anyway, as the authority). Was fieldVisitEnhancements.js, step 7b.
  if (state.user?.role === "sales_manager") {
    const guessed = managerChannelGuess();
    if (guessed) {
      if (![...channelSelect.options].some((o) => o.value === guessed)) channelSelect.add(new Option(guessed, guessed));
      channelSelect.value = guessed;
    }
    const channelLabel = channelSelect.closest("label");
    if (channelLabel) channelLabel.hidden = true;
  }
  const managerSelect = overlay.querySelector("#new-customer-manager");
  let managerOptionsHtml = `<option value="">${t("unassigned")}</option>`;
  api
    .listPlannableUsers()
    .then((users) => {
      managerOptionsHtml =
        `<option value="">${t("unassigned")}</option>` +
        users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
      managerSelect.innerHTML = managerOptionsHtml;
    })
    .catch(() => {});

  // Routes Distribution suggestion -- a convenience default, never a lock:
  // it only fills in values, the rep can still change either dropdown
  // before saving. Re-runs whenever region/subregion changes so picking a
  // different area updates the suggestion instead of leaving a stale one.
  // CVO/PCO/OEM channels are deliberately excluded -- those customer types
  // don't follow the geographic route-distribution mapping, so the rep
  // picks the channel (and therefore manager) themselves instead of
  // getting an auto-filled guess.
  const NO_AUTOFILL_CHANNELS = new Set(["CVO", "PCO", "OEM"]);
  function refreshRouteSuggestion() {
    const region = regionSelect.value;
    if (!region) return;
    const subregionField = overlay.querySelector("#new-customer-subregion");
    const subregion = subregionField?.value || "";
    api
      .lookupRouteDistribution(region, subregion)
      .then((match) => {
        if (!match) return;
        if (match.sales_channel && NO_AUTOFILL_CHANNELS.has(match.sales_channel)) return;
        if (match.sales_channel && !channelSelect.value) channelSelect.value = match.sales_channel;
        if (match.assigned_manager_id && !managerSelect.value) {
          managerSelect.innerHTML = managerOptionsHtml;
          managerSelect.value = String(match.assigned_manager_id);
        }
      })
      .catch(() => {});
  }
  regionSelect.addEventListener("change", () => {
    renderSubregionField(regionSelect.value, "");
    refreshRouteSuggestion();
    refreshNameSuggestion();
  });
  overlay.addEventListener("change", (e) => {
    if (e.target.id === "new-customer-subregion") {
      refreshRouteSuggestion();
      refreshNameSuggestion();
    }
  });

  api
    .reverseGeocode(latlng.lat, latlng.lng)
    .then((result) => {
      if (result?.address && !addressInput.value) addressInput.value = result.address;
      const guessedRegion = matchRegion(result?.region);
      if (guessedRegion) {
        regionSelect.value = guessedRegion;
        renderSubregionField(guessedRegion, matchSubregion(result?.subregion, guessedRegion));
        refreshRouteSuggestion();
        refreshNameSuggestion();
      }
    })
    .catch(() => {});

  const erpInput = overlay.querySelector("#new-customer-erp-input");
  const erpSuggestList = overlay.querySelector("#new-customer-erp-suggest");
  let erpOptions = [];
  api
    .getUnlinkedErpCustomers()
    .then((results) => {
      erpOptions = [...results].sort((a, b) =>
        (a.customer_name || "").localeCompare(b.customer_name || "", undefined, { sensitivity: "base" })
      );
    })
    .catch(() => {});

  function renderErpSuggestions(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? erpOptions.filter(
          (r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q)
        )
      : erpOptions;
    if (!matches.length) {
      erpSuggestList.hidden = true;
      erpSuggestList.innerHTML = "";
      return;
    }
    erpSuggestList.innerHTML = matches
      .slice(0, 30)
      .map(
        (r) => `
      <div class="erp-suggest-item" data-id="${escapeHtml(r.erp_customer_id)}">
        <span>${escapeHtml(r.customer_name || r.erp_customer_id)}</span>
        ${r.debt_amd > 0 ? `<span class="muted">${formatAmd(r.debt_amd)}</span>` : ""}
      </div>`
      )
      .join("");
    erpSuggestList.hidden = false;
  }

  erpInput.addEventListener("focus", () => renderErpSuggestions(erpInput.value));
  erpInput.addEventListener("input", () => {
    renderErpSuggestions(erpInput.value);
    maybeAutoUpgradeTier();
  });
  erpInput.addEventListener("blur", () => {
    setTimeout(() => (erpSuggestList.hidden = true), 150);
  });
  activateCombobox(erpInput, erpSuggestList, (item) => {
    erpInput.value = item.dataset.id;
    maybeAutoUpgradeTier();
  });

  // Linking an ERP customer ID means this is no longer just a "Potential"
  // lead -- bump it to Bronze automatically the moment an ID is entered,
  // same as the PATCH-side auto-upgrade for existing customers. Only
  // fires while the selector is still on its default "potential": once
  // the rep has picked Silver/Gold (or Bronze already) by hand, their
  // choice always wins and this never overrides it.
  erpInput.addEventListener("input", () => overlay.querySelector("#new-customer-erp-label").classList.remove("field-invalid"));
  function maybeAutoUpgradeTier() {
    const tierHiddenInput = overlay.querySelector('.tier-selector input[type=hidden]');
    if (erpInput.value.trim() && tierHiddenInput?.value === "potential") {
      setTierSelectorValue(overlay, "bronze");
    }
  }

  const form = overlay.querySelector("#new-customer-form");
  const errorEl = overlay.querySelector("#new-customer-error");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitNewCustomer(false);
  });

  async function submitNewCustomer(confirmDuplicate) {
    const data = new FormData(form);
    if (needsErpId(data.get("customer_tier")) && !String(data.get("erp_customer_id") ?? "").trim()) {
      errorEl.textContent = t("erp_id_required");
      errorEl.hidden = false;
      overlay.querySelector("#new-customer-erp-label").classList.add("field-invalid");
      erpInput.scrollIntoView({ block: "center", behavior: "smooth" });
      erpInput.focus();
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("saving");
    form.setAttribute("aria-busy", "true");

    try {
      const phoneDigits = normalizePhone(data.get("phone"));
      const created = await api.createCustomer({
        name: data.get("name"),
        category: data.get("category") || null,
        phone: phoneDigits.length > 3 ? `+${phoneDigits}` : null,
        address: data.get("address") || null,
        notes: data.get("notes") || null,
        tin: data.get("tin") || null,
        erp_customer_id: data.get("erp_customer_id") || null,
        customer_tier: data.get("customer_tier") || null,
        region: data.get("region") || null,
        subregion: data.get("subregion") || null,
        sales_channel: data.get("sales_channel") || null,
        assigned_manager_id: data.get("assigned_manager_id") ? Number(data.get("assigned_manager_id")) : null,
        lat: latlng.lat,
        lng: latlng.lng,
        confirm_duplicate: confirmDuplicate || undefined,
      });
      overlay.remove();
      const placeText = placeNoticeText(created?.place_notice);
      if (placeText) showToast(placeText, { ms: 6500 });
      if (ctx.placingMarker) {
        ctx.map.removeLayer(ctx.placingMarker);
        ctx.placingMarker = null;
      }
      // Land on the customer just created instead of applyFilter's
      // fitBounds-to-everyone zoom-out -- startInAddMode staying true for
      // the rest of this map session is exactly what makes that guard
      // (see applyFilter above) keep re-fitting on every subsequent
      // reload, so clear it here once the add flow is actually done, then
      // focus the new pin the same way the #/map?customer=<id> deep link
      // does (see focusOnCustomerMarker).
      ctx.startInAddMode = false;
      ctx.syncAddHint();
      // The saved customer is now the screen's subject: make the address say so. Left as "#/map?add=1" it made Back
      // (from the customer's card) reopen "tap the map to place a pin".
      if (created?.id != null) ctx.navigate.rewrite?.(`#/map?customer=${created.id}`);
      // Also pre-empt applyFilter's own "first settle" geolocation-recenter
      // path (see above) -- without this, loadCustomers() below can kick
      // off an async getCurrentPosition() that resolves after our
      // focusOnCustomerMarker call and yanks the view back to the user's
      // own location instead of the customer just created.
      ctx.initialViewApplied = true;
      await ctx.loadCustomers();
      if (created?.id != null) ctx.focusOnCustomerMarker(created.id);
    } catch (err) {
      // Same "duplicate_warning" convention payments.js's own duplicate
      // check uses -- offer to proceed anyway (a name/location match
      // this close is usually the same shop re-entered, but a genuine
      // coincidence should still be a one-tap override, not a hard
      // block) instead of surfacing it as a plain validation error.
      if (err.status === 409 && err.body?.error === "duplicate_warning") {
        if (confirm(`${err.body.message}\n\n${t("add_anyway")}`)) {
          await submitNewCustomer(true);
          return;
        }
        submitBtn.disabled = false;
        submitBtn.textContent = t("save_customer");
        form.removeAttribute("aria-busy");
        return;
      }
      errorEl.textContent = err.body?.code === "erp_id_assigned" ? t("erp_id_assigned").replace("{name}", err.body.assigned_manager_name) : err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = t("save_customer");
      form.removeAttribute("aria-busy");
    }
  }
}

// The channel a sales manager works in, read from their position (or name).
function managerChannelGuess() {
  const source = `${state.user?.position || ""} ${state.user?.name || ""}`.toLowerCase();
  if (source.includes("davtashen") || source.includes("դավթաշեն")) return "SM Davtashen";
  if (source.includes("shirak") || source.includes("gyumri") || source.includes("շիրակ") || source.includes("գյումրի")) return "SM Shirak";
  if (source.includes("b2b")) return "SM B2B";
  if (source.includes("sm cas") || source.includes("sales manager cas")) return "SM CAS";
  if (source.includes("yvn") || source.includes("yerevan") || source.includes("երևան")) return "SM YVN";
  return "";
}
