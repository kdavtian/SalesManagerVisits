import { api } from "../api.js";
import { renderPotentialCard } from "../potential.js";
import { escapeHtml, formatDateDMY, getCurrentPosition, locationErrorHint, compressImage, rotateImageBlob, formatDistance, haversineMeters, creditedDistanceMeters, activateDialog } from "../util.js";
import { enqueueCheckin } from "../offlineQueue.js";
import { openSyncQueueSheet } from "../syncQueueSheet.js";
import { openOrderMenu } from "../orderMenu.js";
import { t, getLang } from "../i18n.js";
import { icons } from "../icons.js";
import { state } from "../state.js";
import { openPhotoLightbox } from "../photoLightbox.js";
import { openOrderTaskSheet } from "../orderTaskSheet.js";
import { loadReorderProfile, usualOrderHash } from "../reorder.js";
import { COMPETITORS } from "../brandChips.js";

// Order Placed, Revisit, Payment Collected, Assortment check, Products delivered, Other (owner, 2026-10-26: "No order" and
// "Complaint" were removed and their old records merged into Other). "customer_unavailable" is the stored value of "Products delivered".
const CAMERA_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
  <circle cx="12" cy="13" r="3.5"/>
</svg>`;

const OUTCOME_OPTIONS = [
  { value: "order_placed", labelKey: "outcome_order_placed", icon: icons.cart },
  { value: "follow_up_required", labelKey: "outcome_follow_up_required", icon: icons.clock },
  { value: "payment_collected", labelKey: "outcome_payment_collected", icon: icons.payment },
  { value: "assortment_check", labelKey: "outcome_assortment_check", icon: icons.clipboardCheck },
  { value: "customer_unavailable", labelKey: "outcome_customer_unavailable", icon: icons.truck },
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
    options: COMPETITORS.map((v) => ({
      value: v,
      labelKey: `competitor_${v}`,
    })),
  },
];

// The two cards of "Products found at this location": one "KAD products" card (Castrol, Lotos and Royal in one sheet) and Competitors.
const BRAND_CARDS = [
  { key: "kad", labelKey: "brand_group_kad", groups: ["castrol", "lotos", "royal"] },
  { key: "competitors", labelKey: "brand_group_competitors", groups: ["competitors"] },
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
  // Admin can switch the Check-in allowance off in Settings: then nobody is blocked for distance.
  const allowanceOn = settings.checkin_allowance_enabled !== false;

  container.innerHTML = `
    <div class="checkin-head">
      <h1>${escapeHtml(customer.name)}</h1>
      <button type="button" class="icon-btn" id="checkin-close-btn" aria-label="${t("close")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
    <div id="checkin-tasks"></div>
    <div id="checkin-potential"></div>
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

      <label id="amount-collected-field" hidden>
        ${t("amount_collected_amd")}
        <input type="number" name="amount_collected_amd" id="amount-collected-input" min="1" step="any" inputmode="numeric" placeholder="${t("amount_collected_placeholder")}" />
        <p class="form-error" id="amount-collected-error" hidden>${t("amount_collected_required")}</p>
      </label>

      <div id="delivered-orders-field" class="delivered-orders-field" hidden>
        <span class="delivered-orders-title">${t("delivered_orders_title")}</span>
        <div id="delivered-orders-list" class="delivered-orders-list"></div>
        <!-- The signed order blank: a photo is required (owner, 2026-10-26); the Electronic signature button joins it later. -->
        <div class="blank-photo-block">
          <span class="delivered-orders-title">${t("delivered_blank_title")}</span>
          <div class="photo-thumb-grid" id="blank-thumb-grid"></div>
          <input type="file" id="blank-photo-input" accept="image/*" capture="environment" class="visually-hidden" />
          <button type="button" class="camera-btn" id="blank-photo-btn">${CAMERA_ICON}<span id="blank-photo-label">${t("take_photo")}</span></button>
          <p class="form-error" id="blank-photo-error" hidden>${t("delivered_blank_required")}</p>
        </div>
      </div>

      <label id="available-products-field" hidden>
        ${t("available_products_label")}
        <button type="button" class="btn btn-block" id="available-products-btn">${t("select_available_products")}</button>
      </label>

      <label class="brands-label">
        ${t("products_found")}
        <div class="brand-group-grid" id="brand-group-grid">
          ${BRAND_CARDS.map(
            (c) => `
            <button type="button" class="brand-group-btn" data-brand-card="${c.key}">${t(c.labelKey)}</button>
          `
          ).join("")}
        </div>
      </label>

      <label id="note-field">
        <span id="note-label">${t("note_optional")}</span>
        <textarea name="note" rows="3" placeholder="${t("note_placeholder")}"></textarea>
        <p class="form-error" id="note-error" hidden>${t("note_required_for_other")}</p>
      </label>

      <div class="camera-field">
        <input type="file" name="photo" accept="image/*" capture="environment" id="photo-input" class="visually-hidden" />
        <div class="photo-thumb-grid" id="photo-thumb-grid"></div>
        <button type="button" class="camera-btn" id="camera-btn" aria-label="${t("take_photo")}">
          ${CAMERA_ICON}
          <span id="camera-btn-label">${t("take_photo")}</span>
        </button>
        <label class="high-res-photo-toggle">
          <input type="checkbox" id="high-res-photo-toggle" />
          <span class="high-res-photo-label">${t("high_res_photo")}</span>
        </label>
      </div>

      <p class="form-error" id="checkin-error" hidden></p>
      <button type="submit" class="btn btn-primary btn-block" id="checkin-submit" disabled>
        ${t("locating")}
      </button>
    </form>
    <div id="checkin-result" hidden></div>
  `;
  // A potential customer's level is asked at the visit, not when the customer is added (owner, 2026-10-25).
  const potentialSlot = container.querySelector("#checkin-potential");
  const paintPotential = () =>
    renderPotentialCard(potentialSlot, customer, {
      reload: async () => {
        customer = await api.getCustomer(customerId);
        paintPotential();
      },
    });
  paintPotential();
  container.querySelector("#checkin-close-btn").addEventListener("click", () => navigate.goBack(`#/customers/${customerId}`));

  // Open "make an order" tasks of this rep at this customer (filled by showCustomerTasks below);
  // submitting a check-in without an order shows them as a bottom sheet first.
  let openOrderTasks = [];
  let orderTaskAnswered = false;
  let skippedOrderTasks = null;

  // What management asked for at this customer (open tasks): shown above the
  // form so the visit covers them; tap one to tick its checklist off.
  (async function showCustomerTasks() {
    const slot = container.querySelector("#checkin-tasks");
    if (!slot) return;
    try {
      const tasksModule = await import("./tasks.js");
      const load = async () => {
        const { rows, today } = await tasksModule.loadCustomerTasks(customerId);
        const mine = rows.filter((r) => r.assignee_id === state.user.id || r.creator_id === state.user.id);
        openOrderTasks = mine.filter((r) => r.auto_kind === "reorder_followup" && r.assignee_id === state.user.id);
        slot.innerHTML = mine.length
          ? `<h2 class="section-title section-title-tight">${t("tasks_customer_title")}</h2><div class="card-list">${mine.map((r) => tasksModule.taskCardHtml(r, today, { showCustomer: false })).join("")}</div>`
          : "";
        slot.querySelectorAll("[data-task-id]").forEach((el) =>
          el.addEventListener("click", () => tasksModule.openTaskSheet(Number(el.dataset.taskId), { onChanged: load, navigate }))
        );
      };
      await load();
    } catch {
      /* optional card */
    }
  })();

  const gpsStatus = container.querySelector("#gps-status");
  const verifyBanner = container.querySelector("#verify-banner");
  const submitBtn = container.querySelector("#checkin-submit");
  const form = container.querySelector("#checkin-form");
  const errorEl = container.querySelector("#checkin-error");
  const resultEl = container.querySelector("#checkin-result");
  const photoInput = container.querySelector("#photo-input");
  const cameraBtn = container.querySelector("#camera-btn");
  const cameraBtnLabel = container.querySelector("#camera-btn-label");
  const photoThumbGrid = container.querySelector("#photo-thumb-grid");
  const highResToggle = container.querySelector("#high-res-photo-toggle");
  const outcomeError = container.querySelector("#outcome-error");
  const noteLabel = container.querySelector("#note-label");
  const noteError = container.querySelector("#note-error");
  const noteInput = container.querySelector('textarea[name="note"]');
  // "Other" must be explained: the note stops being optional while Other is ticked (the office check-in has nothing to explain).
  const noteRequired = () => container.querySelector('input[name="outcomes"][value="other"]').checked && !customer.checkin_for_all;
  function syncNoteRequirement() {
    const required = noteRequired();
    noteLabel.textContent = required ? t("note_required") : t("note_optional");
    if (!required) noteError.hidden = true;
  }
  noteInput.addEventListener("input", () => {
    noteError.hidden = true;
  });
  // With "Order placed" ticked the button says what will happen next: confirm the check-in AND open the order menu.
  const submitLabel = () => (container.querySelector('input[name="outcomes"][value="order_placed"]')?.checked ? t("submit_checkin_and_order") : t("submit_checkin"));

  let position = null;
  let photos = [];
  const MAX_PHOTOS = 5;
  const brandStatus = Object.fromEntries(BRAND_GROUPS.map((g) => [g.key, []]));

  // Which of this customer's own previously-ordered products the rep found
  // in stock right now -- distinct from brandStatus above (that's the
  // general market landscape; this is specific to what this shop has
  // actually bought from us before). Fetched lazily the first time the
  // picker opens, since most check-ins never touch this outcome.
  let orderedProducts = null;
  let selectedAvailableProducts = new Set();

  const availableProductsField = container.querySelector("#available-products-field");
  const availableProductsBtn = container.querySelector("#available-products-btn");

  function syncAvailableProductsVisibility() {
    const checked = container.querySelector('input[name="outcomes"][value="assortment_check"]').checked;
    availableProductsField.hidden = !checked;
  }

  function paintAvailableProductsBtn() {
    availableProductsBtn.textContent = selectedAvailableProducts.size
      ? `${t("select_available_products")} (${selectedAvailableProducts.size})`
      : t("select_available_products");
  }

  async function openAvailableProductsSheet() {
    if (!orderedProducts) {
      availableProductsBtn.disabled = true;
      availableProductsBtn.textContent = t("loading");
      try {
        orderedProducts = await api.customerOrderedProducts(customerId);
      } catch {
        orderedProducts = [];
      }
      availableProductsBtn.disabled = false;
      paintAvailableProductsBtn();
    }

    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
        <h2>${t("select_available_products")}</h2>
        ${
          orderedProducts.length
            ? `<div class="brand-grid">
                ${orderedProducts
                  .map((p, i) => {
                    const label = p.brand ? `${p.brand} — ${p.product_name}` : p.product_name;
                    return `
                <label class="brand-chip">
                  <input type="checkbox" data-index="${i}" ${selectedAvailableProducts.has(label) ? "checked" : ""} />
                  <span>${escapeHtml(label)}</span>
                </label>`;
                  })
                  .join("")}
              </div>`
            : `<p class="empty-state">${t("no_ordered_products_found")}</p>`
        }
        <div class="sheet-actions">
          <button type="button" class="btn btn-primary btn-block" id="available-products-done">${t("done")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const apply = () => {
      selectedAvailableProducts = new Set(
        [...overlay.querySelectorAll("input[type=\"checkbox\"]:checked")].map((input) => {
          const p = orderedProducts[Number(input.dataset.index)];
          return p.brand ? `${p.brand} — ${p.product_name}` : p.product_name;
        })
      );
      paintAvailableProductsBtn();
      overlay.remove();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && apply());
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", apply);
    overlay.querySelector("#available-products-done").addEventListener("click", apply);
  }

  availableProductsBtn.addEventListener("click", openAvailableProductsSheet);

  const cardGroupsHaveValues = (card) => card.groups.some((key) => brandStatus[key].length > 0);
  function paintBrandGroupButtons() {
    container.querySelectorAll("[data-brand-card]").forEach((btn) => {
      const card = BRAND_CARDS.find((c) => c.key === btn.dataset.brandCard);
      const count = card.groups.reduce((n, key) => n + brandStatus[key].length, 0);
      btn.classList.toggle("brand-group-btn-active", cardGroupsHaveValues(card));
      btn.textContent = count ? `${t(card.labelKey)} (${count})` : t(card.labelKey);
    });
  }

  // One bottom sheet per card. "KAD products" shows two columns: Castrol on the left, Lotos with Royal under it on the right
  // (owner, 2026-10-26); Competitors is one list.
  function openBrandSheet(card) {
    const groups = card.groups.map((key) => BRAND_GROUPS.find((g) => g.key === key));
    const selected = Object.fromEntries(groups.map((g) => [g.key, new Set(brandStatus[g.key])]));
    const sectionHtml = (g) => `
      <section class="brand-sheet-section" data-sheet-group="${g.key}">
        ${card.groups.length > 1 ? `<h3 class="brand-sheet-heading">${escapeHtml(t(g.labelKey))}</h3>` : ""}
        <div class="brand-grid">
          ${g.options
            .map(
              (o) => `
            <label class="brand-chip">
              <input type="checkbox" value="${o.value}" ${selected[g.key].has(o.value) ? "checked" : ""} />
              <span>${escapeHtml(t(o.labelKey))}</span>
            </label>
          `
            )
            .join("")}
        </div>
      </section>`;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet brand-sheet brand-sheet-${card.key}">
        <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
        <h2>${escapeHtml(t(card.labelKey))}</h2>
        ${
          card.key === "kad"
            ? `<div class="brand-sheet-columns">
                <div class="brand-sheet-col">${sectionHtml(groups[0])}</div>
                <div class="brand-sheet-col">${sectionHtml(groups[1])}${sectionHtml(groups[2])}</div>
              </div>`
            : groups.map(sectionHtml).join("")
        }
        <div class="sheet-actions">
          <button type="button" class="btn btn-primary btn-block" id="brand-sheet-done">${t("done")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    // Every way out (Close button, X, a tap beside the sheet) keeps what was ticked: nothing the rep selected is lost by closing.
    const apply = () => {
      overlay.querySelectorAll("[data-sheet-group]").forEach((section) => {
        brandStatus[section.dataset.sheetGroup] = [...section.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
      });
      paintBrandGroupButtons();
      overlay.remove();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && apply());
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", apply);

    // "Available" and "Not available" are contradictory -- picking one clears
    // the other. "Full range" implies "Available": ticking it ticks Available
    // and locks Not available until Full range is unticked. Every other tag
    // stays freely combinable. Each section (Castrol, Lotos, Royal) follows this on its own.
    function syncExclusive(section, changed) {
      const box = (value) => section.querySelector(`input[value="${value}"]`);
      const available = box("available");
      const unavailable = box("unavailable");
      const full = box("full_range");
      if (!available || !unavailable) return;
      if (changed === "unavailable" && unavailable.checked) {
        available.checked = false;
        if (full) full.checked = false;
      } else if (changed === "available" && available.checked) {
        unavailable.checked = false;
      }
      if (full?.checked) {
        available.checked = true;
        unavailable.checked = false;
      }
      unavailable.disabled = Boolean(full?.checked);
      unavailable.closest("label")?.classList.toggle("is-disabled", unavailable.disabled);
    }
    overlay.querySelectorAll("[data-sheet-group]").forEach((section) => {
      section.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.addEventListener("change", () => syncExclusive(section, input.value));
      });
      syncExclusive(section);
    });

    overlay.querySelector("#brand-sheet-done").addEventListener("click", apply);
  }

  container.querySelectorAll("[data-brand-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = BRAND_CARDS.find((c) => c.key === btn.dataset.brandCard);
      if (card) openBrandSheet(card);
    });
  });

  const amountField = container.querySelector("#amount-collected-field");
  const amountInput = container.querySelector("#amount-collected-input");
  const amountError = container.querySelector("#amount-collected-error");

  function syncAmountFieldVisibility() {
    const collected = container.querySelector('input[name="outcomes"][value="payment_collected"]').checked;
    amountField.hidden = !collected;
    if (!collected) {
      amountInput.value = "";
      amountError.hidden = true;
    }
  }

  // "Products delivered": which of this customer's CONFIRMED / PACKED orders were handed over. They move to Delivered on submit.
  const deliveredField = container.querySelector("#delivered-orders-field");
  const deliveredList = container.querySelector("#delivered-orders-list");
  let deliverableLoaded = false;

  async function loadDeliverableOrders() {
    deliverableLoaded = true;
    deliveredList.innerHTML = `<p class="muted">${t("loading")}</p>`;
    try {
      const orders = await api.getDeliverableOrders(customerId);
      if (!orders.length) {
        deliveredList.innerHTML = `<p class="muted">${t("delivered_orders_none")}</p>`;
        return;
      }
      deliveredList.innerHTML = orders
        .map(
          (o) => `
          <label class="delivered-order-row">
            <input type="checkbox" name="delivered_orders" value="${o.id}" ${orders.length === 1 ? "checked" : ""} />
            <span class="delivered-order-main">
              <strong>${escapeHtml(o.order_code || `#${o.id}`)}</strong>
              <span class="muted">${escapeHtml(formatDateDMY(o.created_at))} · ${o.unit_count} ${t("delivered_orders_units")}</span>
            </span>
            <span class="delivered-order-total">${Number(o.total_amd).toLocaleString("en-US")}</span>
            <span class="badge ${o.status === "packed_stock_out" ? "badge-success" : "badge-neutral"}">${t(o.status === "packed_stock_out" ? "delivered_orders_packed" : "delivered_orders_confirmed")}</span>
          </label>`
        )
        .join("");
    } catch {
      deliverableLoaded = false; // offline or failed: the check-in still goes through, the office marks the delivery
      deliveredList.innerHTML = `<p class="muted">${t("delivered_orders_offline")}</p>`;
    }
  }

  function syncDeliveredVisibility() {
    const on = container.querySelector('input[name="outcomes"][value="customer_unavailable"]').checked;
    deliveredField.hidden = !on;
    if (on && !deliverableLoaded) loadDeliverableOrders();
  }

  container.querySelectorAll('input[name="outcomes"]').forEach((input) => {
    input.addEventListener("change", () => {
      outcomeError.hidden = true;
      if (!submitBtn.disabled) submitBtn.textContent = submitLabel();
      syncAmountFieldVisibility();
      syncDeliveredVisibility();
      syncAvailableProductsVisibility();
      syncNoteRequirement();
    });
  });
  amountInput.addEventListener("input", () => {
    amountError.hidden = true;
  });

  // The photo of the signed order blank ("Products delivered"): required, up to MAX_BLANK_PHOTOS pages. Always re-encoded at a size
  // where the printed text and the signatures stay readable (documents are not price tags: no "High resolution" tick needed).
  const MAX_BLANK_PHOTOS = 6;
  const blankPhotos = [];
  const blankInput = container.querySelector("#blank-photo-input");
  const blankBtn = container.querySelector("#blank-photo-btn");
  const blankLabel = container.querySelector("#blank-photo-label");
  const blankGrid = container.querySelector("#blank-thumb-grid");
  const blankError = container.querySelector("#blank-photo-error");
  function paintBlankThumbs() {
    blankGrid.innerHTML = blankPhotos
      .map(
        (photo, i) => `
        <div class="photo-thumb">
          <img src="${photo.url}" alt="${t("delivered_blank_title")}" />
          <button type="button" class="photo-remove-btn" data-index="${i}" aria-label="${t("remove_photo")}">&times;</button>
          <button type="button" class="photo-rotate-btn" data-rotate="${i}" aria-label="${t("rotate_right")}">&#8635;</button>
        </div>`
      )
      .join("");
    blankGrid.querySelectorAll(".photo-rotate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const photo = blankPhotos[Number(btn.dataset.rotate)];
        btn.disabled = true;
        try {
          const turned = await rotateImageBlob(photo.blob, 90);
          URL.revokeObjectURL(photo.url);
          photo.blob = turned;
          photo.url = URL.createObjectURL(turned);
          paintBlankThumbs();
        } catch {
          btn.disabled = false;
        }
      });
    });
    blankGrid.querySelectorAll(".photo-thumb img").forEach((img, i) => {
      img.addEventListener("click", () => openPhotoLightbox(blankPhotos.map((photo) => photo.url), i));
    });
    blankGrid.querySelectorAll(".photo-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        URL.revokeObjectURL(blankPhotos[Number(btn.dataset.index)].url);
        blankPhotos.splice(Number(btn.dataset.index), 1);
        paintBlankThumbs();
      });
    });
    blankLabel.textContent = blankPhotos.length ? t("add_another_photo") : t("take_photo");
    blankBtn.hidden = blankPhotos.length >= MAX_BLANK_PHOTOS;
  }
  blankBtn.addEventListener("click", () => blankInput.click());
  blankInput.addEventListener("change", async () => {
    const file = blankInput.files[0];
    blankInput.value = "";
    if (!file) return;
    try {
      const compressed = await compressImage(file, { maxDimension: 2400, quality: 0.9 });
      blankPhotos.push({ blob: compressed, url: URL.createObjectURL(compressed) });
      blankError.hidden = true;
      paintBlankThumbs();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  function paintPhotoThumbs() {
    photoThumbGrid.innerHTML = photos
      .map(
        (photo, i) => `
        <div class="photo-thumb">
          <img src="${photo.url}" alt="${t("photo_optional")}" />
          <button type="button" class="photo-remove-btn" data-index="${i}" aria-label="${t("remove_photo")}">&times;</button>
        </div>
      `
      )
      .join("");
    // Tap a thumbnail to look at the photo full-screen (pinch to zoom, swipe between photos)
    // before submitting -- the grid thumbnails are too small to judge focus or legibility.
    photoThumbGrid.querySelectorAll(".photo-thumb img").forEach((img, i) => {
      img.addEventListener("click", () => openPhotoLightbox(photos.map((photo) => photo.url), i));
    });
    photoThumbGrid.querySelectorAll(".photo-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        URL.revokeObjectURL(photos[Number(btn.dataset.index)].url);
        photos.splice(Number(btn.dataset.index), 1);
        paintPhotoThumbs();
      });
    });
    cameraBtnLabel.textContent = photos.length ? t("add_another_photo") : t("take_photo");
    cameraBtn.hidden = photos.length >= MAX_PHOTOS;
  }

  cameraBtn.addEventListener("click", () => photoInput.click());

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    photoInput.value = "";
    if (!file) return;
    try {
      // Default (unchecked) compresses the same as every other photo
      // upload in this app -- 1600px/0.75, small and fast to upload over a
      // field connection. "High resolution" is an explicit opt-in for the
      // cases that default would blur past legibility, a price tag or a
      // label's fine print being the actual reason a rep took the photo --
      // still re-encoded (not the raw multi-MB camera original) so an
      // opted-in upload doesn't stall on a bad connection, just at a size
      // and quality where small text stays readable.
      const compressed = highResToggle.checked
        ? await compressImage(file, { maxDimension: 2560, quality: 0.92 })
        : await compressImage(file);
      photos.push({ blob: compressed, url: URL.createObjectURL(compressed) });
      paintPhotoThumbs();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  let checkinBlocked = false;
  async function acquirePosition() {
    position = null;
    checkinBlocked = false;
    submitBtn.disabled = true;
    submitBtn.textContent = t("locating");
    verifyBanner.hidden = true;
    gpsStatus.hidden = false;
    gpsStatus.className = "gps-status";
    gpsStatus.textContent = t("getting_location");
    gpsStatus.setAttribute("aria-busy", "true");
    try {
      position = await getCurrentPosition({ timeout: 25000, goodAccuracy: 30, refineMs: 10000 });
      const accuracy = Math.round(position.coords.accuracy);
      const unit = getLang() === "hy" ? "մ" : "m";
      gpsStatus.textContent = `${t("location_captured")} (±${accuracy}${unit} ${t("accuracy")})`;
      gpsStatus.classList.add("gps-ok");
      // One banner, not two: the result card below carries the accuracy, so the "location captured" line steps aside
      // (it stays for "getting location" and for errors).
      gpsStatus.hidden = true;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel();

      const distance = haversineMeters(position.coords.latitude, position.coords.longitude, customer.lat, customer.lng);
      const withinRange = distance <= radiusMeters;
      verifyBanner.hidden = false;
      verifyBanner.className = `verify-banner ${withinRange ? "verify-banner-success" : "verify-banner-warning"}`;
      verifyBanner.innerHTML = `
        <span class="verify-banner-icon">${withinRange ? "✓" : "!"}</span>
        <div>
          <strong>${withinRange ? t("location_verified") : t("location_mismatch_away")}</strong>
          <span class="muted">${t("you_are")} ${formatDistance(distance)} ${t("from_customer")} · ±${accuracy}${unit} ${t("accuracy")}</span>
        </div>
      `;
      // Check-in allowance: a sales manager too far from the pin cannot check in (management can). The pin
      // may be the thing that is wrong, so offer the map with the real spots and "you are here".
      checkinBlocked = allowanceOn && creditedDistanceMeters(distance, position.coords.accuracy) > radiusMeters && state.user?.role === "sales_manager";
      if (checkinBlocked) {
        submitBtn.disabled = true;
        // Where the rep really stands is evidence for the Pin review (best effort, nothing to do if offline).
        api
          .reportFarAttempt({ customer_id: Number(customerId), lat: position.coords.latitude, lng: position.coords.longitude, accuracy_m: Math.round(position.coords.accuracy) })
          .catch(() => {});
        verifyBanner.innerHTML = `
          <span class="verify-banner-icon">!</span>
          <div>
            <strong>${t("checkin_too_far").replace("{d}", formatDistance(distance)).replace("{m}", String(radiusMeters))}</strong>
            <button type="button" class="btn btn-sm" id="checkin-see-map">${t("checkin_too_far_map")}</button>
          </div>
        `;
        verifyBanner.querySelector("#checkin-see-map").addEventListener("click", () => {
          navigate(`#/customers/${customerId}/spots?here=${position.coords.latitude.toFixed(6)},${position.coords.longitude.toFixed(6)}`);
        });
      }
    } catch (err) {
      gpsStatus.textContent = `${t("location_error")}. ${locationErrorHint(err)} `;
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
    if (!position || checkinBlocked) return;

    const data = new FormData(form);
    const outcomes = data.getAll("outcomes");
    // The office check-in (every rep's "I'm at work") needs no visit outcome.
    if (!outcomes.length && customer.checkin_for_all) outcomes.push("other");
    if (!outcomes.length) {
      outcomeError.hidden = false;
      outcomeError.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Rounded here, not just step="1" on the input -- a decimal amount used
    // to silently block the browser's own native form submission with no
    // visible error at all.
    const amountCollected = outcomes.includes("payment_collected") ? Math.round(Number(data.get("amount_collected_amd"))) : null;
    if (outcomes.includes("payment_collected") && (!Number.isFinite(amountCollected) || amountCollected <= 0)) {
      amountError.hidden = false;
      amountError.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (outcomes.includes("other") && !customer.checkin_for_all && !String(data.get("note") ?? "").trim()) {
      noteError.hidden = false;
      noteError.scrollIntoView({ behavior: "smooth", block: "center" });
      noteInput.focus({ preventScroll: true });
      return;
    }
    if (outcomes.includes("customer_unavailable") && !blankPhotos.length) {
      blankError.hidden = false;
      blankError.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (openOrderTasks.length && !orderTaskAnswered && !outcomes.includes("order_placed")) {
      const answer = await openOrderTaskSheet(openOrderTasks);
      if (!answer) return;
      orderTaskAnswered = true;
      if (answer.action === "order") {
        outcomes.push("order_placed");
        const box = container.querySelector('input[name="outcomes"][value="order_placed"]');
        if (box) box.checked = true;
      } else {
        skippedOrderTasks = { tasks: openOrderTasks, reason: answer.reason };
      }
    }

    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("submitting");
    form.setAttribute("aria-busy", "true");

    const note = data.get("note");
    const brandStatusPayload = Object.fromEntries(Object.entries(brandStatus).filter(([, v]) => v.length));
    const { latitude: lat, longitude: lng } = position.coords;

    // Generated once, before the first (online) attempt -- reused as-is if
    // this falls through to enqueueCheckin below, so a retry after a lost
    // response (the fetch throws even though the server actually received
    // and saved this exact request) can't create a second check-in. See
    // server/src/routes/checkins.js and offlineQueue.js.
    const clientRef = crypto.randomUUID();
    const formData = new FormData();
    formData.set("customer_id", customerId);
    formData.set("lat", lat);
    formData.set("lng", lng);
    formData.set("client_ref", clientRef);
    if (Number.isFinite(position.coords.accuracy)) formData.set("accuracy_m", Math.round(position.coords.accuracy));
    if (note) formData.set("note", note);
    formData.set("outcomes", JSON.stringify(outcomes));
    if (amountCollected != null) formData.set("amount_collected_amd", amountCollected);
    const deliveredOrderIds = outcomes.includes("customer_unavailable") ? data.getAll("delivered_orders").map(Number) : [];
    if (deliveredOrderIds.length) formData.set("delivered_order_ids", JSON.stringify(deliveredOrderIds));
    if (Object.keys(brandStatusPayload).length) formData.set("brand_status", JSON.stringify(brandStatusPayload));
    const availableProductsPayload = [...selectedAvailableProducts];
    if (availableProductsPayload.length) formData.set("available_products", JSON.stringify(availableProductsPayload));
    photos.forEach((photo, i) => formData.append("photos", photo.blob, `checkin-${i}.jpg`));
    const orderBlankBlobs = outcomes.includes("customer_unavailable") ? blankPhotos.map((photo) => photo.blob) : [];
    orderBlankBlobs.forEach((blob, i) => formData.append("order_blank_photos", blob, `order-blank-${i}.jpg`));

    try {
      const checkin = await api.createCheckin(formData);
      if (skippedOrderTasks) {
        // Best effort: the visit is saved either way, the task simply stays open if this fails.
        const note = `${t("order_task_closed_note")}: ${t(`order_task_reason_${skippedOrderTasks.reason}`)}`;
        await Promise.all(skippedOrderTasks.tasks.map((task) => api.completeTask(task.id, note).catch(() => {})));
      }
      showResult(checkin);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure — queue it instead of losing the visit.
        // Raw Blobs, not base64 -- offlineQueue.js's IndexedDB store
        // handles Blobs natively, no data-URL round trip needed.
        enqueueCheckin({
          clientRef,
          customerId,
          customerName: customer.name,
          lat,
          lng,
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : undefined,
          note,
          brandStatus: brandStatusPayload,
          outcomes,
          amountCollected,
          deliveredOrderIds,
          availableProducts: availableProductsPayload,
          photos: photos.map((photo) => photo.blob),
          orderBlankPhotos: orderBlankBlobs,
        });
        showQueued();
      } else {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel();
        form.removeAttribute("aria-busy");
      }
    }
  });

  function showResult(checkin) {
    form.removeAttribute("aria-busy");
    form.hidden = true;
    resultEl.hidden = false;
    const placedOrder = (checkin.outcomes ?? []).includes("order_placed");
    resultEl.innerHTML = `
      <div class="checkin-result ${checkin.within_range ? "result-success" : "result-warning"}">
        <div class="result-icon">${checkin.within_range ? "✓" : "!"}</div>
        <h2>${checkin.within_range ? t("location_verified") : t("location_mismatch_away")}</h2>
        <p>${
          checkin.within_range
            ? t("checked_in_onsite")
            : `${t("you_were")} ${formatDistance(checkin.distance_meters)} ${t("from")} ${escapeHtml(customer.name)}.`
        }</p>
        ${checkin.within_range && state.user?.role !== "sales_manager" ? `<p class="muted">${t("checkin_not_rep_visit")}</p>` : ""}
        ${(checkin.delivered_orders ?? []).length ? `<p class="delivered-orders-done">${t("delivered_orders_moved").replace("{n}", String(checkin.delivered_orders.length))}</p>` : ""}
        ${placedOrder ? `<button class="btn btn-primary btn-block" id="create-order-btn">${t("create_order")}</button>` : ""}
        <button class="btn ${placedOrder ? "" : "btn-primary"} btn-block" id="back-to-customer">${t("done")}</button>
      </div>
    `;
    resultEl.querySelector("#back-to-customer").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
    resultEl.querySelector("#create-order-btn")?.addEventListener("click", () => {
      navigate(`#/orders/new/${customerId}?checkin=${checkin.id}`);
    });
    // "Order placed": the check-in is confirmed, now the order menu opens (new / usual / repeat last / repeat an order).
    if (placedOrder) openOrderMenu({ customer: { ...customer, id: Number(customerId) }, navigate, checkinId: checkin.id });
    // The customer's usual basket one tap away (only when they have one).
    loadReorderProfile(customerId).then((profile) => {
      if (!profile?.items?.length || !resultEl.querySelector("#back-to-customer")) return;
      resultEl.querySelector("#back-to-customer").insertAdjacentHTML("beforebegin", `<button class="btn ${placedOrder ? "" : "btn-primary"} btn-block" id="order-usual-btn">${t("usual_order_btn")}</button>`);
      resultEl.querySelector("#order-usual-btn").addEventListener("click", () => navigate(`${usualOrderHash(customerId)}&checkin=${checkin.id}`));
      if (!placedOrder) resultEl.querySelector("#back-to-customer").classList.remove("btn-primary");
    });
  }

  function showQueued() {
    form.removeAttribute("aria-busy");
    form.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="checkin-result result-warning">
        <div class="result-icon">⇪</div>
        <h2>${t("saved_on_phone")}</h2>
        <p>${t("queued_checkin_text")}</p>
        <button class="btn btn-block" id="queue-btn">${t("view_waiting")}</button>
        <button class="btn btn-primary btn-block" id="back-to-customer">${t("done")}</button>
      </div>
    `;
    resultEl.querySelector("#queue-btn").addEventListener("click", openSyncQueueSheet);
    resultEl.querySelector("#back-to-customer").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }
}
