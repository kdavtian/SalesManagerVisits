import { api } from "../api.js";
import { layoutCustomerWide, wideCard } from "../customerWide.js";
import { escapeHtml, formatDateTime, formatAmd, formatPhoneDisplay, openNavigation, tierBadgeHtml, categoryLabel, customerListIconHtml, regionLabelHy, subregionLabelHy, channelDisplayLabel, labelColon, showToast, openInfoPopup } from "../util.js";
import { currentChips, chipHtml, chipSections } from "../brandChips.js";
import { nextVisitRowHtml } from "../visitSchedule.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state, canCreateTasks, sendsRequests, canReassignCustomers, canAssignErpCustomerId, canEditOwnSalesChannel, seesFinancialExports } from "../state.js";
import { reviewsPlaces } from "../shared/roles.js";
import { openVisitDetailSheet, checkinOutcomeLabels } from "../visitDetail.js";
import { visitStatusBadge } from "./customers.js";
import { renderPotentialCard, potentialBadgeHtml } from "../potential.js";
import { openOrderMenu } from "../orderMenu.js";
import { bindStepperButton } from "../stepper.js";
import { warmCache, peekCache, refreshCache } from "../listCache.js";
import { cardSource, fetchedJustNow, isWholeBundle, lateParts, VISITS_PAGE } from "../customerCardLoader.js";
import { paymentsSource, allOrdersSource, orderDetailSource } from "../customerCardData.js";
import { socialLinksHtml, bindSocialLinks } from "./customer/social.js";
import { openAccountSettingsSheet } from "./customer/accountSettings.js";
import { openEditSheet } from "./customer/editSheet.js";
import { openCustomerFiles } from "./customer/files.js";
import { renderErpCard } from "./customer/erpCard.js";
import { openPaymentsReceivedSheet, openOrderDetailSheet, renderPendingRequest } from "./customer/sheets.js";
export { openOrderDetailSheet } from "./customer/sheets.js";

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
  // external links (Instagram/Facebook/email/website, see
  // customer/social.js) stay alongside them -- those just hand off
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
           the card fills the left slot (customer/social.js socialLinksHtml) -- left empty (zero width, so space-between still pins
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
              .join(" &middot; ")}</span>${customer.place_review_pending && reviewsPlaces(state.user.role) ? ` <span class="badge badge-warning">${t("place_to_review")}</span>` : ""}</div>`
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
      ${canCreateTasks() ? `<button type="button" class="action-btn" id="new-task-btn"><span>${icons.tasks}</span>${t(sendsRequests() ? "request_new" : "task_new")}</button>` : ""}
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
  const socialSlot = container.querySelector(".detail-facts-card-actions-social");
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
  // With a mouse (desktop roadmap step 9) a long press is awkward: a right-click opens the same menu.
  const mouse = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (mouse) {
    container.querySelector("#new-order-btn")?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      try {
        localStorage.setItem("fieldvisits_om_hint", "1");
      } catch {
        /* ignore */
      }
      openOrderMenu({ customer, navigate });
    });
  }
  // One-time tip so the long press (right-click with a mouse) is found: shown once, never over an open sheet, and not at all for someone
  // who has already opened the menu.
  setTimeout(() => {
    try {
      if (localStorage.getItem("fieldvisits_om_hint") || document.querySelector(".sheet-overlay") || !container.isConnected) return;
      localStorage.setItem("fieldvisits_om_hint", "1");
      showToast(t(mouse ? "om_hint_desk" : "om_hint"), { ms: 6000 });
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

  layoutCustomerWide(container, {
    customer,
    erpOrders,
    navigate,
    openPayments: () => openPaymentsReceivedSheet(customer),
    openFiles: () => openCustomerFiles(customer),
    openErpOrder: (row) => openOrderDetailSheet(customerId, row.order_id, row),
    openAppOrder: async (id) => (await import("../orderDetailSheet.js")).openOrderDetailSheet(id, { navigate }),
  });

  const historyEl = container.querySelector("#checkin-history");
  const openVisit = (index) =>
    openVisitDetailSheet(checkins[index], reload, navigate);
  // A compact, tappable row per visit -- the full detail (badges, brand
  // tags, note, photos) used to be rendered inline for every single visit
  // at once, which made a customer with a long history nearly unusable to
  // scroll through. Tapping a row opens everything in its own sheet.
  // A wide desktop card (customerWide.js) has a whole column for the history: every visit, each with what happened.
  const wide = wideCard(container);
  const outcomesText = (ch) => checkinOutcomeLabels(ch).join(", ");
  const visitRowHtml = (ch, i) => `
        <button type="button" class="card checkin-row" data-checkin-index="${i}">
          <div class="checkin-row-main">
            <strong>${escapeHtml(ch.user_name)}</strong>
            <span class="muted">${formatDateTime(ch.timestamp)}</span>
            ${wide && outcomesText(ch) ? `<span class="checkin-row-outcomes">${escapeHtml(outcomesText(ch))}${ch.amount_collected_amd != null ? ` · ${formatAmd(Number(ch.amount_collected_amd))}` : ""}</span>` : ""}
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
      const moreBtn = historyEl.querySelector("#more-visits-btn");
      if (moreBtn && wide) queueMicrotask(() => moreBtn.click());
      moreBtn?.addEventListener("click", async (e) => {
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

