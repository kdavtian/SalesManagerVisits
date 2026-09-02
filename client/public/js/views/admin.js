import { api } from "../api.js";
import { activateDialog, escapeHtml, formatDateTime, formatAmd, compressImage } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

// Real territory/channel names from the Castrol sales data (see
// work/build_sales_director_data.py's CHANNEL_ORDER in the castrol_ceo_report
// repo) -- offered as suggestions, but the field stays free text since new
// territories get added over time (e.g. "SM YVN3").
const POSITION_SUGGESTIONS = ["SM YVN", "SM Davtashen", "SM CAS", "SM Shirak", "SM B2B"];

const ROLE_BADGE = {
  admin: { key: "role_admin", cls: "badge-accent" },
  ceo: { key: "role_ceo", cls: "badge-accent" },
  sales_manager: { key: "role_sales_manager", cls: "badge-neutral" },
  sales_director: { key: "role_sales_director", cls: "badge-info" },
  warehouse_manager: { key: "role_warehouse_manager", cls: "badge-info" },
  delivery_manager: { key: "role_delivery_manager", cls: "badge-info" },
  accountant: { key: "role_accountant", cls: "badge-info" },
};

export async function renderTeamSection(container) {
  container.innerHTML = `
    <div id="user-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap">
      <button type="button" class="btn btn-block" id="add-team-member-btn">+ ${t("add_team_member")}</button>
    </div>
  `;

  const listEl = container.querySelector("#user-list");

  async function loadUsers() {
    const users = await api.listUsers();
    listEl.innerHTML = users
      .map((u) => {
        const roleBadge = ROLE_BADGE[u.role] ?? { key: "role_sales_manager", cls: "badge-neutral" };
        return `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(u.name)}</strong>
              <span class="muted">${escapeHtml(u.email)}${u.position ? ` · ${escapeHtml(u.position)}` : ""}</span>
            </div>
            <span class="badge ${roleBadge.cls}">${t(roleBadge.key)}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">${formatDateTime(u.created_at)}</span>
            <span class="user-row-actions">
              <button class="btn-link" data-action="reset" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("reset_password")}</button>
              ${u.id !== state.user.id ? `<button class="btn-link btn-link-danger" data-action="delete" data-id="${u.id}" data-name="${escapeHtml(u.name)}">${t("delete_user")}</button>` : ""}
            </span>
          </div>
        </div>
      `;
      })
      .join("");

    listEl.querySelectorAll('[data-action="reset"]').forEach((btn) => {
      btn.addEventListener("click", () => openResetPasswordSheet(btn.dataset.id, btn.dataset.name));
    });
    listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirm_delete_user"))) return;
        await api.deleteUser(btn.dataset.id);
        loadUsers();
      });
    });
  }

  function openResetPasswordSheet(userId, userName) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("reset_password")}</h2>
        <p class="muted">${escapeHtml(userName)}</p>
        <form id="reset-password-form">
          <label>${t("new_password")}<input name="password" type="password" minlength="8" required /></label>
          <p class="form-error" id="reset-password-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-reset">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-reset").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#reset-password-form");
    const errorEl = overlay.querySelector("#reset-password-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = new FormData(form).get("password");
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.resetUserPassword(userId, password);
        overlay.remove();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  function openAddTeamMemberSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("add_team_member")}</h2>
        <form id="new-user-form">
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("email")}<input name="email" type="email" required /></label>
          <label>${t("temp_password")}<input name="password" type="password" minlength="8" required /></label>
          <label>${t("role")}
            <select name="role" id="new-user-role">
              <option value="sales_manager">${t("role_sales_manager")}</option>
              <option value="sales_director">${t("role_sales_director")}</option>
              <option value="warehouse_manager">${t("role_warehouse_manager")}</option>
              <option value="delivery_manager">${t("role_delivery_manager")}</option>
              <option value="accountant">${t("role_accountant")}</option>
              <option value="ceo">${t("role_ceo")}</option>
              <option value="admin">${t("role_admin")}</option>
            </select>
          </label>
          <label id="new-user-position-field">${t("position")}
            <input name="position" list="position-suggestions" placeholder="${t("position_placeholder")}" />
            <datalist id="position-suggestions">
              ${POSITION_SUGGESTIONS.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("")}
            </datalist>
          </label>
          <p class="form-error" id="new-user-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-add-user">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("create_account")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-add-user").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#new-user-form");
    const errorEl = overlay.querySelector("#new-user-error");
    const roleSelect = overlay.querySelector("#new-user-role");
    const positionField = overlay.querySelector("#new-user-position-field");

    function togglePositionField() {
      positionField.hidden = roleSelect.value !== "sales_manager";
    }
    roleSelect.addEventListener("change", togglePositionField);
    togglePositionField();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.createUser({
          name: data.get("name"),
          email: data.get("email"),
          password: data.get("password"),
          role: data.get("role"),
          position: data.get("role") === "sales_manager" ? data.get("position") || null : null,
        });
        overlay.remove();
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  container.querySelector("#add-team-member-btn").addEventListener("click", openAddTeamMemberSheet);

  loadUsers();
}

