import { api } from "../api.js";
import { reorderHash } from "../reorder.js";
import { activateCombobox, activateDialog, escapeHtml, formatDateTime, formatDistance, formatAmd, formatPhoneDisplay, normalizePhone, openNavigation, tierSelectorHtml, activateTierSelector, tierBadgeHtml, categorySelectorHtml, activateCategorySelector, categoryLabel, customerListIconHtml, REGION_LIST, YEREVAN_DISTRICTS, regionLabelHy, subregionLabelHy, SALES_CHANNELS, channelDisplayLabel, parseDateOnly, formatDateDMY, formatDayMonth, labelColon, erpLineDiscountRowHtml, leaveSheetTo, showToast, openInfoPopup } from "../util.js";
import { wirePlaceInput, placeNoticeText } from "../places.js";
import { currentChips, chipHtml, chipSections } from "../brandChips.js";
import { nextVisitRowHtml } from "../visitSchedule.js";
import { t } from "../i18n.js";
import { dueChipHtml } from "../debtChip.js";
import { icons } from "../icons.js";
import { state, canCreateTasks, canSetCustomerPrices, canEditDirectly, canReassignCustomers, canAssignErpCustomerId, canEditOwnSalesChannel, isAdmin, seesFinancialExports, seesAllActivity } from "../state.js";
import { openVisitDetailSheet, openPhotoLightbox } from "../visitDetail.js";
import { visitStatusBadge } from "./customers.js";
import { renderPotentialCard, potentialBadgeHtml } from "../potential.js";
import { openFileReadySheet } from "../fileReadySheet.js";
import { openOrderMenu } from "../orderMenu.js";
import { bindStepperButton } from "../stepper.js";
import { loadWithCache, warmCache, peekCache, refreshCache } from "../listCache.js";
import { cardSource, fetchedJustNow, isWholeBundle, lateParts, VISITS_PAGE } from "../customerCardLoader.js";
import { paymentsSource, allOrdersSource, orderDetailSource, photosSource } from "../customerCardData.js";
import { openFileViewer, fileKindLabel } from "../fileViewer.js";
import { openAddFileSheet } from "../addFileSheet.js";
import { fetchCustomerSocial, saveCustomerSocial, socialFieldsHtml, collectSocialPayload, socialLinksHtml, bindSocialLinks } from "../customerSocialProfiles.js";

// Long lists (payments, orders, photos) paint this many rows first and the rest on "Show more": 1,000 rows at once froze a phone.
const FIRST_ROWS = 40;
// The Files sheet shows fewer photos first so the Documents section below them stays one short scroll away.
const FIRST_PHOTOS = 12;

// Everyone who works with customers can add a document; warehouse staff cannot (server: canAddCustomerFiles).
const canAddFiles = () => state.user.role !== "warehouse_manager";

const EDIT_FIELDS = [
  { name: "name", labelKey: "name", type: "text" },
  { name: "category", labelKey: "category", type: "select" },
  { name: "phone", labelKey: "phone", type: "tel" },
  { name: "address", labelKey: "address", type: "text" },
  { name: "visit_frequency_days", labelKey: "visit_frequency", type: "number" },
  { name: "notes", labelKey: "notes", type: "textarea" },
  { name: "tin", labelKey: "tin", type: "text" },
  { name: "legal_name", labelKey: "legal_name", type: "text" },
  { name: "legal_address", labelKey: "legal_address", type: "text" },
];

// A potential customer shows how likely the sale is (Likely, Very likely, ...); every other tier shows its own name.
const headerTierBadge = (c) => (c.customer_tier === "potential" && potentialBadgeHtml(c.potential_level)) || tierBadgeHtml(c.customer_tier);

