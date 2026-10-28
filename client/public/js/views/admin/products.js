// Settings > Administration > Products: the product list, bulk price edit and the import sheet (moved out of admin.js with the
// refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { activateDialog, bindAmdInput, compressImage, escapeHtml, formatAmd, formatDateTime, groupDigits, labelColon, parseAmd } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { compareProducts } from "../../productSort.js";

export async function renderProductsSection(container) {
  container.innerHTML = `
    <div id="product-sync-diagnostics"></div>
    <div id="product-duplicates"></div>
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

  // Landing cost is entirely ERP-sync-fed (never editable in-app -- see
  // migration 064), so "it's not showing" has exactly two possible causes:
  // the sync payload never carried a value for it, or the app dropped a
  // value it did carry. This surfaces which one it is without needing
  // direct DB access -- a plain count of synced products missing it, and
  // when products last synced at all, right on the screen someone would
  // already be looking at when they notice landing cost is blank.
  (async () => {
    let diag;
    try {
      diag = await api.getProductSyncDiagnostics();
    } catch {
      return; // Non-critical -- the catalog itself still loads/works without this.
    }
    const bannerEl = container.querySelector("#product-sync-diagnostics");
    if (!diag.synced_count) {
      bannerEl.innerHTML = `<p class="sync-diagnostic-banner">${t("landing_cost_diag_never_synced")}</p>`;
      return;
    }
    if (diag.net_cost_suspect_count) {
      bannerEl.innerHTML += `
        <p class="sync-diagnostic-banner sync-diagnostic-banner-warning">
          ${t("net_cost_diag_suspect").replace("{count}", diag.net_cost_suspect_count)}
          ${diag.net_cost_suspect.map((p) => `${escapeHtml(p.name)} ${escapeHtml(p.unit ?? "")} (${t(`net_cost_diag_${p.reason}`)})`).join("; ")}
        </p>`;
    }
    if (diag.missing_landing_cost === 0) {
      return; // Nothing more to flag -- every synced product has a landing cost.
    }
    const lastSynced = diag.last_synced_at ? formatDateTime(diag.last_synced_at) : t("landing_cost_diag_unknown");
    bannerEl.innerHTML += `
      <p class="sync-diagnostic-banner sync-diagnostic-banner-warning">
        ${t("landing_cost_diag_missing")
          .replace("{missing}", diag.missing_landing_cost)
          .replace("{total}", diag.synced_count)}
        ${t("landing_cost_diag_last_synced")}${labelColon()}${escapeHtml(lastSynced)}
      </p>
    `;
  })();

  async function loadProducts() {
    const fetched = await api.listAllProducts();
    // Only active products are listed (the workbook's SKU Status decides what
    // is sold) in brand/family/viscosity/size order -- see productSort.js,
    // shared with Pricelist, Order creation and Warehouse Inventory.
    const products = fetched.filter((p) => p.active).sort(compareProducts);
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
            <span class="badge ${p.active ? "badge-success" : "badge-neutral"}">${formatAmd(Number(p.silver_price_amd > 0 ? p.silver_price_amd : p.unit_price_amd))}</span>
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
          <label>${t("promo_price_amd")}<input name="promo_price_amd" class="amd-input" inputmode="numeric" required /></label>
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
              <button class="btn-link btn-link-danger btn-has-icon" data-promo-id="${promo.id}">${icons.trash}${t("delete")}</button>
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
    form.querySelectorAll(".amd-input").forEach((el) => bindAmdInput(el));
    const errorEl = overlay.querySelector("#promo-form-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.createProductPromo(product.id, {
          // AMD has no subunit in this app -- rounded here (not just
          // step="1" on the input) so a decimal value doesn't silently
          // block the browser's own native form submission with no
          // visible error at all (reported as "net cost not showing" --
          // the same class of input elsewhere in this form).
          promo_price_amd: parseAmd(data.get("promo_price_amd")),
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
          <label>${t("price_standard")}<input name="unit_price_amd" class="amd-input" inputmode="numeric" value="${product ? groupDigits(product.unit_price_amd) : ""}" required /></label>
          <label>${t("price_retail")}<input name="retail_price_amd" class="amd-input" inputmode="numeric" value="${product && product.retail_price_amd !== null ? groupDigits(product.retail_price_amd) : ""}" placeholder="${t("price_retail_hint")}" /></label>
          <label>${t("net_cost")}<input name="net_cost_amd" class="amd-input" inputmode="numeric" value="${product && product.net_cost_amd !== null && product.net_cost_amd !== undefined ? groupDigits(product.net_cost_amd) : ""}" placeholder="${t("net_cost_hint")}" /></label>
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
    form.querySelectorAll(".amd-input").forEach((el) => bindAmdInput(el));
    const errorEl = overlay.querySelector("#product-form-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      // AMD has no subunit in this app (see formatAmd) -- rounded here
      // (the inputs themselves use step="any", not step="1") so typing a
      // decimal (e.g. pasted straight from a spreadsheet's own formula
      // output) never silently blocks the browser's native form
      // submission with no visible error, which is what step="1" used to
      // do: reported as "net cost not showing" -- the save request never
      // even fired, and nothing on screen said why.
      const standardPrice = parseAmd(data.get("unit_price_amd"));
      const retailInput = data.get("retail_price_amd");
      const netCostInput = data.get("net_cost_amd");
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
        retail_price_amd: parseAmd(retailInput) ?? standardPrice,
        net_cost_amd: parseAmd(netCostInput),
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
    const PRICE_TYPE_LABEL = { standard: t("price_standard"), retail: t("price_retail"), special: t("price_special_period"), bronze: t("tier_bronze"), silver: t("tier_silver"), gold: t("tier_gold") };
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

  // Surfaces existing name+brand+unit duplicates (see GET
  // /products/duplicates) so an admin can find and resolve the ones
  // already in the catalog from before the import/sync matching fixes
  // above -- nothing here merges them automatically, it just puts both
  // rows side by side with a straight path into the same edit sheet used
  // everywhere else in this screen to flip the stale one's Active toggle
  // off.
  const duplicatesEl = container.querySelector("#product-duplicates");
  async function loadDuplicates() {
    let groups;
    try {
      groups = await api.getProductDuplicates();
    } catch {
      return; // Non-critical -- the catalog itself still loads/works without this.
    }
    if (!groups.length) {
      duplicatesEl.innerHTML = "";
      return;
    }
    duplicatesEl.innerHTML = `
      <div class="sync-diagnostic-banner sync-diagnostic-banner-warning">
        <strong>${t("product_duplicates_heading")}</strong>
        <p class="muted">${t("product_duplicates_hint")}</p>
        <div class="card-list">
          ${groups
            .map(
              (group) => `
            <div class="card user-row product-duplicate-group">
              ${group
                .map(
                  (p) => `
                <div class="user-row-top">
                  <div>
                    <strong>${escapeHtml(p.name)}</strong>
                    <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}</span>
                  </div>
                  <span class="badge badge-neutral">${p.stock_qty ?? "—"} ${t("warehouse_pcs_suffix")}</span>
                </div>
                <div class="user-row-meta">
                  <span class="muted">
                    ${p.sku ? `${t("product_code_label")}${labelColon()}${escapeHtml(p.sku)} · ` : ""}
                    ${p.erp_product_id ? t("catalog_synced") : t("catalog_manual")}
                  </span>
                  <button class="btn-link" data-dup-edit="${p.id}">${t("edit")}</button>
                </div>
              `
                )
                .join("<hr class=\"product-duplicate-divider\" />")}
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    duplicatesEl.querySelectorAll("[data-dup-edit]").forEach((btn) => {
      const product = groups.flat().find((p) => p.id === Number(btn.dataset.dupEdit));
      btn.addEventListener("click", () => openProductSheet(product));
    });
  }

  loadProducts();
  loadDuplicates();
}

// Percent/fixed/exact price changes across a brand, family, or the current
// product filter, with a preview (old -> new, diff, count) the user must
// confirm before anything is written -- see POST /products/bulk-price-update.
export function openBulkPriceEditSheet(onDone) {
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
export function openImportSheet(onDone) {
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
                    ${
                      c.oldStandard !== c.newStandard
                        ? `<span>${t("price_standard")}${labelColon()}${formatAmd(c.oldStandard ?? 0)} &rarr; ${formatAmd(c.newStandard ?? 0)}</span>`
                        : ""
                    }
                    ${
                      c.oldRetail !== c.newRetail
                        ? `<span>${t("price_retail")}${labelColon()}${formatAmd(c.oldRetail ?? 0)} &rarr; ${formatAmd(c.newRetail ?? 0)}</span>`
                        : ""
                    }
                    ${
                      c.oldNetCost !== c.newNetCost
                        ? `<span>${t("net_cost")}${labelColon()}${c.oldNetCost != null ? formatAmd(c.oldNetCost) : "—"} &rarr; ${c.newNetCost != null ? formatAmd(c.newNetCost) : "—"}</span>`
                        : ""
                    }
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