export async function renderPlanApprovalsSection(container) {
  container.innerHTML = `<div id="plan-approvals-section"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const section = container.querySelector("#plan-approvals-section");

  async function load() {
    const plans = await api.getPendingVisitPlans();
    if (!plans.length) {
      section.innerHTML = `<p class="muted">${t("plan_approvals_empty")}</p>`;
      return;
    }
    section.innerHTML = plans
      .map((p) => {
        const dateLabel = new Date(p.plan_date).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        const names = p.customer_names.map(escapeHtml).join(", ") || t("no_customers_found");
        return `
        <div class="card plan-approval-row">
          <div class="pending-request-header">
            <span class="badge badge-accent">${t("review")}</span>
            <span class="muted">${escapeHtml(p.user_name)} · ${t("plan_for_date")} ${dateLabel}</span>
          </div>
          <p class="proposed-changes-label">${names}</p>
          <div class="sheet-actions">
            <button class="btn" data-action="reject" data-id="${p.id}">${t("reject")}</button>
            <button class="btn btn-primary" data-action="approve" data-id="${p.id}">${t("approve")}</button>
          </div>
        </div>
      `;
      })
      .join("");

    section.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.closest(".plan-approval-row").querySelectorAll("button").forEach((b) => (b.disabled = true));
        await api.reviewVisitPlan(btn.dataset.id, btn.dataset.action);
        load();
      });
    });
  }

  load();
}

export async function renderProductsSection(container) {
  container.innerHTML = `
    <div id="product-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap product-section-actions">
      <button type="button" class="btn" id="bulk-price-edit-btn">${t("bulk_price_edit")}</button>
      <button type="button" class="btn" id="import-excel-btn">${t("import_excel")}</button>
      <button type="button" class="btn btn-block" id="add-product-btn">+ ${t("add_product")}</button>
    </div>
  `;

  const listEl = container.querySelector("#product-list");
  container.querySelector("#bulk-price-edit-btn").addEventListener("click", () => openBulkPriceEditSheet(loadProducts));
  container.querySelector("#import-excel-btn").addEventListener("click", () => openImportSheet(loadProducts));

  async function loadProducts() {
    const products = await api.listAllProducts();
    listEl.innerHTML = products.length
      ? products
          .map(
            (p) => `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}</span>
            </div>
            <span class="badge ${p.active ? "badge-success" : "badge-neutral"}">${formatAmd(Number(p.unit_price_amd))}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">
              ${p.active ? t("active") : t("inactive")}
              ${p.erp_product_id ? (p.manually_edited_at ? ` · ${t("catalog_manual")}` : ` · ${t("catalog_synced")}`) : ""}
            </span>
            <span class="user-row-actions">
              ${p.erp_product_id && p.manually_edited_at ? `<button class="btn-link" data-action="resync" data-id="${p.id}">${t("catalog_resync")}</button>` : ""}
              <button class="btn-link" data-action="promo" data-id="${p.id}">${t("promo_price_label")}</button>
              <button class="btn-link" data-action="history" data-id="${p.id}">${t("price_history")}</button>
              <button class="btn-link" data-action="edit" data-id="${p.id}">${t("edit")}</button>
              ${p.active ? `<button class="btn-link btn-link-danger" data-action="delete" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${t("deactivate")}</button>` : ""}
            </span>
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="empty-state">${t("no_products_found")}</p>`;

    listEl.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      const product = products.find((p) => p.id === Number(btn.dataset.id));
      btn.addEventListener("click", () => openProductSheet(product));
    });
    listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`${t("confirm_delete_product")} ${btn.dataset.name}?`)) return;
        await api.deleteProduct(btn.dataset.id);
        loadProducts();
      });
    });
    listEl.querySelectorAll('[data-action="resync"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api.resyncProduct(btn.dataset.id);
        loadProducts();
      });
    });
    listEl.querySelectorAll('[data-action="promo"]').forEach((btn) => {
      const product = products.find((p) => p.id === Number(btn.dataset.id));
      btn.addEventListener("click", () => openPromoSheet(product));
    });
    listEl.querySelectorAll('[data-action="history"]').forEach((btn) => {
      const product = products.find((p) => p.id === Number(btn.dataset.id));
      btn.addEventListener("click", () => openPriceHistorySheet(product));
    });
  }

  // Date-ranged "special period" promo pricing (item 6) -- shows any
  // existing promos for this product (past and upcoming, most recent
  // first) and a small form to add a new one.
  async function openPromoSheet(product) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("promo_price_label")}</h2>
        <p class="muted">${escapeHtml(product.name)}</p>
        <div id="promo-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
        <form id="promo-form">
          <label>${t("promo_price_amd")}<input name="promo_price_amd" type="number" min="0" step="1" required /></label>
          <label>${t("promo_starts_on")}<input name="starts_on" type="date" required /></label>
          <label>${t("promo_ends_on")}<input name="ends_on" type="date" required /></label>
          <label>${t("promo_note")}<input name="note" type="text" maxlength="200" /></label>
          <p class="form-error" id="promo-form-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="close-promo">${t("done")}</button>
            <button type="submit" class="btn btn-primary">${t("add_promo")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#close-promo").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const promoListEl = overlay.querySelector("#promo-list");
    async function loadPromos() {
      const promos = await api.listProductPromos(product.id);
      const today = new Date().toISOString().slice(0, 10);
      // DATE columns come back over JSON as a full ISO timestamp
      // ("2026-09-01T00:00:00.000Z") -- trim to just the date for both the
      // active-range comparison and the display.
      const dateOnly = (v) => String(v).slice(0, 10);
      promoListEl.innerHTML = promos.length
        ? promos
            .map((promo) => {
              const starts = dateOnly(promo.starts_on);
              const ends = dateOnly(promo.ends_on);
              const active = starts <= today && today <= ends;
              return `
          <div class="card user-row">
            <div class="user-row-top">
              <strong>${formatAmd(Number(promo.promo_price_amd))}</strong>
              <span class="badge ${active ? "badge-success" : "badge-neutral"}">
                ${active ? t("promo_active") : ends < today ? t("promo_ended") : t("promo_upcoming")}
              </span>
            </div>
            <div class="user-row-meta">
              <span class="muted">${escapeHtml(starts)} &ndash; ${escapeHtml(ends)}</span>
              <button class="btn-link btn-link-danger" data-promo-id="${promo.id}">${t("delete")}</button>
            </div>
          </div>
        `;
            })
            .join("")
        : `<p class="empty-state">${t("no_promos_yet")}</p>`;

      promoListEl.querySelectorAll("[data-promo-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await api.deleteProductPromo(product.id, btn.dataset.promoId);
          loadPromos();
        });
      });
    }
    loadPromos();

    const form = overlay.querySelector("#promo-form");
    const errorEl = overlay.querySelector("#promo-form-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.createProductPromo(product.id, {
          promo_price_amd: Number(data.get("promo_price_amd")),
          starts_on: data.get("starts_on"),
          ends_on: data.get("ends_on"),
          note: data.get("note") || null,
        });
        form.reset();
        loadPromos();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  function openProductSheet(product) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${product ? t("edit_product") : t("add_product")}</h2>
        ${
          product
            ? `<div class="product-image-editor">
                <div class="product-image-preview" id="product-image-preview">
                  ${product.image_path ? `<img src="${api.productImageUrl(product.id)}" alt="" />` : `<span class="product-image-placeholder">${t("no_image")}</span>`}
                </div>
                <div class="product-image-actions">
                  <input type="file" id="product-image-input" accept="image/*" class="visually-hidden" />
                  <button type="button" class="btn-link" id="product-image-upload-btn">${t("upload_image")}</button>
                  ${product.image_path ? `<button type="button" class="btn-link btn-link-danger" id="product-image-remove-btn">${t("remove")}</button>` : ""}
                </div>
              </div>`
            : ""
        }
        <form id="product-form">
          <label>${t("product_name")}<input name="name" value="${product ? escapeHtml(product.name) : ""}" required /></label>
          <label>${t("brand")}<input name="brand" value="${product?.brand ? escapeHtml(product.brand) : ""}" /></label>
          <label>${t("unit")}<input name="unit" value="${product?.unit ? escapeHtml(product.unit) : ""}" placeholder="e.g. box, L, pcs" /></label>
          <label>${t("price_standard")}<input name="unit_price_amd" type="number" min="0" step="1" value="${product ? Number(product.unit_price_amd) : ""}" required /></label>
          <label>${t("price_retail")}<input name="retail_price_amd" type="number" min="0" step="1" value="${product && product.retail_price_amd !== null ? Number(product.retail_price_amd) : ""}" placeholder="${t("price_retail_hint")}" /></label>
          ${
            product
              ? `<label class="settings-toggle-row"><span>${t("active")}</span>
                  <button type="button" class="toggle-switch" id="product-active-toggle" role="switch" aria-checked="${product.active}"><span class="toggle-thumb"></span></button>
                </label>`
              : ""
          }
          <p class="form-error" id="product-form-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-product">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-product").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    if (product) {
      const imageInput = overlay.querySelector("#product-image-input");
      overlay.querySelector("#product-image-upload-btn").addEventListener("click", () => imageInput.click());
      imageInput.addEventListener("change", async () => {
        const file = imageInput.files[0];
        if (!file) return;
        try {
          // Consistent aspect ratio, small footprint (item 38) -- a
          // catalog photo just needs to help identify the product, not
          // be print-quality.
          const compressed = await compressImage(file, { maxDimension: 500, quality: 0.8 });
          const form = new FormData();
          form.set("image", compressed, "image.jpg");
          await api.uploadProductImage(product.id, form);
          overlay.remove();
          loadProducts();
        } catch (err) {
          alert(err.message);
        }
      });
      overlay.querySelector("#product-image-remove-btn")?.addEventListener("click", async () => {
        await api.deleteProductImage(product.id);
        overlay.remove();
        loadProducts();
      });
    }

    let active = product?.active ?? true;
    const activeToggle = overlay.querySelector("#product-active-toggle");
    activeToggle?.addEventListener("click", () => {
      active = !active;
      activeToggle.setAttribute("aria-checked", active);
    });

    const form = overlay.querySelector("#product-form");
    const errorEl = overlay.querySelector("#product-form-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const standardPrice = Number(data.get("unit_price_amd"));
      const retailInput = data.get("retail_price_amd");
      const payload = {
        name: data.get("name"),
        brand: data.get("brand") || null,
        unit: data.get("unit") || null,
        // bronze_price_amd is what pricingService.getEffectiveProductPricing
        // actually reads as the "standard" price -- kept equal to
        // unit_price_amd here (same value the ERP sync writes to both) so a
        // manual edit doesn't silently desync the two.
        unit_price_amd: standardPrice,
        bronze_price_amd: standardPrice,
        retail_price_amd: retailInput ? Number(retailInput) : standardPrice,
      };
      try {
        if (product) {
          await api.updateProduct(product.id, { ...payload, active });
        } else {
          await api.createProduct(payload);
        }
        overlay.remove();
        loadProducts();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  // Full price-change trail for one product -- standard/retail edits and
  // special create/cancel events, newest first. Read-only (item 9/40).
  async function openPriceHistorySheet(product) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("price_history")}</h2>
        <p class="muted">${escapeHtml(product.name)}</p>
        <div id="price-history-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
        <div class="sheet-actions">
          <button type="button" class="btn btn-block" id="close-price-history">${t("done")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#close-price-history").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const listEl = overlay.querySelector("#price-history-list");
    const PRICE_TYPE_LABEL = { standard: t("price_standard"), retail: t("price_retail"), special: t("price_special_period") };
    const entries = await api.getProductPriceHistory(product.id);
    listEl.innerHTML = entries.length
      ? entries
          .map(
            (h) => `
        <div class="card user-row">
          <div class="user-row-top">
            <strong>${escapeHtml(PRICE_TYPE_LABEL[h.price_type] || h.price_type)}</strong>
            <span class="muted">${formatDateTime(h.changed_at)}</span>
          </div>
          <div class="user-row-meta">
            <span>${h.old_value !== null ? formatAmd(Number(h.old_value)) : "—"} &rarr; ${h.new_value !== null ? formatAmd(Number(h.new_value)) : "—"}</span>
            <span class="muted">${escapeHtml(h.changed_by_name || "")}${h.note ? ` · ${escapeHtml(h.note)}` : ""}</span>
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="empty-state">${t("no_price_history")}</p>`;
  }

  container.querySelector("#add-product-btn").addEventListener("click", () => openProductSheet(null));

  loadProducts();
}

// Percent/fixed/exact price changes across a brand, family, or the current
// product filter, with a preview (old -> new, diff, count) the user must
// confirm before anything is written -- see POST /products/bulk-price-update.
function openBulkPriceEditSheet(onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("bulk_price_edit")}</h2>
      <form id="bulk-price-form">
        <label>${t("brand")}<input name="brand" placeholder="${t("bulk_edit_brand_placeholder")}" /></label>
        <label>${t("price_field")}
          <select name="price_field">
            <option value="bronze_price_amd">${t("price_standard")}</option>
            <option value="retail_price_amd">${t("price_retail")}</option>
          </select>
        </label>
        <label>${t("operation")}
          <select name="operation" id="bulk-operation">
            <option value="percent">${t("operation_percent")}</option>
            <option value="fixed">${t("operation_fixed")}</option>
            <option value="exact">${t("operation_exact")}</option>
          </select>
        </label>
        <label id="bulk-value-label">${t("value_percent_hint")}<input name="value" type="number" step="0.1" required /></label>
        <p class="form-error" id="bulk-form-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-bulk">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("preview_changes")}</button>
        </div>
      </form>
      <div id="bulk-preview" hidden>
        <p id="bulk-preview-count" class="muted"></p>
        <div id="bulk-preview-list" class="card-list"></div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="bulk-preview-back">${t("back")}</button>
          <button type="button" class="btn btn-primary" id="bulk-apply-btn">${t("apply_changes")}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-bulk").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#bulk-price-form");
  const operationSelect = overlay.querySelector("#bulk-operation");
  const valueLabel = overlay.querySelector("#bulk-value-label");
  const errorEl = overlay.querySelector("#bulk-form-error");
  const previewSection = overlay.querySelector("#bulk-preview");
  const previewCountEl = overlay.querySelector("#bulk-preview-count");
  const previewListEl = overlay.querySelector("#bulk-preview-list");

  operationSelect.addEventListener("change", () => {
    valueLabel.firstChild.textContent =
      operationSelect.value === "percent" ? t("value_percent_hint") : operationSelect.value === "fixed" ? t("value_fixed_hint") : t("value_exact_hint");
  });

  let lastRequest = null;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const brand = data.get("brand")?.trim();
    if (!brand) {
      errorEl.textContent = t("bulk_edit_brand_required");
      errorEl.hidden = false;
      return;
    }
    lastRequest = {
      brand,
      price_field: data.get("price_field"),
      operation: data.get("operation"),
      value: Number(data.get("value")),
    };
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const result = await api.previewBulkPriceUpdate(lastRequest);
      previewCountEl.textContent = `${result.count} ${t("products_affected")}`;
      previewListEl.innerHTML = result.changes.length
        ? result.changes
            .slice(0, 100)
            .map(
              (c) => `
        <div class="card user-row">
          <div class="user-row-top">
            <strong>${escapeHtml(c.name)}</strong>
            <span class="muted">${escapeHtml(c.brand || "")}</span>
          </div>
          <div class="user-row-meta">
            <span>${formatAmd(c.old_value)} &rarr; ${formatAmd(c.new_value)}</span>
            <span class="${c.diff >= 0 ? "muted" : "muted"}">${c.diff >= 0 ? "+" : ""}${formatAmd(c.diff)}</span>
          </div>
        </div>
      `
            )
            .join("")
        : `<p class="empty-state">${t("no_products_found")}</p>`;
      form.hidden = true;
      previewSection.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  overlay.querySelector("#bulk-preview-back").addEventListener("click", () => {
    previewSection.hidden = true;
    form.hidden = false;
  });

  overlay.querySelector("#bulk-apply-btn").addEventListener("click", async () => {
    const applyBtn = overlay.querySelector("#bulk-apply-btn");
    applyBtn.disabled = true;
    try {
      await api.applyBulkPriceUpdate(lastRequest);
      close();
      onDone();
    } catch (err) {
      applyBtn.disabled = false;
      alert(err.message);
    }
  });
}

// Excel import (item 28): pick a file -> preview (server parses +
// classifies, writes nothing) -> a second confirmed step re-uploads the
// same file to actually apply it. Never overwrites blindly -- the preview
// always renders before Apply is even shown.
function openImportSheet(onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("import_excel")}</h2>
      <p class="muted">${t("import_excel_hint")}</p>
      <input type="file" id="import-file-input" accept=".xlsx" />
      <p class="form-error" id="import-error" hidden></p>
      <div id="import-preview" hidden></div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-block" id="close-import">${t("cancel")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.querySelector("#close-import").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const fileInput = overlay.querySelector("#import-file-input");
  const errorEl = overlay.querySelector("#import-error");
  const previewEl = overlay.querySelector("#import-preview");
  let selectedFile = null;

  fileInput.addEventListener("change", async () => {
    selectedFile = fileInput.files[0];
    if (!selectedFile) return;
    errorEl.hidden = true;
    previewEl.hidden = true;
    previewEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    previewEl.hidden = false;
    try {
      const form = new FormData();
      form.set("file", selectedFile);
      const result = await api.previewProductImport(form);
      renderPreview(result);
    } catch (err) {
      previewEl.hidden = true;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  function summaryRow(label, count) {
    return `<div class="user-row-meta"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>`;
  }

  function renderPreview(result) {
    const { newProducts, changedPrices, unchanged, duplicates, invalidRows, missingProducts } = result;
    previewEl.innerHTML = `
      <div class="card">
        ${summaryRow(t("import_new_products"), newProducts.length)}
        ${summaryRow(t("import_changed_prices"), changedPrices.length)}
        ${summaryRow(t("import_unchanged"), unchanged.length)}
        ${duplicates.length ? summaryRow(t("import_duplicates"), duplicates.length) : ""}
        ${invalidRows.length ? summaryRow(t("import_invalid_rows"), invalidRows.length) : ""}
        ${summaryRow(t("import_missing_products"), missingProducts.length)}
      </div>
      ${
        changedPrices.length
          ? `<div class="card-list">
              ${changedPrices
                .slice(0, 30)
                .map(
                  (c) => `
                <div class="card user-row">
                  <div class="user-row-top"><strong>${escapeHtml(c.name)}</strong></div>
                  <div class="user-row-meta">
                    <span>${t("price_standard")}: ${formatAmd(c.oldStandard ?? 0)} &rarr; ${formatAmd(c.newStandard ?? 0)}</span>
                  </div>
                </div>
              `
                )
                .join("")}
            </div>`
          : ""
      }
      ${
        invalidRows.length
          ? `<div class="card-list">
              ${invalidRows
                .slice(0, 30)
                .map((r) => `<div class="card user-row"><div class="user-row-meta"><span>${t("row")} ${r.rowNumber}: ${escapeHtml(r.reason)}</span></div></div>`)
                .join("")}
            </div>`
          : ""
      }
      <div class="sheet-actions">
        <button type="button" class="btn btn-primary btn-block" id="apply-import-btn">${t("apply_import")}</button>
      </div>
    `;
    overlay.querySelector("#apply-import-btn").addEventListener("click", async () => {
      const applyBtn = overlay.querySelector("#apply-import-btn");
      applyBtn.disabled = true;
      try {
        const form = new FormData();
        form.set("file", selectedFile);
        const applied = await api.applyProductImport(form);
        previewEl.innerHTML = `<div class="card checkin-result result-success">
          <div class="result-icon">&#10003;</div>
          <p>${applied.created} ${t("import_new_products").toLowerCase()}, ${applied.updated} ${t("import_changed_prices").toLowerCase()}, ${applied.specialsCreated} ${t("promo_price_label").toLowerCase()}</p>
        </div>`;
        onDone();
      } catch (err) {
        applyBtn.disabled = false;
        alert(err.message);
      }
    });
  }
}

// Editable company header for the pricelist export (item 14) -- name,
// logo, phone/email/website/address. A singleton row (see the
// company_profile table), not per-user.
export async function renderCompanyProfileSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const profile = await api.getCompanyProfile();
  container.innerHTML = `
    <div class="card">
      <form id="company-profile-form">
        <label>${t("company_name")}<input name="name" value="${escapeHtml(profile.name || "")}" required /></label>
        <label>${t("phone")}<input name="phone" value="${escapeHtml(profile.phone || "")}" /></label>
        <label>${t("email")}<input name="email" type="email" value="${escapeHtml(profile.email || "")}" /></label>
        <label>${t("website")}<input name="website" value="${escapeHtml(profile.website || "")}" /></label>
        <label>${t("address")}<textarea name="address" rows="2">${escapeHtml(profile.address || "")}</textarea></label>
        <p class="form-success" id="company-profile-success" role="status" hidden>${t("saved")}</p>
        <p class="form-error" id="company-profile-error" hidden></p>
        <button type="submit" class="btn btn-primary">${t("save")}</button>
      </form>
    </div>
  `;
  const form = container.querySelector("#company-profile-form");
  const successEl = container.querySelector("#company-profile-success");
  const errorEl = container.querySelector("#company-profile-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    successEl.hidden = true;
    errorEl.hidden = true;
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.updateCompanyProfile({
        name: data.get("name"),
        phone: data.get("phone") || null,
        email: data.get("email") || null,
        website: data.get("website") || null,
        address: data.get("address") || null,
      });
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function previousMonthStart() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

export async function renderPointsCloseoutSection(container) {
  const lastMonth = previousMonthStart();
  container.innerHTML = `
    <div class="card">
      <p class="muted">${t("closeout_hint")}</p>
      <button type="button" class="btn btn-primary" id="close-out-btn">${t("close_out_month")} (${escapeHtml(formatMonthLabel(lastMonth))})</button>
      <p class="form-error" id="closeout-error" hidden></p>
    </div>
    <div class="card-list" id="closeout-history"></div>
  `;

  const historyEl = container.querySelector("#closeout-history");
  const errorEl = container.querySelector("#closeout-error");

  async function loadHistory() {
    const rows = await api.listMonthlyCloseouts();
    if (!rows.length) {
      historyEl.innerHTML = `<p class="empty-state">${t("no_closeouts_yet")}</p>`;
      return;
    }
    const byMonth = new Map();
    for (const r of rows) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month).push(r);
    }
    historyEl.innerHTML = [...byMonth.entries()]
      .map(([month, winners]) => {
        const top = winners.find((w) => w.rank === 1);
        return `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(formatMonthLabel(String(month).slice(0, 7)))}</strong>
              <span class="muted">${top ? `🏆 ${escapeHtml(top.user_name)}` : ""}</span>
            </div>
            <span class="badge badge-accent">${top ? `${top.total_points} pts` : ""}</span>
          </div>
        </div>
      `;
      })
      .join("");
  }

  container.querySelector("#close-out-btn").addEventListener("click", async (e) => {
    errorEl.hidden = true;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.closeOutMonth(lastMonth);
      loadHistory();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  loadHistory();
}