// The card: a saved copy from the last visit draws at once while a fresh copy is fetched (and replaces it only when something changed); a
// first-ever visit shows the loading line. A finger landing on the customer's row already started this same fetch (prefetch.js), so it is
// usually finished by the time the card opens. { fresh: true } (after the rep changed something here) skips the saved copy.
export async function renderCustomerDetail(root, navigate, customerId, { fresh = false } = {}) {
  root.innerHTML = `<div class="detail-view customer-detail-view"></div>`;
  const container = root.querySelector(".detail-view");
  const reload = () => renderCustomerDetail(root, navigate, customerId, { fresh: true });
  const source = cardSource(customerId);
  const saved = fresh ? undefined : await peekCache(source.key);
  if (!container.isConnected) return; // the rep already moved on
  const showError = (err) => {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p><button type="button" class="btn btn-block" id="customer-retry-btn">${t("retry")}</button>`;
    container.querySelector("#customer-retry-btn").addEventListener("click", reload);
  };
  if (isWholeBundle(saved, customerId)) {
    paintCustomerCard(root, navigate, customerId, container, saved, reload);
    if (fetchedJustNow(customerId)) return; // this copy IS the fresh one (the finger-down fetch just finished)
    const savedJson = JSON.stringify(saved);
    refreshCache(source.key, source.fetch)
      .then((latest) => {
        if (!container.isConnected || !isWholeBundle(latest, customerId) || JSON.stringify(latest) === savedJson) return;
        // Something changed since the copy was saved: draw the new one, unless the rep is in the middle of something (a sheet is open).
        if (document.querySelector(".sheet-overlay")) return;
        const scroller = root;
        const top = scroller.scrollTop;
        paintCustomerCard(root, navigate, customerId, container, latest, reload);
        scroller.scrollTop = top;
      })
      .catch((err) => {
        // Offline / slow: keep what is on screen. But a customer who is gone or no longer visible to this person must not stay readable.
        if (container.isConnected && (err.status === 404 || err.status === 403)) showError(err);
      });
    return;
  }
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let data;
  try {
    data = await refreshCache(source.key, source.fetch, { force: fresh });
  } catch (err) {
    if (container.isConnected) showError(err);
    return;
  }
  if (!container.isConnected) return;
  paintCustomerCard(root, navigate, customerId, container, data, reload);
}

function paintCustomerCard(root, navigate, customerId, container, data, reload) {
  let { customer } = data;
  const { checkins, pendingRequests, erpOrders, brandSummaryRows, visitSchedule, partialFailure } = data;
  // Parts that were slower than the card are filled in when they arrive (and only if this card is still the one on screen).
  const late = lateParts.get(String(customerId)) || {};
  const fillPart = (early, name, fill) => {
    if (early !== undefined) fill(early);
    else late[name]?.then((value) => container.isConnected && fill(value));
  };
  const socialEarly = data.social;
  const docsEarly = data.docs;
  const tasksEarly = data.tasks;
  const openVisitEarly = data.openVisit;

  // Same derivation the Customers list uses, imported rather than re-derived
  // here -- this page previously computed its own near-but-not-quite-equal
  // version (it had no "exempt" or "on-track" concept at all, so a
  // never-visited customer on an exempt channel was still labelled).
  const statusBadge = visitStatusBadge(customer);
  const brandChipList = currentChips(brandSummaryRows?.[0]?.current);

  // KF/CAS/CVO/PCO/OEM channels are not visited in the field (server: requires_visit = false).
  const noVisitChannel = customer.requires_visit === false;
  let nextVisitHtml = "";
  if (customer.overdue) {
    nextVisitHtml = `<span class="badge badge-danger">${t("filter_overdue")}</span>`;
  } else if (customer.last_visit_at) {
    const next = new Date(customer.last_visit_at);
    next.setDate(next.getDate() + customer.visit_frequency_days);
    nextVisitHtml = `<span class="muted">${t("next_due")}${labelColon()}${formatDateTime(next.toISOString())}</span>`;
  } else {
    nextVisitHtml = `<span class="muted">${t("never_visited")}</span>`;
  }

  const idCategoryLine = [
    customer.erp_customer_id ? `${t("customer_id_label")}${labelColon()}${escapeHtml(customer.erp_customer_id)}` : "",
    customer.category ? escapeHtml(categoryLabel(customer.category)) : "",
  ]
    .filter(Boolean)
    .join(" &middot; ");

  // The edit-type actions live as icon buttons directly on this row, not
  // tucked behind a "•••" overflow menu -- that menu used to hold four
  // separate entry points (reassign manager / link ERP ID / payment
  // settings / edit customer), which is also why they're merged down to
  // two taps here: "Account settings" (manager/ERP-ID/payment, whichever
  // this viewer is allowed to touch) and "Edit" (core fields, plus contact
  // & social profiles as a section of the same sheet). The one-tap
  // external links (Instagram/Facebook/email/website, injected by
  // customerSocialProfiles.js) stay alongside them -- those just hand off
  // to another app and cost nothing to keep in the open.
  const hasAccountSettings =
    canReassignCustomers() || canAssignErpCustomerId(customer) || canEditOwnSalesChannel(customer) || seesFinancialExports();

  container.innerHTML = `
    ${partialFailure ? `<p class="form-error customer-partial-error">${t("card_partial_load")} <button type="button" class="btn btn-sm" id="customer-reload-btn">${t("retry")}</button></p>` : ""}
    <div class="detail-header customer-detail-header">
      <div class="customer-detail-header-main">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-icon">${customerListIconHtml(customer)}</div>
        <div class="detail-header-title">
          <h1 id="customer-detail-name" tabindex="0" role="button" aria-label="${t("tap_to_show_full_name")}">${escapeHtml(customer.name)}</h1>
          <!-- Nested inside the same title column (not a sibling of it) so
               this row starts at the name's own left edge, immediately
               under it -- not under the avatar, and not the full header
               width. -->
          <div class="detail-header-status-row">
            ${idCategoryLine ? `<span class="muted detail-header-subtitle">${idCategoryLine}</span>` : ""}
            <span id="cd-tier-slot" class="cd-tier-slot">${headerTierBadge(customer)}</span>
            ${statusBadge ? `<span class="badge ${statusBadge.cls}">${t(statusBadge.labelKey)}</span>` : ""}
          </div>
        </div>
      </div>
    </div>

    <!-- Two wrapper columns: invisible on a phone (display: contents), side by side on a desktop window (desktop.css). -->
    <div class="cd-col cd-col-main">
    <div id="open-visit-slot"></div>
    <div class="card detail-facts-card">
      <!-- One toolbar row: social/contact links (Instagram/Facebook/email/
           website) on the left, Account settings + Edit on the right.
           customerSocialProfiles.js finds the left slot by its own class and
           fills it in -- left empty (zero width, so space-between still pins
           the right group to the edge) for any customer with no profiles
           linked yet. -->
      <div class="detail-facts-card-actions is-compact">
        <span class="detail-facts-card-actions-social customer-social-section"></span>
        <div class="detail-facts-card-actions-primary">
          ${
            hasAccountSettings
              ? `<button type="button" class="icon-btn" id="account-settings-btn" aria-label="${t("account_settings")}" title="${t("account_settings")}">${icons.settings}</button>`
              : ""
          }
          <button type="button" class="icon-btn" id="edit-customer-btn" aria-label="${t("edit_customer")}" title="${t("edit_customer")}">${icons.pencil}</button>
        </div>
      </div>
      ${
        customer.region || customer.address
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.pin}</span><span>${[
              customer.region ? regionLabelHy(customer.region) : null,
              customer.subregion ? subregionLabelHy(customer.subregion) : null,
              customer.address,
            ]
              .filter(Boolean)
              .map(escapeHtml)
              .join(" &middot; ")}</span>${customer.place_review_pending && ["admin", "ceo", "operations_director", "sales_director"].includes(state.user.role) ? ` <span class="badge badge-warning">${t("place_to_review")}</span>` : ""}</div>`
          : ""
      }
      ${customer.phone ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.phone}</span><a href="tel:${escapeHtml(customer.phone)}">${escapeHtml(formatPhoneDisplay(customer.phone))}</a></div>` : ""}
      ${
        customer.sales_channel || customer.assigned_manager_name
          ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.box}</span><span>${[customer.sales_channel ? channelDisplayLabel(customer.sales_channel) : "", customer.assigned_manager_name].filter(Boolean).map(escapeHtml).join(" &middot; ")}</span></div>`
          : ""
      }
      ${noVisitChannel ? "" : `<div class="detail-fact"><span class="detail-fact-icon">${icons.repeat}</span><span>${t("visit_every_prefix")}${customer.visit_frequency_days}${t("visit_every_suffix")}</span></div>`}
      <div class="detail-fact"><span class="detail-fact-icon">${icons.wallet}</span><span>${t(customer.payment_method === "cash" ? "payment_method_cash" : "payment_method_invoice")} &middot; ${t("credit_term_fact").replace("{n}", customer.credit_term_days)}</span></div>
      ${customer.credit_limit_amd != null ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.wallet}</span><span>${t("credit_limit_label")}${labelColon()}${formatAmd(customer.credit_limit_amd)}</span></div>` : ""}
      ${customer.last_visit_at ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.clock}</span><span>${t("last_visit")}${labelColon()}${formatDateTime(customer.last_visit_at)}</span></div>` : ""}
      ${customer.notes ? `<div class="detail-fact muted"><span class="detail-fact-icon">${icons.note}</span><span>${escapeHtml(customer.notes)}</span></div>` : ""}
    </div>

    <div id="pending-request-slot"></div>

    ${renderErpCard(customer, erpOrders)}

    <!-- Owner, 2026-10-27: Check in, New task, New order, Navigate, Files. No "Orders" button: the Sales tile above opens the same list.
         No "Call" button either: the phone number in the facts card is already a tel: link. -->
    <div class="detail-actions-grid" style="--action-cols:${canCreateTasks() ? 5 : 4}">
      <button class="action-btn action-btn-primary" id="checkin-btn">
        <span>${icons.mapPinCheck}</span>${t("check_in")}
      </button>
      ${canCreateTasks() ? `<button type="button" class="action-btn" id="new-task-btn"><span>${icons.tasks}</span>${t("task_new")}</button>` : ""}
      <button type="button" class="action-btn" id="new-order-btn">
        <span>${icons.cart}</span>${t("new_order")}
      </button>
      <button type="button" class="action-btn" id="navigate-btn">
        <span>${icons.compass}</span>${t("navigate")}
      </button>
      <button type="button" class="action-btn" id="customer-photos-btn">
        <span>${icons.folder}</span>${t("customer_files")}
      </button>
    </div>

    </div>
    <div class="cd-col cd-col-side">
    <div id="customer-tasks-slot"></div>
    <div id="customer-docs-slot"></div>

    ${
      noVisitChannel
        ? ""
        : `<div class="card next-visit-card">
      <div class="next-visit-header"><span>${t("next_visit")}</span></div>
      <div class="next-visit-due">
        ${visitSchedule ? nextVisitRowHtml(visitSchedule) : `<div>${nextVisitHtml}</div>`}
      </div>
    </div>`
    }

    <div class="sales-heading-with-hint product-chips-heading">
      <h2 class="section-title section-title-tight product-chips-title">${t("brand_chips_title")}</h2>
      <button type="button" class="settings-hint-icon" id="chips-info-btn" aria-label="${t("more_info")}">!</button>
    </div>
    <div class="card product-chips-card" id="product-chips-card">
      ${
        brandChipList.length
          ? `<div class="product-chips-columns">${chipSections(brandChipList)
              .map((section) => `<div class="product-chips-col" style="grid-column: span ${section.span}">${section.chips.map((d) => chipHtml(d)).join("")}</div>`)
              .join("")}</div>`
          : `<p class="muted product-chips-hint">${t("brand_chips_empty")}</p>`
      }
    </div>

    <!-- Potential: between "Products available" and the visits (owner, 2026-10-24). -->
    <div id="potential-slot"></div>

    <h2 class="section-title" id="visit-history-anchor">${t("visit_history")}</h2>
    <div id="checkin-history" class="card-list"></div>
    </div>
  `;

  container.querySelector("#chips-info-btn").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("brand_chips_hint"))}</p>`));
  container.querySelector("#checkin-btn").addEventListener("click", () => {
    navigate(`#/checkin/${customerId}`);
  });
  container.querySelector("#navigate-btn").addEventListener("click", () => {
    openNavigation(customer.lat, customer.lng, {
      onShowOnMap: () => navigate(`#/map?customer=${customerId}`),
    });
  });
  container.querySelector("#customer-reload-btn")?.addEventListener("click", reload);
  // customerSocialProfiles.js's own decoration (a second request after the paint) leaves a slot marked like this alone.
  const socialSlot = container.querySelector(".detail-facts-card-actions-social");
  if (socialSlot) socialSlot.dataset.socialProfilesReady = String(customerId);
  fillPart(socialEarly, "social", (data) => {
    const slot = socialSlot;
    if (!slot || !data) return;
    const html = socialLinksHtml(data);
    slot.innerHTML = html;
    if (html) slot.closest(".detail-facts-card-actions")?.classList.remove("is-compact");
    bindSocialLinks(slot);
  });
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/customers"));
  // Potential level + reasons (potential customers) and the counterfeit-products restriction; a change reloads only this card.
  const potentialSlot = container.querySelector("#potential-slot");
  const reloadPotential = async () => {
    try {
      customer = await api.getCustomer(customerId);
      const tierSlot = container.querySelector("#cd-tier-slot");
      if (tierSlot) tierSlot.innerHTML = headerTierBadge(customer);
      renderPotentialCard(potentialSlot, customer, { reload: reloadPotential });
    } catch {
      /* the card keeps showing what it had */
    }
  };
  renderPotentialCard(potentialSlot, customer, { reload: reloadPotential });
  // Long names truncate with an ellipsis by default (see .detail-header-title
  // h1); tapping reveals the full name by letting it wrap instead of adding
  // a tooltip/sheet nobody would think to open.
  container.querySelector("#customer-detail-name").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("customer-detail-name-expanded");
  });
  // "End visit": a rep who checked in here today and has not ended the visit yet.
  if (state.user.role === "sales_manager") {
    const slot = container.querySelector("#open-visit-slot");
    fillPart(openVisitEarly, "openVisit", (open) => {
      if (!open || !slot) return;
      slot.innerHTML = `<button type="button" class="btn btn-block" id="end-visit-btn" style="min-height:44px;margin-bottom:12px">${t("end_visit")}</button>`;
      slot.querySelector("#end-visit-btn").addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.endVisit(open.id);
          slot.innerHTML = "";
        } catch {
          e.currentTarget.disabled = false;
        }
      });
    });
  }
  // A tap starts a new order at once; a long press opens the menu (new / usual / repeat last / repeat an order).
  bindStepperButton(container.querySelector("#new-order-btn"), {
    onTap: () => navigate(`#/orders/new/${customerId}`),
    onHold: () => {
      try {
        localStorage.setItem("fieldvisits_om_hint", "1");
      } catch {
        /* ignore */
      }
      openOrderMenu({ customer, navigate });
    },
  });
  // One-time tip so the long press is found: shown once, never over an open sheet, and not at all for someone who
  // has already opened the menu.
  setTimeout(() => {
    try {
      if (localStorage.getItem("fieldvisits_om_hint") || document.querySelector(".sheet-overlay") || !container.isConnected) return;
      localStorage.setItem("fieldvisits_om_hint", "1");
      showToast(t("om_hint"), { ms: 6000 });
    } catch {
      /* private mode: no tip */
    }
  }, 1500);
  container.querySelector("#edit-customer-btn").addEventListener("click", () => {
    openEditSheet(customer, navigate, reload);
  });
  container.querySelector("#account-settings-btn")?.addEventListener("click", () => {
    openAccountSettingsSheet(customer, reload);
  });
  container.querySelector("#customer-photos-btn").addEventListener("click", () => openCustomerFiles(customer));
  // Stat tiles: Sales -> orders, Outstanding debt -> payments received,
  // Last order -> its details (long press: all orders), Last visit -> its details.
  const openLastOrder = async (tile) => {
    tile.disabled = true;
    try {
      // The inline list only covers the last 3 months; the last order can be older.
      const list = erpOrders?.length ? erpOrders : await api.getErpOrders(customerId, "all");
      if (list[0]) openOrderDetailSheet(customerId, list[0].order_id, list[0]);
    } catch (err) {
      alert(err.message);
    } finally {
      tile.disabled = false;
    }
  };
  // Start the data a tile opens the moment a finger lands on it; the sheet that opens a moment later shares that request.
  const warmFor = (stat) => {
    if (stat === "debt" || stat === "last-payment") warmCache(paymentsSource(customerId).key, paymentsSource(customerId).fetch);
    else if (stat === "sales") warmCache(allOrdersSource(customerId).key, allOrdersSource(customerId).fetch);
    else if (stat === "last-order" && erpOrders?.[0]) warmCache(orderDetailSource(customerId, erpOrders[0].order_id).key, orderDetailSource(customerId, erpOrders[0].order_id).fetch);
  };
  container.querySelectorAll("[data-stat]").forEach((tile) => {
    const stat = tile.dataset.stat;
    tile.addEventListener("pointerdown", () => warmFor(stat), { passive: true });
    const onTap = () => {
      if (stat === "sales") {
        navigate(`#/customers/${customerId}/orders`);
      } else if (stat === "debt" || stat === "last-payment") {
        openPaymentsReceivedSheet(customer);
      } else if (stat === "last-visit" && checkins[0]) {
        openVisitDetailSheet(checkins[0], reload, navigate);
      } else if (stat === "last-order") {
        openLastOrder(tile);
      }
    };
    if (stat === "last-order") {
      // A long press goes straight to the whole order list.
      bindStepperButton(tile, { onTap, onHold: () => navigate(`#/customers/${customerId}/orders`) });
    } else {
      tile.addEventListener("click", onTap);
    }
  });
  // Quiet warm-up of the one small thing a tap would otherwise wait for: the last order's lines (about 1 KB).
  if (erpOrders?.[0]) {
    const warmLast = () => warmCache(orderDetailSource(customerId, erpOrders[0].order_id).key, orderDetailSource(customerId, erpOrders[0].order_id).fetch);
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 800)))(warmLast);
  }
  container.querySelector("#new-task-btn")?.addEventListener("click", async () => {
    const tasksModule = await import("./tasks.js");
    tasksModule.openTaskEditor({
      customer: { id: Number(customerId), name: customer.name, assigned_manager_id: customer.assigned_manager_id, locked: true },
      onSaved: loadCustomerTaskBlock,
    });
  });

  // Signed accounting documents (from Lily) of this customer's orders.
  fillPart(docsEarly, "docs", async (docs) => {
    const slot = container.querySelector("#customer-docs-slot");
    if (!slot || !docs?.length) return;
    const files = await import("../accountingFiles.js");
    slot.innerHTML = files.documentsSectionHtml(docs);
    files.bindDocumentRows(slot);
  });

  // Open tasks attached to this customer (above Next visit), plus "Add task" for management.
  fillPart(tasksEarly, "tasks", (value) => value && paintCustomerTaskBlock(value));
  async function loadCustomerTaskBlock() {
    paintCustomerTaskBlock(await (await import("./tasks.js")).loadCustomerTasks(customerId));
  }
  // No tasks -> no block at all (owner, 2026-10-27); "New task" lives in the action row.
  async function paintCustomerTaskBlock({ rows, today }) {
    const slot = container.querySelector("#customer-tasks-slot");
    if (!slot) return;
    if (!rows.length) {
      slot.innerHTML = "";
      return;
    }
    const tasksModule = await import("./tasks.js");
    slot.innerHTML = `
      <div class="tasks-block">
        <div class="tasks-home-head">
          <h2 class="section-title section-title-inline">${t("tasks_customer_title")}</h2>
        </div>
        <div class="card-list">${rows.map((r) => tasksModule.taskCardHtml(r, today, { showCustomer: false })).join("")}</div>
      </div>`;
    slot.querySelectorAll("[data-task-id]").forEach((el) =>
      el.addEventListener("click", () => tasksModule.openTaskSheet(Number(el.dataset.taskId), { onChanged: loadCustomerTaskBlock, navigate }))
    );
  }

  renderPendingRequest(container.querySelector("#pending-request-slot"), pendingRequests[0], reload);

  const historyEl = container.querySelector("#checkin-history");
  const openVisit = (index) =>
    openVisitDetailSheet(checkins[index], reload, navigate);
  // A compact, tappable row per visit -- the full detail (badges, brand
  // tags, note, photos) used to be rendered inline for every single visit
  // at once, which made a customer with a long history nearly unusable to
  // scroll through. Tapping a row opens everything in its own sheet.
  const visitRowHtml = (ch, i) => `
        <button type="button" class="card checkin-row" data-checkin-index="${i}">
          <div class="checkin-row-main">
            <strong>${escapeHtml(ch.user_name)}</strong>
            <span class="muted">${formatDateTime(ch.timestamp)}</span>
          </div>
          <span class="card-trailing">
            <span class="visit-range-icon ${ch.within_range ? "is-ok" : "is-bad"}" role="img" aria-label="${ch.within_range ? t("location_verified") : t("location_mismatch_away")}">${ch.within_range ? icons.checkCircle : icons.mapWarning}</span>
            ${ch.photos?.length ? `<span class="checkin-row-photo-count">📷 ${ch.photos.length}</span>` : ""}
            <span class="chevron">&#8250;</span>
          </span>
        </button>`;
  if (!checkins.length) {
    historyEl.innerHTML = `<p class="empty-state">${t("no_visits_yet")}</p>`;
  } else {
    let moreAvailable = checkins.length >= VISITS_PAGE;
    const paint = () => {
      historyEl.innerHTML =
        checkins.map(visitRowHtml).join("") +
        (moreAvailable ? `<button type="button" class="btn btn-block" id="more-visits-btn">${t("show_older_visits")}</button>` : "");
      historyEl.querySelectorAll("[data-checkin-index]").forEach((btn) => btn.addEventListener("click", () => openVisit(Number(btn.dataset.checkinIndex))));
      historyEl.querySelector("#more-visits-btn")?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          const older = await api.customerCheckins(customerId, { limit: 1000, offset: checkins.length });
          checkins.push(...older);
          moreAvailable = false;
          paint();
        } catch (err) {
          e.currentTarget.disabled = false;
          showToast(err.message);
        }
      });
    };
    paint();
  }
}

