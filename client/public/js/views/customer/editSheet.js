// Customer card > edit sheet (moved out of customerDetail.js with the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { dockSheet } from "../../dockSheet.js";
import { activateCategorySelector, activateDialog, activateTierSelector, categorySelectorHtml, escapeHtml, formatPhoneDisplay, normalizePhone, tierSelectorHtml } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { canEditDirectly, isAdmin } from "../../state.js";
import { collectSocialPayload, fetchCustomerSocial, saveCustomerSocial, socialFieldsHtml } from "./social.js";

export const EDIT_FIELDS = [
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

// Item 8 -- the core customer-fields form, merged with the "Edit contact &
// social profiles" sheet (a very recent addition) as one section at the
// bottom of the same form/sheet, rather than two separate entry points.
// That section only appears once the social data has loaded AND says this
// viewer may edit it (fetchCustomerSocial's can_edit) -- it's fetched here,
// independently of the card's own one-tap links, so this sheet can open
// immediately without waiting on them.
export async function openEditSheet(customer, navigate, onDone) {
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
  dockSheet(overlay, `customer-edit:${customer.id}`);
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
