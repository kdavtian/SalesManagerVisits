// Customer card > account settings sheet (moved out of customerDetail.js with the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { dockSheet } from "../../dockSheet.js";
import { REGION_LIST, SALES_CHANNELS, YEREVAN_DISTRICTS, activateCombobox, activateDialog, escapeHtml, formatAmd, formatDateTime, regionLabelHy, showToast, subregionLabelHy } from "../../util.js";
import { placeNoticeText, wirePlaceInput } from "../../places.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { canAssignErpCustomerId, canEditOwnSalesChannel, canReassignCustomers, canSetCustomerPrices, seesFinancialExports } from "../../state.js";

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
export async function openAccountSettingsSheet(customer, onDone) {
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
  dockSheet(overlay, `customer-account:${customer.id}`);
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