function renderErpCard(customer, erpOrders) {
  if (!customer.erp_synced_at) return customer.erp_customer_id && customer.erp_last_order_date ? renderErpOrdersOnlyCard(customer, erpOrders) : "";

  const debt = Number(customer.erp_debt_amd) || 0;
  const collectedSinceSync = Number(customer.collected_since_sync_amd) || 0;
  const estimatedDebt = customer.estimated_debt_amd != null ? Number(customer.estimated_debt_amd) : null;
  const isDataError = customer.erp_aging_bucket === "Data error - review";
  const orders = Array.isArray(erpOrders) ? erpOrders : [];

  const now = new Date();
  const salesThisMonth = orders
    .filter((o) => {
      // order_date is a plain calendar date (no time) -- parseDateOnly avoids
      // the UTC-midnight-parsing bug that shifted an order into the wrong
      // month near a month boundary for a viewer behind UTC.
      const d = parseDateOnly(o.order_date);
      return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + Number(o.total_amd), 0);
  // customer.erp_last_order_date is unbounded (a plain MAX(order_date), see
  // GET /customers/:id) -- unlike orders[0], which only reflects the
  // "recent" (last 3 months) scope this page's own order list fetches for
  // the "Sales this month" tile above. Without it, a customer whose last
  // order predates that window showed "-" here despite having order
  // history, just not within it. orders[0] is still the fallback for an
  // older cached customer object (offline/stale listCache) that hasn't
  // picked up the new field yet.
  // Same style as the Last visit tile ("12 Oct 2026" / "12 Հկտ 2026").
  const dayMonthYear = (value) => {
    const d = parseDateOnly(value);
    return d ? formatDayMonth(d, { year: true }) : null;
  };
  const lastOrderDate = customer.erp_last_order_date
    ? dayMonthYear(customer.erp_last_order_date)
    : orders[0]
      ? dayMonthYear(orders[0].order_date)
      : null;

  return statTilesHtml({
    customer,
    salesThisMonth,
    debtText: isDataError ? t("erp_debt_unknown") : formatAmd(debt),
    // Red only while some unpaid invoice is past its due date (FIFO, credit term deducted -- the
    // same rule as the chip, the reports and the tasks), or the data is broken. A 0 balance is fine.
    debtDanger: isDataError || (debt > 0 && (customer.debt_summary?.oldest_due_days ?? 0) > 0),
    // A return the customer is owed but Excel has not booked yet (migration 143): shown at once, it lowers the debt once the accountant records it.
    debtSub: [
      !isDataError && collectedSinceSync > 0 ? `${t("estimated_remaining")}${labelColon()}${formatAmd(estimatedDebt)}` : "",
      returnCreditText(customer),
    ]
      .filter(Boolean)
      .join(" · "),
    // Days past (or until) the due date of the oldest unpaid invoice, credit term deducted.
    debtChip: !isDataError && debt > 0 ? dueChipHtml(customer.debt_summary?.oldest_due_days) : "",
    lastOrderDate,
  });
}

// The four stat tiles under the customer's facts. Each is a button: Sales ->
// the customer's orders, Outstanding debt -> payments received, Last order ->
// that order's details, Last visit -> that visit's details (handlers are
// attached in renderCustomerDetail through data-stat).
function statTilesHtml({ customer, salesThisMonth, debtText, debtDanger, debtSub = "", debtChip = "", lastOrderDate }) {
  const tile = (stat, icon, value, label, { danger = false, sub = "", disabled = false, chip = "" } = {}) => `
      <button type="button" class="detail-stat-tile detail-stat-tile-btn ${danger ? "detail-stat-danger" : ""}" data-stat="${stat}" ${disabled ? "disabled" : ""}>
        ${chip ? `<span class="detail-stat-chip">${chip}</span>` : ""}
        <span class="detail-stat-icon">${icon}</span>
        <span class="detail-stat-value">${value}</span>
        <span class="detail-stat-label">${label}</span>
        ${sub ? `<span class="detail-stat-sublabel">${sub}</span>` : ""}
      </button>`;
  return `
    <div class="detail-stat-grid">
      ${tile("sales", icons.cart, formatAmd(salesThisMonth), t("sales_this_month"))}
      ${tile("debt", icons.payment, debtText, t("outstanding_debt"), { danger: debtDanger, sub: [debtSub, lastPaymentLine(customer)].filter(Boolean).join("<br />"), chip: debtChip })}
      ${tile("last-order", icons.box, lastOrderDate ? escapeHtml(lastOrderDate) : "—", t("last_order"), { disabled: !lastOrderDate })}
      ${
        // A customer that is never visited (10001, 10002 ...: KF/CAS/CVO/PCO/OEM channels): "Last visit" means nothing there, so the tile shows
        // the last payment, date and amount, and opens the payments (owner, 2026-10-27).
        customer.requires_visit === false
          ? tile("last-payment", icons.payment, lastPaymentDate(customer) ?? "—", t("last_payment"), {
              disabled: !lastPaymentDate(customer),
              sub: customer.last_payment?.amount_amd ? formatAmd(customer.last_payment.amount_amd) : "",
            })
          : tile("last-visit", icons.clock, customer.last_visit_at ? formatDayMonth(new Date(customer.last_visit_at), { year: true }) : "—", t("last_visit"), { disabled: !customer.last_visit_at })
      }
    </div>
  `;
}

// "Last payment: 24 Oct 2026 · 199,700" under the debt (owner, 2026-10-27): payment habit next to the debt on every card. A customer that is
// never visited already shows it in its own tile, so not twice.
function lastPaymentLine(customer) {
  if (customer.requires_visit === false) return "";
  const date = lastPaymentDate(customer);
  if (!date) return "";
  const amount = customer.last_payment?.amount_amd ? ` · ${formatAmd(customer.last_payment.amount_amd)}` : "";
  return `${t("last_payment")}${labelColon()}${escapeHtml(date)}${amount}`;
}

function lastPaymentDate(customer) {
  const d = parseDateOnly(customer.last_payment?.date ?? customer.erp_last_payment_date);
  return d ? formatDayMonth(d, { year: true }) : null;
}

const returnCreditText = (customer) => (Number(customer.pending_return_credit?.amd) > 0 ? `${t("rt_credit_pending")}${labelColon()}${formatAmd(customer.pending_return_credit.amd)}` : "");

// Same four tiles as the full card. With no debt-summary row the ERP sync
// found no current debt for this customer (its customers[] list always
// includes anyone who owes), so the debt tile reads 0.
function renderErpOrdersOnlyCard(customer, erpOrders) {
  const orders = Array.isArray(erpOrders) ? erpOrders : [];
  const now = new Date();
  const salesThisMonth = orders
    .filter((o) => {
      const d = parseDateOnly(o.order_date);
      return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })
    .reduce((sum, o) => sum + Number(o.total_amd), 0);
  const lastOrderDate = parseDateOnly(customer.erp_last_order_date) ? formatDayMonth(parseDateOnly(customer.erp_last_order_date), { year: true }) : null;
  return statTilesHtml({ customer, salesThisMonth, debtText: formatAmd(0), debtDanger: false, debtSub: returnCreditText(customer), lastOrderDate });
}

function groupLinesByBrand(lines) {
  const byBrand = new Map();
  for (const line of lines) {
    const brand = line.brand || t("erp_brand_unspecified");
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  return byBrand;
}

// Payments received from this customer: the Excel Cashflow ("Oil order" rows)
// plus payments recorded in the app (pending / approved), newest first.
// Opens at once from the last copy kept on this phone and corrects itself when the fresh list lands (owner, 2026-10-26: "it loads every
// time user taps"); only the first rows are drawn until "Show more", so a customer with hundreds of payments does not freeze the sheet.
async function openPaymentsReceivedSheet(customer) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());

  const sourceBadge = (r) =>
    r.source === "excel"
      ? `<span class="badge badge-neutral">${t("payments_source_excel")}</span>`
      : `<span class="badge ${r.status === "approved" ? "badge-success" : "badge-warning"}">${t("payments_source_app")} · ${t(r.status === "approved" ? "payment_status_approved" : "payment_status_pending")}</span>`;
  let shown = FIRST_ROWS;
  let lastJson = "";
  const render = (data) => {
    const visible = data.rows.slice(0, shown);
    const hidden = data.rows.length - visible.length;
    overlay.querySelector(".sheet").innerHTML = `
    <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
    <h2>${t("payments_received_title")}</h2>
    <p class="muted">${escapeHtml(customer.name)}</p>
    ${
      data.rows.length
        ? `<div class="card erp-card payments-received-list">
            ${visible
              .map(
                (r) => `<div class="payments-received-row${r.source === "excel" ? "" : " payments-received-row-app"}">
                  <span class="payments-received-date">${escapeHtml(formatDateDMY(r.date))}</span>
                  ${sourceBadge(r)}
                  <strong class="text-amount">${formatAmd(r.amount_amd)}</strong>
                </div>`
              )
              .join("")}
            ${hidden > 0 ? `<button type="button" class="btn btn-block" data-action="show-more-payments">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
            <div class="payments-received-row payments-received-total"><span>${t("total")}</span><span></span><strong class="text-amount">${formatAmd(data.total_amd)}</strong></div>
          </div>`
        : `<p class="empty-state">${t("payments_received_empty")}</p>`
    }
    <p class="form-error" id="debt-statement-error" hidden></p>
    <div class="sheet-actions">
      ${Number(customer.erp_debt_amd) > 0 ? `<button type="button" class="btn" data-action="debt-statement">${t("debt_statement_button")}</button>` : ""}
      <button type="button" class="btn" data-action="close-sheet">${t("done")}</button>
    </div>`;
    overlay.querySelectorAll('[data-action="close-sheet"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
    overlay.querySelector('[data-action="show-more-payments"]')?.addEventListener("click", () => {
      shown = data.rows.length;
      render(data);
    });
    // Debt statement: the unpaid invoices on one page, ready to send to the customer.
    const statementBtn = overlay.querySelector('[data-action="debt-statement"]');
    statementBtn?.addEventListener("click", async () => {
      const errorEl = overlay.querySelector("#debt-statement-error");
      errorEl.hidden = true;
      statementBtn.disabled = true;
      statementBtn.textContent = t("debt_statement_creating");
      try {
        const blob = await api.buildDebtStatement(customer.id);
        openFileReadySheet(blob, `Debt-statement-${customer.erp_customer_id || customer.id}.pdf`);
      } catch (err) {
        errorEl.textContent = err.message || t("pdf_failed");
        errorEl.hidden = false;
      } finally {
        statementBtn.disabled = false;
        statementBtn.textContent = t("debt_statement_button");
      }
    });
  };
  const source = paymentsSource(customer.id);
  try {
    await loadWithCache(source.key, source.fetch, (data) => {
      if (!overlay.isConnected) return;
      const json = JSON.stringify(data);
      if (json === lastJson) return;
      lastJson = json;
      render(data);
    });
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button><p class="form-error">${escapeHtml(err.message)}</p>`;
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());
  }
}

