import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { compareProducts, parseLiters } from "../productSort.js";

// "624" -> "624L", "4.5" -> "4.5L" -- compact, no space, matching how a WM
// reads a shelf tag (as opposed to util.js's own formatLiters-style helpers
// elsewhere, which spell out " L" for a prose sentence).
function formatLitersCompact(value) {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 10) / 10;
  return `${rounded.toLocaleString()}L`;
}

// Right-hand side of an inventory row: "21pcs" alone for a non-liter item
// (filters, brake pads), "21pcs | 4368L" for an oil where p.unit is a
// parseable container size ("208L") -- total shelf liters, not per-unit.
function inventoryQtyLabel(p) {
  if (p.stock_qty == null) return t("warehouse_stock_unknown");
  const qtyLabel = `${p.stock_qty}${t("warehouse_pcs_suffix")}`;
  const perUnitLiters = parseLiters(p.unit);
  if (perUnitLiters == null) return qtyLabel;
  return `${qtyLabel} | ${formatLitersCompact(perUnitLiters * p.stock_qty)}`;
}

export async function renderWarehouse(root, navigate) {
  let activeTab = "pick-list";

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_warehouse")}</h1></div>
      </div>
      <div class="segmented" id="warehouse-tabs">
        <button type="button" class="chip chip-active" data-tab="pick-list">${t("warehouse_tab_pick_list")}</button>
        <button type="button" class="chip" data-tab="staging">${t("warehouse_tab_staging")}</button>
        <button type="button" class="chip" data-tab="inventory">${t("warehouse_tab_inventory")}</button>
      </div>
      <p class="form-error" id="warehouse-error" hidden></p>
      <div id="warehouse-content" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const contentEl = container.querySelector("#warehouse-content");
  const errorEl = container.querySelector("#warehouse-error");
  const tabsEl = container.querySelector("#warehouse-tabs");

  tabsEl.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("chip-active", b.dataset.tab === activeTab));
      load();
    });
  });

  async function load() {
    contentEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      if (activeTab === "pick-list") await loadPickList();
      else if (activeTab === "staging") await loadStaging();
      else await loadInventory();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      contentEl.innerHTML = "";
    }
  }

  // Same brand-then-family-then-viscosity-then-size ordering the Inventory
  // tab uses (compareProducts), so a product's position doesn't jump
  // between the two screens -- only the group heading collapses to brand
  // alone here (the Inventory tab additionally splits on family).
  function pickGroupHeadingHtml(r, prevR) {
    if (prevR && prevR.brand === r.brand) return "";
    return `<div class="list-group-heading">${escapeHtml(r.brand || t("warehouse_stock_unknown"))}</div>`;
  }

  async function loadPickList() {
    const rows = (await api.getPickList()).sort((a, b) =>
      compareProducts(
        { name: a.product_name, brand: a.brand, family: a.family, unit: a.size },
        { name: b.product_name, brand: b.brand, family: b.family, unit: b.size }
      )
    );
    contentEl.innerHTML = rows.length
      ? `<div class="card-list pick-list">${rows
          .map(
            (r, i) => `
        ${pickGroupHeadingHtml(r, rows[i - 1])}
        <button type="button" class="card pick-item">
          <span class="pick-item-check">${icons.checkCircle}</span>
          <div class="order-product-info">
            <strong>${escapeHtml(r.product_name)}${r.size ? ` · ${escapeHtml(r.size)}` : ""}</strong>
            <span class="muted">${r.order_count} ${t("warehouse_orders_count_suffix")}</span>
          </div>
          <div class="pick-list-qty">
            <span class="pick-list-qty-value">${r.total_quantity}</span>
            ${r.stock_qty != null ? `<span class="pick-list-stock">${t("warehouse_in_stock")}: ${r.stock_qty}</span>` : ""}
          </div>
        </button>`
          )
          .join("")}</div>`
      : `<p class="empty-state">${t("warehouse_pick_list_empty")}</p>`;

    // Picked state is a plain client-side toggle, not persisted anywhere --
    // it's just a visual checklist aid for a WM walking the floor with this
    // screen open, reset on reload/tab switch like any scratch state.
    contentEl.querySelectorAll(".pick-item").forEach((btn) => {
      btn.addEventListener("click", () => btn.classList.toggle("pick-item-picked"));
    });
  }

  async function loadStaging() {
    const rows = await api.getStagingList();
    contentEl.innerHTML = rows.length
      ? `<button type="button" class="btn btn-primary btn-block" id="bulk-mark-packed-btn" disabled>${t("warehouse_bulk_mark_packed")}</button>
         <div class="card-list" style="margin-top:8px;">${rows.map((o) => stagingRowHtml(o)).join("")}</div>`
      : `<p class="empty-state">${t("warehouse_staging_empty")}</p>`;

    const bulkBtn = contentEl.querySelector("#bulk-mark-packed-btn");
    function updateBulkBtn() {
      const checked = contentEl.querySelectorAll('[data-select-order]:checked').length;
      if (!bulkBtn) return;
      bulkBtn.disabled = checked === 0;
      bulkBtn.textContent = checked ? `${t("warehouse_bulk_mark_packed")} (${checked})` : t("warehouse_bulk_mark_packed");
    }
    contentEl.querySelectorAll("[data-select-order]").forEach((cb) => cb.addEventListener("change", updateBulkBtn));
    bulkBtn?.addEventListener("click", async () => {
      const ids = Array.from(contentEl.querySelectorAll('[data-select-order]:checked')).map((cb) => Number(cb.dataset.selectOrder));
      if (!ids.length) return;
      bulkBtn.disabled = true;
      try {
        await api.bulkMarkOrdersPacked(ids);
        window.dispatchEvent(new Event("warehouse-changed"));
        load();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        bulkBtn.disabled = false;
      }
    });

    contentEl.querySelectorAll("[data-mark-packed]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.markOrderPacked(btn.dataset.markPacked);
          window.dispatchEvent(new Event("warehouse-changed"));
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
    contentEl.querySelectorAll("[data-flag-issue]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const note = prompt(t("stock_issue_note_prompt"));
        if (!note || !note.trim()) return;
        btn.disabled = true;
        try {
          await api.flagOrderStockIssue(btn.dataset.flagIssue, note.trim());
          window.dispatchEvent(new Event("warehouse-changed"));
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
  }

  function stagingRowHtml(o) {
    return `
      <div class="card">
        <label class="plan-order-row" style="padding:0 0 8px;">
          <input type="checkbox" data-select-order="${o.id}" />
          <span>${t("warehouse_select_for_bulk")}</span>
        </label>
        <div class="order-detail-ids">
          <span>${t("customer_id_label")}: ${escapeHtml(o.erp_customer_id || "")}</span>
          ${o.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(o.order_code)}</span>` : ""}
        </div>
        <strong>${escapeHtml(o.customer_name)}</strong>
        <p class="muted">${escapeHtml(o.address || "")}</p>
        <div class="card-list" style="margin:8px 0;">
          ${o.items.map((i) => `<div class="order-product-row"><span>${i.brand ? `${escapeHtml(i.brand)} · ` : ""}${escapeHtml(i.product_name)}${i.size ? ` · ${escapeHtml(i.size)}` : ""} × ${i.quantity}</span></div>`).join("")}
        </div>
        <p>${t("total")}: <span class="text-amount">${formatAmd(Number(o.total_amd))}</span></p>
        <div class="sheet-actions">
          <button type="button" class="btn btn-primary" data-mark-packed="${o.id}">${t("mark_packed")}</button>
          <button type="button" class="btn btn-danger" data-flag-issue="${o.id}">${t("flag_stock_issue")}</button>
        </div>
      </div>`;
  }

  async function loadInventory() {
    contentEl.innerHTML = `
      <div class="inventory-search-row">
        <input type="search" id="inventory-search" placeholder="${t("search")}" />
        <button type="button" class="filter-icon-btn" id="inventory-landing-btn" aria-label="${t("warehouse_show_landing_cost")}" title="${t("warehouse_show_landing_cost")}" aria-pressed="false">
          ${icons.download}
        </button>
        <button type="button" class="filter-icon-btn" id="inventory-wholesale-btn" aria-label="${t("warehouse_show_wholesale_price")}" title="${t("warehouse_show_wholesale_price")}" aria-pressed="false">
          ${icons.wallet}
        </button>
        <button type="button" class="filter-icon-btn" id="inventory-brand-btn" aria-label="${t("filter_brand")}" title="${t("filter_brand")}">
          ${icons.tag}
        </button>
      </div>
      <div id="inventory-list" class="card-list"></div>
    `;
    const listEl = contentEl.querySelector("#inventory-list");
    const searchInput = contentEl.querySelector("#inventory-search");
    const brandBtn = contentEl.querySelector("#inventory-brand-btn");
    const landingBtn = contentEl.querySelector("#inventory-landing-btn");
    const wholesaleBtn = contentEl.querySelector("#inventory-wholesale-btn");
    let brandFilter = "";
    let brandOptions = null;
    let showLanding = false;
    let showWholesale = false;
    let lastRows = [];
    // Collapsed by default -- a WM scanning the shelf list gets brand/family
    // totals up front and drills into only what they need. Keyed by brand
    // name alone, and by "brand||family" for the family level, so a state
    // survives across re-renders (a price-toggle click, a search) within
    // this screen visit, only resetting on tab switch/reload.
    const expandedBrands = new Set();
    const expandedFamilies = new Set();

    function productRowHtml(p) {
      return `
        <div class="card inventory-row-card">
          <div class="inventory-row">
            <span class="inventory-row-name">${escapeHtml(p.name)}${p.unit ? ` <span class="inventory-row-size">${escapeHtml(p.unit)}</span>` : ""}</span>
            <span class="inventory-row-qty ${p.stock_qty == null ? "inventory-row-qty-unknown" : p.stock_qty > 0 ? "inventory-row-qty-ok" : "inventory-row-qty-zero"}">${inventoryQtyLabel(p)}</span>
          </div>
          ${pricesRowHtml(p)}
        </div>`;
    }

    // Second row: whichever of landing cost / wholesale price is currently
    // toggled on, in that order (matching the two buttons left-to-right),
    // joined by " | " -- omitted entirely if neither is on, or if this
    // product has no value for what's toggled on (a still-unsynced row).
    function pricesRowHtml(p) {
      const parts = [];
      if (showLanding && p.landing_cost_amd != null) parts.push(formatAmd(Number(p.landing_cost_amd)));
      if (showWholesale && p.bronze_price_amd != null) parts.push(formatAmd(Number(p.bronze_price_amd)));
      if (!parts.length) return "";
      return `<div class="inventory-row-prices">${parts.join(" | ")}</div>`;
    }

    // "570pcs | 7,090L" -- a group's own stock summed across every product
    // in it (stock_qty null counts as 0, same as the qty each row already
    // shows individually), liters only appended when at least one product
    // in the group has a parseable per-unit liter size.
    function groupQtyLabel(totals) {
      const pcsLabel = `${totals.pcs}${t("warehouse_pcs_suffix")}`;
      return totals.liters > 0 ? `${pcsLabel} | ${formatLitersCompact(totals.liters)}` : pcsLabel;
    }

    function groupHeaderHtml({ label, toggleAttr, key, expanded, totals, extraClass = "" }) {
      return `
        <button type="button" class="list-group-heading list-group-heading-toggle ${extraClass}" ${toggleAttr}="${escapeHtml(key)}" aria-expanded="${expanded}">
          <span class="list-group-heading-label">${icons.chevronDown}${escapeHtml(label)}</span>
          <span class="list-group-heading-qty">${groupQtyLabel(totals)}</span>
        </button>`;
    }

    // Sums stock/liters per brand and per brand+family, for the collapsible
    // headers' own totals -- independent of which rows are actually
    // expanded/visible right now.
    function computeTotals(rows) {
      const brandTotals = new Map();
      const familyTotals = new Map();
      for (const p of rows) {
        const pcs = p.stock_qty ?? 0;
        const perUnitLiters = parseLiters(p.unit);
        const liters = perUnitLiters != null ? perUnitLiters * (p.stock_qty ?? 0) : 0;
        const bKey = p.brand || "";
        const bTotal = brandTotals.get(bKey) || { pcs: 0, liters: 0 };
        bTotal.pcs += pcs;
        bTotal.liters += liters;
        brandTotals.set(bKey, bTotal);
        const fKey = `${bKey}||${p.family || ""}`;
        const fTotal = familyTotals.get(fKey) || { pcs: 0, liters: 0 };
        fTotal.pcs += pcs;
        fTotal.liters += liters;
        familyTotals.set(fKey, fTotal);
      }
      return { brandTotals, familyTotals };
    }

    function render() {
      if (!lastRows.length) {
        listEl.innerHTML = `<p class="empty-state">${t("no_products_found")}</p>`;
        return;
      }
      // Search, a brand filter (already scopes the list to one brand), or
      // either price toggle all auto-expand everything -- the price row
      // only exists on a product card, so with groups collapsed (the
      // default) pressing "show landing cost" would otherwise reveal
      // nothing at all. Doesn't touch the remembered manual state, so
      // clearing the search/toggle goes back to whatever the WM had open.
      const forceExpand = Boolean(searchInput.value.trim()) || Boolean(brandFilter) || showLanding || showWholesale;
      const { brandTotals, familyTotals } = computeTotals(lastRows);

      // Bucket the already-sorted rows into brand -> family -> [products];
      // sort order is preserved since compareProducts already groups same
      // brand/family runs together.
      const brands = [];
      const brandByKey = new Map();
      for (const p of lastRows) {
        const bKey = p.brand || "";
        let brand = brandByKey.get(bKey);
        if (!brand) {
          brand = { key: bKey, label: p.brand || t("warehouse_stock_unknown"), families: new Map(), familyOrder: [] };
          brandByKey.set(bKey, brand);
          brands.push(brand);
        }
        const fKey = p.family || "";
        let family = brand.families.get(fKey);
        if (!family) {
          family = { key: fKey, label: p.family || null, products: [] };
          brand.families.set(fKey, family);
          brand.familyOrder.push(fKey);
        }
        family.products.push(p);
      }

      let html = "";
      for (const brand of brands) {
        const brandExpanded = forceExpand || expandedBrands.has(brand.key);
        html += groupHeaderHtml({
          label: brand.label,
          toggleAttr: "data-brand-toggle",
          key: brand.key,
          expanded: brandExpanded,
          totals: brandTotals.get(brand.key) || { pcs: 0, liters: 0 },
        });
        if (!brandExpanded) continue;
        for (const fKey of brand.familyOrder) {
          const family = brand.families.get(fKey);
          if (!family.label) {
            // Non-oil / no family -- no sub-header, just the products.
            html += family.products.map(productRowHtml).join("");
            continue;
          }
          const familyKey = `${brand.key}||${fKey}`;
          const familyExpanded = forceExpand || expandedFamilies.has(familyKey);
          html += groupHeaderHtml({
            label: family.label,
            toggleAttr: "data-family-toggle",
            key: familyKey,
            expanded: familyExpanded,
            totals: familyTotals.get(familyKey) || { pcs: 0, liters: 0 },
            extraClass: "list-group-heading-family",
          });
          if (familyExpanded) html += family.products.map(productRowHtml).join("");
        }
      }
      listEl.innerHTML = html;

      listEl.querySelectorAll("[data-brand-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.brandToggle;
          if (expandedBrands.has(key)) expandedBrands.delete(key);
          else expandedBrands.add(key);
          render();
        });
      });
      listEl.querySelectorAll("[data-family-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.familyToggle;
          if (expandedFamilies.has(key)) expandedFamilies.delete(key);
          else expandedFamilies.add(key);
          render();
        });
      });
    }

    async function paint(q) {
      lastRows = (await api.getInventory(q, brandFilter)).sort(compareProducts);
      render();
    }
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => paint(searchInput.value.trim()), 250);
    });

    landingBtn.addEventListener("click", () => {
      showLanding = !showLanding;
      landingBtn.classList.toggle("filter-icon-btn-active", showLanding);
      landingBtn.setAttribute("aria-pressed", String(showLanding));
      render();
    });
    wholesaleBtn.addEventListener("click", () => {
      showWholesale = !showWholesale;
      wholesaleBtn.classList.toggle("filter-icon-btn-active", showWholesale);
      wholesaleBtn.setAttribute("aria-pressed", String(showWholesale));
      render();
    });

    brandBtn.addEventListener("click", async () => {
      if (!brandOptions) {
        try {
          brandOptions = await api.getInventoryBrands();
        } catch {
          brandOptions = [];
        }
      }
      const overlay = document.createElement("div");
      overlay.className = "sheet-overlay";
      overlay.innerHTML = `
        <div class="sheet filter-sheet">
          <h2>${t("filter_brand")}</h2>
          <div class="filter-sheet-options">
            <button type="button" class="filter-sheet-option ${brandFilter === "" ? "filter-sheet-option-selected" : ""}" data-value="">
              <span>${t("all_brands")}</span>
            </button>
            ${brandOptions
              .map(
                (b) => `
              <button type="button" class="filter-sheet-option ${b === brandFilter ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(b)}">
                <span>${escapeHtml(b)}</span>
              </button>`
              )
              .join("")}
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
      overlay.querySelectorAll(".filter-sheet-option").forEach((optBtn) => {
        optBtn.addEventListener("click", () => {
          brandFilter = optBtn.dataset.value;
          brandBtn.classList.toggle("filter-icon-btn-active", Boolean(brandFilter));
          overlay.remove();
          paint(searchInput.value.trim());
        });
      });
    });

    await paint("");
  }

  load();
}