// preview: the order's row from the list the card already holds (id, date, total), so the sheet shows its header at once and only the
// product lines wait for the network (or for the copy kept from last time).
export async function openOrderDetailSheet(customerId, orderId, preview = null) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const closeX = `<button type="button" class="icon-btn" data-action="close-order-detail" aria-label="${t("close")}">${icons.close}</button>`;
  const headHtml = (id, date, total) => `
    <div class="order-detail-header">
      <h2>${escapeHtml(id)}</h2>
      ${closeX}
    </div>
    <div class="order-detail-meta">
      <span>${escapeHtml(String(date ?? "").slice(0, 10))}</span>
      <span class="erp-debt-amount">${formatAmd(total)}</span>
    </div>`;
  const bindClose = () => overlay.querySelectorAll('[data-action="close-order-detail"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
  overlay.innerHTML = `<div class="sheet">${preview ? headHtml(preview.order_id, preview.order_date, preview.total_amd) : closeX}<p class="loading-state" role="status">${t("loading")}</p></div>`;
  bindClose();

  const render = (detail) => {
    if (!overlay.isConnected) return;
    const byBrand = groupLinesByBrand(detail.lines);
    const brandSections = [...byBrand.entries()]
      .map(
        ([brand, lines]) => `
      <p class="proposed-changes-label">${escapeHtml(brand)}</p>
      ${lines
        .map(
          (l) => `
        <div class="erp-line-row">
          <span>${escapeHtml(l.product_name || "")}${l.size_l ? ` ${escapeHtml(String(l.size_l))}L` : ""}</span>
          <span class="muted">${escapeHtml(String(l.qty ?? ""))}pcs</span>
          <span>${formatAmd(l.unit_price_amd)}</span>
        </div>
        ${erpLineDiscountRowHtml(l)}`
        )
        .join("")}`
      )
      .join("");
    overlay.querySelector(".sheet").innerHTML = `
    ${headHtml(detail.order_id, detail.order_date, detail.total_amd)}
    ${brandSections}
    <div class="sheet-actions"><button type="button" class="btn btn-primary" id="reorder-erp-order">${t("reorder_btn")}</button></div>
  `;
    bindClose();
    overlay.querySelector("#reorder-erp-order").addEventListener("click", () => {
      leaveSheetTo(overlay, (h) => (location.hash = h), reorderHash(customerId, `erp:${orderId}`));
    });
  };
  const source = orderDetailSource(customerId, orderId);
  let lastJson = "";
  try {
    await loadWithCache(source.key, source.fetch, (detail) => {
      const json = JSON.stringify(detail);
      if (json === lastJson) return;
      lastJson = json;
      render(detail);
    });
  } catch (err) {
    if (overlay.isConnected) {
      overlay.querySelector(".sheet").innerHTML = `${closeX}<p class="form-error">${escapeHtml(err.message)}</p>`;
      bindClose();
    }
  }
}

function renderPendingRequest(slot, request, onDone) {
  if (!request) {
    slot.innerHTML = "";
    return;
  }

  if (isAdmin()) {
    const changesList = Object.entries(request.changes)
      .map(([field, value]) => `<div class="proposed-change"><strong>${escapeHtml(t(field))}</strong>: ${escapeHtml(String(value))}</div>`)
      .join("");
    slot.innerHTML = `
      <div class="card pending-request-card">
        <div class="pending-request-header">
          <span class="badge badge-accent">${t("review")}</span>
          <span class="muted">${t("requested_by")} ${escapeHtml(request.requested_by_name)}</span>
        </div>
        <p class="proposed-changes-label">${t("proposed_changes")}</p>
        ${changesList}
        <div class="sheet-actions">
          <button class="btn" id="reject-request-btn">${t("reject")}</button>
          <button class="btn btn-primary" id="approve-request-btn">${t("approve")}</button>
        </div>
      </div>
    `;
    slot.querySelector("#approve-request-btn").addEventListener("click", async () => {
      await api.reviewEditRequest(request.id, "approve");
      window.dispatchEvent(new Event("edit-requests-changed"));
      onDone();
    });
    slot.querySelector("#reject-request-btn").addEventListener("click", async () => {
      await api.reviewEditRequest(request.id, "reject");
      window.dispatchEvent(new Event("edit-requests-changed"));
      onDone();
    });
  } else {
    slot.innerHTML = `
      <div class="card pending-request-card pending-request-card-quiet">
        <span class="badge badge-neutral">${t("pending_edit_request")}</span>
      </div>
    `;
  }
}

// Item 8 -- one consolidated "Account settings" sheet standing in for what
// used to be three separate overflow-menu entries (Assigned manager / ERP
// customer ID / Payment settings). Each section below only renders for a
// viewer who's actually allowed to touch it (same gates the three old
// buttons used), so this can render with anywhere from one section to all
// three.
//
// IMPORTANT: this still issues UP TO THREE separate PATCH /customers/:id
// calls on Save, one per section that's present -- never one combined call.
// The server's PATCH handler authorizes a request by asking "is every field
// in this body one this role may touch as a group" (canReassignCustomers
// for region/subregion/sales_channel/assigned_manager_id as a set,
// seesFinancialExports for payment_method/credit_term_days as a set,
// canAssignErpCustomerId for erp_customer_id alone) -- a request mixing
// fields from more than one of those groups falls through to an
// admin-only check instead, which would 403 a sales_director who is
// legitimately allowed to reassign but isn't an admin. Keeping the field
// groups in separate requests is what makes each section's own permission
// gate the one that actually applies.
async function openAccountSettingsSheet(customer, onDone) {
  const showReassign = canReassignCustomers();
  const showErp = canAssignErpCustomerId(customer);
  const showPayment = seesFinancialExports();
  // Sales channel alone (not region/subregion/manager) is also open to a
  // sales_manager on a customer they created -- showReassign already covers
  // it for admin/director/ceo, so this only adds the standalone section for
  // that narrower case.
  const showChannelOnly = !showReassign && canEditOwnSalesChannel(customer);

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("account_settings")}</h2>
      <form id="account-settings-form">
        ${
          showReassign
            ? `<p class="proposed-changes-label">${t("assigned_manager")}</p>
               <label>${t("region")}
                 <select name="region" id="reassign-region">
                   <option value="">${t("select_placeholder")}</option>
                   ${REGION_LIST.map(
                     (r) => `<option value="${escapeHtml(r)}" ${r === customer.region ? "selected" : ""}>${escapeHtml(regionLabelHy(r))}</option>`
                   ).join("")}
                 </select>
               </label>
               <label id="reassign-subregion-wrap">${t("subregion")}<input name="subregion" id="reassign-subregion" value="${escapeHtml(customer.subregion ?? "")}" /></label>
               <label>${t("sales_channel")}
                 <select name="sales_channel">
                   <option value="">${t("select_placeholder")}</option>
                   ${SALES_CHANNELS.map(
                     (c) => `<option value="${escapeHtml(c)}" ${c === customer.sales_channel ? "selected" : ""}>${escapeHtml(c)}</option>`
                   ).join("")}
                 </select>
               </label>
               <label>${t("assigned_manager")}
                 <select name="assigned_manager_id" id="reassign-manager">
                   <option value="">${t("unassigned")}</option>
                 </select>
               </label>`
            : ""
        }
        ${
          showChannelOnly
            ? `<p class="proposed-changes-label">${t("sales_channel")}</p>
               <label><span class="visually-hidden">${t("sales_channel")}</span>
                 <select name="sales_channel">
                   <option value="">${t("select_placeholder")}</option>
                   ${SALES_CHANNELS.map(
                     (c) => `<option value="${escapeHtml(c)}" ${c === customer.sales_channel ? "selected" : ""}>${escapeHtml(c)}</option>`
                   ).join("")}
                 </select>
               </label>`
            : ""
        }
        ${
          showErp
            ? `<p class="proposed-changes-label">${t("erp_customer_id")}</p>
               <label class="erp-suggest-wrap"><span class="visually-hidden">${t("erp_customer_id")}</span>
                 <input type="text" name="erp_customer_id" value="${escapeHtml(customer.erp_customer_id ?? "")}" id="erp-customer-input" autocomplete="off" />
                 <div class="erp-suggest-list" id="erp-suggest-list" hidden></div>
               </label>`
            : ""
        }
        ${
          showPayment
            ? `<p class="proposed-changes-label">${t("payment_settings")}</p>
               <label>${t("payment_method_label")}
                 <select name="payment_method">
                   <option value="invoice" ${customer.payment_method !== "cash" ? "selected" : ""}>${t("payment_method_invoice")}</option>
                   <option value="cash" ${customer.payment_method === "cash" ? "selected" : ""}>${t("payment_method_cash")}</option>
                 </select>
               </label>
               <label>${t("credit_term_days_label")}
                 <input type="number" name="credit_term_days" min="1" step="1" value="${customer.credit_term_days ?? 45}" />
               </label>
               <label>${t("credit_limit_label")} (${t("credit_limit_hint")})
                 <input type="number" name="credit_limit_amd" min="0" step="1" inputmode="numeric" value="${customer.credit_limit_amd != null ? Math.round(Number(customer.credit_limit_amd)) : ""}" placeholder="${t("credit_limit_none")}" />
               </label>
               <div id="credit-history" class="muted" style="font-size:0.85em;margin:-4px 0 8px"></div>
               ${
                 customer.erp_balance0_amd != null
                   ? `<div class="readonly-field" id="opening-balance-field">
                        <span class="readonly-field-label">${t("opening_balance_label")}<button type="button" class="readonly-info-btn" id="opening-info-btn" aria-label="${t("opening_balance_hint")}" aria-expanded="false">${icons.info}</button></span>
                        <strong class="readonly-field-value ${Number(customer.erp_balance0_amd) < 0 ? "readonly-field-credit" : ""}">${formatAmd(customer.erp_balance0_amd)}${Number(customer.erp_balance0_amd) < 0 ? ` · ${t("opening_balance_credit")}` : ""}</strong>
                      </div>
                      <p class="muted" id="opening-info-text" style="font-size:0.85em;margin:2px 0 8px" hidden>${t("opening_balance_hint")}</p>`
                   : ""
               }`
            : ""
        }
        ${
          customer.customer_tier === "gold" && canSetCustomerPrices()
            ? `<button type="button" class="btn btn-block" id="open-special-prices">${t("sp_open_btn")} ›</button>`
            : ""
        }
        <p class="form-error" id="account-settings-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-account-settings">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  // Who changed the credit limit and when (last 3 changes).
  overlay.querySelector("#opening-info-btn")?.addEventListener("click", (e) => {
    const text = overlay.querySelector("#opening-info-text");
    text.hidden = !text.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!text.hidden));
  });
  const historyEl = overlay.querySelector("#credit-history");
  if (historyEl) {
    api
      .getCreditHistory(customer.id)
      .then((rows) => {
        historyEl.innerHTML = rows
          .slice(0, 3)
          .map((r) => `${r.old_limit == null ? "—" : formatAmd(r.old_limit)} → ${r.new_limit == null ? t("credit_limit_none") : formatAmd(r.new_limit)} · ${escapeHtml(r.changed_by_name || "")} · ${formatDateTime(r.changed_at)}`)
          .join("<br>");
      })
      .catch(() => {});
  }

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-account-settings").addEventListener("click", close);
  overlay.querySelector("#open-special-prices")?.addEventListener("click", () => {
    close();
    location.hash = `#/customers/${customer.id}/special-prices`;
  });
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  if (showReassign) {
    const regionSelect = overlay.querySelector("#reassign-region");
    const subregionWrap = overlay.querySelector("#reassign-subregion-wrap");
    function renderSubregionField(region, value) {
      if (region === "Yerevan") {
        subregionWrap.innerHTML = `${t("subregion")}
          <select name="subregion" id="reassign-subregion">
            <option value="">${t("select_placeholder")}</option>
            ${YEREVAN_DISTRICTS.map(
              (d) => `<option value="${escapeHtml(d)}" ${d === value ? "selected" : ""}>${escapeHtml(subregionLabelHy(d))}</option>`
            ).join("")}
          </select>`;
      } else {
        subregionWrap.innerHTML = `${t("subregion")}<input name="subregion" id="reassign-subregion" value="${escapeHtml(value ?? "")}" />`;
        wirePlaceInput(subregionWrap.querySelector("#reassign-subregion"), () => regionSelect.value);
      }
    }
    if (customer.region === "Yerevan") renderSubregionField("Yerevan", customer.subregion);
    else wirePlaceInput(overlay.querySelector("#reassign-subregion"), () => regionSelect.value);
    regionSelect.addEventListener("change", () => renderSubregionField(regionSelect.value, ""));

    const managerSelect = overlay.querySelector("#reassign-manager");
    // Changing the sales channel sets the rep to that channel's owner (Settings > Sales channel owners); the rep stays editable by hand
    // afterwards (owner, 2026-10-24). A channel without an owner leaves the rep as it is.
    const channelSelect = overlay.querySelector('select[name="sales_channel"]');
    let channelOwners = new Map();
    let ownerWanted = null; // chosen before the manager list arrived
    const applyChannelOwner = () => {
      const ownerId = channelOwners.get(channelSelect.value);
      if (!ownerId) return;
      if (![...managerSelect.options].some((o) => Number(o.value) === Number(ownerId))) {
        ownerWanted = Number(ownerId);
        return;
      }
      ownerWanted = null;
      managerSelect.value = String(ownerId);
      managerSelect.classList.remove("field-auto-set");
      void managerSelect.offsetWidth; // restart the highlight
      managerSelect.classList.add("field-auto-set");
    };
    api
      .getPerfChannels()
      .then((channels) => (channelOwners = new Map(channels.filter((c) => c.manager_user_id).map((c) => [c.code, c.manager_user_id]))))
      .catch(() => {});
    channelSelect.addEventListener("change", applyChannelOwner);
    managerSelect.addEventListener("change", () => {
      ownerWanted = null;
      managerSelect.classList.remove("field-auto-set");
    });
    api
      .listAssignableManagers()
      .then((users) => {
        managerSelect.innerHTML =
          `<option value="">${t("unassigned")}</option>` +
          users
            .map((u) => {
              const label = u.role === "sales_director" ? `${u.name} (${t("role_sales_director")})` : u.name;
              return `<option value="${u.id}" ${u.id === customer.assigned_manager_id ? "selected" : ""}>${escapeHtml(label)}</option>`;
            })
            .join("");
        if (ownerWanted) applyChannelOwner();
      })
      .catch(() => {});
  }

  if (showErp) {
    const erpInput = overlay.querySelector("#erp-customer-input");
    const erpSuggestList = overlay.querySelector("#erp-suggest-list");
    let erpOptions = [];
    api
      .getUnlinkedErpCustomers()
      .then((results) => {
        // Sort A-Z by name client-side too -- relying only on the server's
        // ORDER BY isn't enough since the browser's own native datalist
        // (what this replaces) silently ignored it; keep the sort explicit
        // and visible here so it can't regress the same way again.
        erpOptions = [...results].sort((a, b) =>
          (a.customer_name || "").localeCompare(b.customer_name || "", undefined, { sensitivity: "base" })
        );
      })
      .catch(() => {});

    function renderSuggestions(query) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? erpOptions.filter((r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q))
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

    erpInput.addEventListener("focus", () => renderSuggestions(erpInput.value));
    erpInput.addEventListener("input", () => renderSuggestions(erpInput.value));
    erpInput.addEventListener("blur", () => {
      // A delay, not immediate hide, so the suggestion's own click handler
      // (mousedown fires first, but click needs the element still present)
      // gets a chance to run before the list disappears.
      setTimeout(() => (erpSuggestList.hidden = true), 150);
    });
    activateCombobox(erpInput, erpSuggestList, (item) => {
      erpInput.value = item.dataset.id;
    });
  }

  const form = overlay.querySelector("#account-settings-form");
  const errorEl = overlay.querySelector("#account-settings-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = t("saving");

    // Each section below touches a disjoint set of columns and is its own
    // PATCH, so one section failing (e.g. a duplicate ERP ID) never rolls
    // back another's already-committed write -- but Promise.all used to
    // reject the whole submit the instant any one call failed, leaving the
    // sheet open on its original (pre-save) data with nothing but a small
    // error line to say why. That made a *successful* reassignment (region/
    // sales channel/manager) look like it silently didn't save whenever a
    // different section on the same form failed. allSettled + always
    // refreshing the page behind the sheet means whatever did commit is
    // visible immediately, and only the failed section blocks the sheet
    // from closing.
    const sections = [];
    if (showReassign) {
      sections.push({
        label: t("assigned_manager"),
        promise: api.updateCustomer(customer.id, {
          region: data.get("region") || null,
          subregion: data.get("subregion") || null,
          sales_channel: data.get("sales_channel") || null,
          assigned_manager_id: data.get("assigned_manager_id") ? Number(data.get("assigned_manager_id")) : null,
        }),
      });
    }
    if (showChannelOnly) {
      sections.push({
        label: t("sales_channel"),
        promise: api.updateCustomer(customer.id, { sales_channel: data.get("sales_channel") || null }),
      });
    }
    if (showErp) {
      const erpInput = overlay.querySelector("#erp-customer-input");
      sections.push({
        label: t("erp_customer_id"),
        promise: api.updateCustomer(customer.id, { erp_customer_id: erpInput.value.trim() || null }),
      });
    }
    if (showPayment) {
      sections.push({
        label: t("payment_settings"),
        promise: api.updateCustomer(customer.id, {
          payment_method: data.get("payment_method"),
          // A stored credit_term_days of 0 would otherwise round-trip back
          // into the number input's value, which fails its own min="1"
          // client-side validation and silently blocks the whole submit --
          // clamp it here instead of trusting whatever was last stored.
          credit_term_days: Math.max(1, Number(data.get("credit_term_days")) || 45),
        }),
      });
      // The credit limit has its own endpoint (accountant + directors); empty = no limit.
      const limitRaw = String(data.get("credit_limit_amd") ?? "").trim();
      sections.push({
        label: t("credit_limit_label"),
        promise: api.setCreditLimit(customer.id, limitRaw === "" ? null : Number(limitRaw)),
      });
    }

    const results = await Promise.allSettled(sections.map((s) => s.promise));
    const failures = results
      .map((r, i) => (r.status === "rejected" ? `${sections[i].label}: ${r.reason.body?.code === "erp_id_assigned" ? t("erp_id_assigned").replace("{name}", r.reason.body.assigned_manager_name) : r.reason.message}` : null))
      .filter(Boolean);

    // Refresh the page underneath regardless -- some or all sections may
    // have committed even if others failed.
    onDone();
    // what the server did with the typed region / subregion (spelling corrected, or not in the list of places and sent for review)
    const placeText = placeNoticeText(results.map((r) => (r.status === "fulfilled" ? r.value?.place_notice : null)).find(Boolean));
    if (placeText) showToast(placeText, { ms: 6500 });

    if (failures.length) {
      errorEl.textContent = failures.join(" · ");
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = t("save");
    } else {
      close();
    }
  });
}

// "Files" of one customer (owner, 2026-10-26): Photos (everything captured at check-ins, newest first) and Documents (signed accounting
// documents today; payment slips and order blanks join them). Photos show small copies in a grid and open full size in the lightbox.
async function openCustomerFiles(customer) {
  const customerId = customer.id;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet customer-files-sheet">
      <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("customer_files")}</h2>
      <p class="muted">${escapeHtml(customer.name)}</p>
      <h3 class="list-group-heading">${t("files_photos")}<span class="muted" id="files-photos-count"></span></h3>
      <div id="customer-photo-gallery-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <h3 class="list-group-heading">${t("files_documents")}<span class="muted" id="files-docs-count"></span></h3>
      <div id="customer-documents-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", () => overlay.remove());

  const body = overlay.querySelector("#customer-photo-gallery-body");
  let shown = FIRST_PHOTOS;
  let lastJson = "";
  const renderPhotos = (photos) => {
    overlay.querySelector("#files-photos-count").textContent = photos.length ? ` · ${photos.length}` : "";
    if (!photos.length) {
      body.innerHTML = `<p class="empty-state">${t("no_photos_yet")}</p>`;
      return;
    }
    const urls = photos.map((p) => api.checkinPhotoByIdUrl(p.id));
    const visible = photos.slice(0, shown);
    const hidden = photos.length - visible.length;
    body.innerHTML = `
      <div class="checkin-photo-grid">
        ${visible
          .map(
            (p, i) => `
        <div class="checkin-photo-wrap">
          <img class="checkin-photo" data-photo-index="${i}" src="${api.checkinPhotoThumbUrl(p.id)}" alt="${t("photo_optional")}" loading="lazy" decoding="async" />
        </div>`
          )
          .join("")}
      </div>
      ${hidden > 0 ? `<button type="button" class="btn btn-block" id="more-photos-btn">${t("show_more_n").replace("{n}", hidden)}</button>` : ""}
    `;
    body.querySelectorAll(".checkin-photo").forEach((img) => {
      img.addEventListener("click", () => openPhotoLightbox(urls, Number(img.dataset.photoIndex)));
    });
    body.querySelector("#more-photos-btn")?.addEventListener("click", () => {
      shown = photos.length;
      renderPhotos(photos);
    });
  };
  const photoSource = photosSource(customerId);
  loadWithCache(photoSource.key, photoSource.fetch, (photos) => {
    if (!overlay.isConnected) return;
    const json = JSON.stringify(photos);
    if (json === lastJson) return;
    lastJson = json;
    renderPhotos(photos);
  }).catch((err) => {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  });

  // Documents: the signed order blanks photographed at deliveries, then the signed accounting documents (from Lily).
  const docsBody = overlay.querySelector("#customer-documents-body");
  const loadDocuments = async () => {
    try {
      const [docs, files] = await Promise.all([api.listCustomerDocuments(customerId), api.customerFiles(customerId).catch(() => [])]);
      if (!overlay.isConnected) return;
      overlay.querySelector("#files-docs-count").textContent = docs.length + files.length ? ` · ${docs.length + files.length}` : "";
      const acc = docs.length ? await import("../accountingFiles.js") : null;
      docsBody.innerHTML = `
        ${
          files.length
            ? `<div class="files-blank-grid">
                 ${files
                   .map(
                     (f, i) => `
                   <button type="button" class="files-blank" data-file-index="${i}">
                     ${f.mime === "application/pdf" ? `<span class="files-blank-pdf">PDF</span>` : `<img src="${api.fileUrl(f, { thumb: true })}" alt="${escapeHtml(fileKindLabel(f.kind))}" loading="lazy" decoding="async" />`}
                     <span class="files-blank-cap"><strong>${escapeHtml(fileKindLabel(f.kind))}</strong><br />${escapeHtml(formatDateDMY(f.created_at))}${f.order_codes?.length ? ` · ${escapeHtml(f.order_codes.join(", "))}` : ""}</span>
                   </button>`
                   )
                   .join("")}
               </div>`
            : ""
        }
        ${docs.length ? `<div class="acc-docs">${acc.documentRowsHtml(docs)}</div>` : ""}
        ${!files.length && !docs.length ? `<p class="empty-state">${t("files_documents_empty")}</p>` : ""}
        ${canAddFiles() ? `<button type="button" class="btn btn-block btn-has-icon" id="add-document-btn">${icons.plus}${t("add_document")}</button>` : ""}`;
      docsBody.querySelectorAll(".files-blank").forEach((btn) => btn.addEventListener("click", () => openFileViewer(files, Number(btn.dataset.fileIndex), { onChanged: loadDocuments })));
      docsBody.querySelector("#add-document-btn")?.addEventListener("click", () => openAddFileSheet({ customer, onAdded: loadDocuments }));
      if (acc) acc.bindDocumentRows(docsBody);
    } catch (err) {
      docsBody.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  };
  await loadDocuments();
}

// Item 8 -- the core customer-fields form, merged with the "Edit contact &
// social profiles" sheet (a very recent addition) as one section at the
// bottom of the same form/sheet, rather than two separate entry points.
// That section only appears once the social data has loaded AND says this
// viewer may edit it (fetchCustomerSocial's can_edit) -- it's fetched here,
// independently of customerSocialProfiles.js's own decoration of the
// header's one-tap links, so this sheet can open immediately without
// waiting on that module's timing.
async function openEditSheet(customer, navigate, onDone) {
  const fields = EDIT_FIELDS;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${canEditDirectly() ? t("edit_customer") : t("request_edit")}</h2>
      <form id="edit-customer-form">
        ${tierSelectorHtml(customer.customer_tier || "potential")}
        ${categorySelectorHtml(customer.category || "")}
        ${fields.filter((f) => f.type !== "select").map((f) => {
          // A phone field with nothing saved yet starts pre-filled with the
          // country code -- one less thing for a manager to type on every
          // new customer -- but an already-saved number is shown formatted
          // as-is, not silently rewritten under them.
          const rawValue = f.name === "phone" && !customer[f.name] ? "+374 " : customer[f.name] ?? "";
          const value = escapeHtml(f.name === "phone" && customer[f.name] ? formatPhoneDisplay(customer[f.name]) : rawValue);
          if (f.type === "textarea") {
            return `<label>${t(f.labelKey)}<textarea name="${f.name}" rows="2">${value}</textarea></label>`;
          }
          if (f.name === "visit_frequency_days") {
            // Following the type default: shown empty with the default as the hint; typing a number makes it this customer's own.
            const own = customer.visit_frequency_manual !== false;
            return `<label>${t(f.labelKey)}<input type="number" min="1" max="365" name="${f.name}" value="${own ? value : ""}" placeholder="${escapeHtml(t("visit_frequency_type_default").replace("{n}", customer.visit_frequency_days ?? ""))}" /></label>`;
          }
          return `<label>${t(f.labelKey)}<input type="${f.type}" name="${f.name}" value="${value}" /></label>`;
        }).join("")}
        <p class="muted tin-lookup-status" id="tin-lookup-status" role="status" hidden></p>
        <div id="edit-social-section"></div>
        <p class="form-error" id="edit-customer-error" hidden></p>
      </form>
      <div class="edit-sheet-danger-zone">
        <button type="button" class="btn-link" id="change-location-btn">${icons.pin}${t("change_location")}</button>
        ${
          isAdmin()
            ? `<button type="button" class="btn-link btn-link-danger btn-has-icon" id="delete-customer-btn">${icons.trash}${t("delete_customer")}</button>`
            : ""
        }
      </div>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" id="cancel-edit-customer">${t("cancel")}</button>
        <button type="submit" form="edit-customer-form" id="submit-edit-customer" class="btn btn-primary">${canEditDirectly() ? t("save") : t("submit_request")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  activateTierSelector(overlay);
  activateCategorySelector(overlay);

  let socialData = null;
  fetchCustomerSocial(customer.id)
    .then((data) => {
      if (!overlay.isConnected || !data.can_edit) return;
      socialData = data;
      overlay.querySelector("#edit-social-section").innerHTML = socialFieldsHtml(data);
    })
    .catch(() => {});

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-edit-customer").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#change-location-btn").addEventListener("click", () => {
    close();
    navigate(`#/map?relocate=${customer.id}`);
  });
  overlay.querySelector("#delete-customer-btn")?.addEventListener("click", async () => {
    if (!confirm(t("confirm_delete_customer"))) return;
    try {
      await api.deleteCustomer(customer.id);
      close();
      navigate("#/customers");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  const form = overlay.querySelector("#edit-customer-form");
  const errorEl = overlay.querySelector("#edit-customer-error");

  // Legal name / address come from the state register, found by TIN: filled
  // automatically once an 8-digit TIN is entered (never over something the rep
  // already typed), with the fields staying editable if the lookup fails.
  const tinInput = form.querySelector('[name="tin"]');
  const legalNameInput = form.querySelector('[name="legal_name"]');
  const legalAddressInput = form.querySelector('[name="legal_address"]');
  const tinStatus = overlay.querySelector("#tin-lookup-status");
  let lastLookedUp = (customer.tin || "").trim();
  async function lookupLegalInfo() {
    const tin = tinInput.value.trim();
    if (!/^\d{8}$/.test(tin) || tin === lastLookedUp) return;
    lastLookedUp = tin;
    tinStatus.hidden = false;
    tinStatus.textContent = t("tin_lookup_loading");
    try {
      const result = await api.lookupTin(tin);
      if (!overlay.isConnected || tinInput.value.trim() !== tin) return;
      if (result.found) {
        if (result.legal_name && !legalNameInput.value.trim()) legalNameInput.value = result.legal_name;
        if (result.legal_address && !legalAddressInput.value.trim()) legalAddressInput.value = result.legal_address;
        tinStatus.textContent = t("tin_lookup_filled");
      } else {
        tinStatus.textContent = t("tin_lookup_failed");
      }
    } catch {
      tinStatus.textContent = t("tin_lookup_failed");
    }
  }
  tinInput.addEventListener("change", lookupLegalInfo);
  tinInput.addEventListener("input", () => {
    if (/^\d{8}$/.test(tinInput.value.trim())) lookupLegalInfo();
  });
  // A TIN that is already saved but has no legal info yet: look it up on open.
  if (/^\d{8}$/.test(lastLookedUp) && !customer.legal_name && !customer.legal_address) {
    lastLookedUp = "";
    lookupLegalInfo();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    // Bronze / Silver / Gold need the ERP customer ID (the server refuses otherwise); say it before the round trip.
    if (["bronze", "silver", "gold"].includes(data.get("customer_tier")) && data.get("customer_tier") !== customer.customer_tier && !customer.erp_customer_id) {
      errorEl.textContent = t("erp_id_required");
      errorEl.hidden = false;
      return;
    }
    const changes = { customer_tier: data.get("customer_tier") };
    for (const f of fields) {
      const raw = data.get(f.name);
      if (f.name === "phone") {
        // Bare "+374" (just the pre-filled prefix, nothing typed after it)
        // means the manager left it empty -- save null, not a phone number
        // that's only a country code.
        const digits = normalizePhone(raw);
        changes.phone = digits.length > 3 ? `+${digits}` : null;
      } else {
        // An empty "Visit every N days" = the default of the customer's type (Settings > Sales & customers).
        changes[f.name] = f.name === "visit_frequency_days" && String(raw ?? "").trim() === "" ? null : f.type === "number" ? Number(raw) : raw;
      }
    }

    // Save now lives outside <form> (see .sheet-actions-floating -- it's a
    // sticky footer with the delete/change-location links above it, so the
    // form itself is only the scrollable field content) and is linked back
    // by form="edit-customer-form" alone, so form.querySelector() can't
    // find it -- it's associated with the form, not a descendant of it.
    const submitBtn = overlay.querySelector("#submit-edit-customer");
    submitBtn.disabled = true;
    try {
      const calls = [canEditDirectly() ? api.updateCustomer(customer.id, changes) : api.createEditRequest(customer.id, changes)];
      // The social section only exists once fetchCustomerSocial resolved
      // with can_edit -- if the sheet was submitted before that finished
      // (or the viewer isn't allowed to edit it at all), there's nothing
      // to save here, same as before this merge.
      if (socialData) calls.push(saveCustomerSocial(customer.id, collectSocialPayload(form)));
      await Promise.all(calls);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}
