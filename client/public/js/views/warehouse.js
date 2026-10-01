import { api } from "../api.js";
import { escapeHtml, formatAmd, customerNameLinkHtml, activateCustomerNameLinks, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { compareProducts, parseLiters, normalizeUnitLabel, normalizeProductKey } from "../productSort.js";

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
  // Inventory is the screen a WM actually lands on most -- "what's on the
  // shelf right now" is the default question, Pick List/Staging are for
  // the moment there's something queued to pack.
  let activeTab = "inventory";

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_warehouse")}</h1></div>
      </div>
      <div class="segmented" id="warehouse-tabs">
        <button type="button" class="chip" data-tab="pick-list">${t("warehouse_tab_pick_list")}</button>
        <button type="button" class="chip" data-tab="staging">${t("warehouse_tab_staging")}</button>
        <button type="button" class="chip chip-active" data-tab="inventory">${t("warehouse_tab_inventory")}</button>
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
            <strong>${escapeHtml(r.product_name)}${r.size ? ` · ${escapeHtml(normalizeUnitLabel(r.size))}` : ""}</strong>
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

    activateCustomerNameLinks(contentEl, navigate);

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
        <strong>${customerNameLinkHtml(o.customer_name, o.customer_id)}</strong>
        <p class="muted">${escapeHtml(o.address || "")}</p>
        <div class="card-list" style="margin:8px 0;">
          ${o.items.map((i) => `<div class="order-product-row"><span>${i.brand ? `${escapeHtml(i.brand)} · ` : ""}${escapeHtml(i.product_name)}${i.size ? ` · ${escapeHtml(normalizeUnitLabel(i.size))}` : ""} × ${i.quantity}</span></div>`).join("")}
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
        <div class="inventory-search-wrap">
          <input type="search" id="inventory-search" placeholder="${t("search")}" />
          <button type="button" class="inventory-search-filter-btn" id="inventory-filter-btn" aria-label="${t("warehouse_filters_title")}" title="${t("warehouse_filters_title")}">
            ${icons.tag}
          </button>
        </div>
        <button type="button" class="filter-icon-btn" id="inventory-days-btn" aria-label="${t("warehouse_show_days_left")}" title="${t("warehouse_show_days_left")}" aria-pressed="false">
          ${icons.clock}
        </button>
        <button type="button" class="filter-icon-btn" id="inventory-landing-btn" aria-label="${t("warehouse_show_landing_cost")}" title="${t("warehouse_show_landing_cost")}" aria-pressed="false">
          ${icons.costLetter}
          <span class="filter-icon-count" id="inventory-landing-btn-badge" aria-hidden="true" hidden></span>
        </button>
        <button type="button" class="filter-icon-btn" id="inventory-wholesale-btn" aria-label="${t("warehouse_show_wholesale_price")}" title="${t("warehouse_show_wholesale_price")}" aria-pressed="false">
          ${icons.wallet}
        </button>
      </div>
      <div id="inventory-list" class="card-list"></div>
    `;
    const listEl = contentEl.querySelector("#inventory-list");
    const searchInput = contentEl.querySelector("#inventory-search");
    const filterBtn = contentEl.querySelector("#inventory-filter-btn");
    const daysBtn = contentEl.querySelector("#inventory-days-btn");
    const landingBtn = contentEl.querySelector("#inventory-landing-btn");
    const landingBtnBadge = contentEl.querySelector("#inventory-landing-btn-badge");
    const wholesaleBtn = contentEl.querySelector("#inventory-wholesale-btn");
    let brandFilter = "";
    let sizeFilter = "";
    let stockFilter = "";
    let brandOptions = null;
    let sizeOptions = null;
    // One button, three states -- landing cost and net cost are both
    // "internal cost basis" figures a WM might want, and neither is common
    // enough to deserve its own permanent icon slot next to the always-on
    // wholesale-price toggle. Cycles off -> landing -> net -> off.
    let costMode = "off"; // "off" | "landing" | "net"
    let showWholesale = false;
    // Off by default -- the forecast is opt-in extra detail on an already
    // dense card, not something every WM wants to see on every visit.
    let showDaysLeft = false;
    let lastRows = [];
    // Collapsed by default -- a WM scanning the shelf list gets brand/family
    // totals up front and drills into only what they need. Keyed by brand
    // name alone, and by "brand||family" for the family level, so a state
    // survives across re-renders (a price-toggle click, a search) within
    // this screen visit, only resetting on tab switch/reload.
    const expandedBrands = new Set();
    const expandedFamilies = new Set();
    // While forceExpand is on (a search/filter/cost-toggle in effect), every
    // group starts open regardless of expandedBrands/Families above -- but
    // a group the WM explicitly collapses in that state needs to actually
    // stay collapsed, not spring back open on the next render (reported as
    // "tap landing cost and you can't collapse the list back"). These hold
    // that per-key override for as long as forceExpand stays on; cleared
    // the moment it goes off, so a later forced session starts fresh (matching
    // "auto-expand everything") and normal mode is governed purely by
    // expandedBrands/Families again, untouched by whatever was collapsed
    // under force.
    const forceCollapsedBrands = new Set();
    const forceCollapsedFamilies = new Set();
    let wasForceExpand = false;

    // A product with only one stocked size -- most non-oil items (filters,
    // pads), plus any oil not yet sold in multiple pack sizes. Single row,
    // size as its own flex:none chip so a long name's ellipsis can never
    // swallow it (see productGroupHtml below for the multi-size case).
    function productRowHtml(p) {
      const sizeLabel = p.unit ? normalizeUnitLabel(p.unit) : "";
      return `
        <div class="card inventory-row-card">
          <div class="inventory-row">
            <span class="inventory-row-name-wrap">
              <span class="inventory-row-name">${escapeHtml(p.name)}</span>
              ${sizeLabel ? `<span class="inventory-row-size-chip">${escapeHtml(sizeLabel)}</span>` : ""}
            </span>
            <span class="inventory-row-qty ${p.stock_qty == null ? "inventory-row-qty-unknown" : p.stock_qty > 0 ? "inventory-row-qty-ok" : "inventory-row-qty-zero"}">${inventoryQtyLabel(p)}</span>
          </div>
          ${daysLeftRowHtml(p)}
          ${pricesRowHtml(p)}
        </div>`;
    }

    // Wholesale price and cost-basis (landing/net) price lines, kept
    // separate rather than joined on one line (see costLine below) -- cost
    // basis is internal information a WM wants to see distinctly from the
    // customer-facing wholesale price, not folded into the same string.
    function wholesaleLine(p) {
      return showWholesale && p.bronze_price_amd != null ? formatAmd(Number(p.bronze_price_amd)) : "";
    }
    function costLine(p) {
      if (costMode === "landing" && p.landing_cost_amd != null) return `${t("lc_short")} ${formatAmd(Number(p.landing_cost_amd))}`;
      if (costMode === "net" && p.net_cost_amd != null) return `${t("nc_short")} ${formatAmd(Number(p.net_cost_amd))}`;
      return "";
    }
    // Shared by both the single-size row above and each variant pill below
    // -- wholesale price first (the customer-facing figure), cost basis on
    // its own line under it.
    function priceLines(p) {
      return [wholesaleLine(p), costLine(p)].filter(Boolean);
    }

    const DAYS_BADGE_CLASS = {
      critical: "inventory-days-badge-critical",
      low: "inventory-days-badge-low",
      ok: "inventory-days-badge-ok",
      dead: "inventory-days-badge-dead",
      slow: "inventory-days-badge-dead",
      new: "inventory-days-badge-new",
    };
    const TREND_ARROW = { up: " ↑", down: " ↓" };
    // Days-of-stock-left badge for one product row/variant (see
    // ../../../server/src/stockForecast.js for the model behind
    // stock_status/days_of_stock/demand_trend). Nothing to show for 'out'
    // (the zero-qty styling already says that) or 'unknown' (no stock_qty
    // on record to estimate from at all).
    function daysLeftBadgeHtml(p) {
      if (!showDaysLeft) return "";
      const status = p.stock_status;
      if (!status || status === "out" || status === "unknown") return "";
      let label;
      if (status === "dead") label = t("warehouse_stock_status_dead");
      else if (status === "new") label = t("warehouse_stock_status_new");
      else if (status === "slow") label = t("warehouse_stock_status_slow");
      else if (p.days_of_stock != null) {
        label = `${Math.round(p.days_of_stock)}${t("warehouse_days_left_suffix")}${TREND_ARROW[p.demand_trend] || ""}`;
      } else {
        return "";
      }
      return `<span class="inventory-days-badge ${DAYS_BADGE_CLASS[status] || ""}">${escapeHtml(label)}</span>`;
    }
    function daysLeftRowHtml(p) {
      const badge = daysLeftBadgeHtml(p);
      return badge ? `<div class="inventory-row-days">${badge}</div>` : "";
    }

    // One pill per stocked size within productGroupHtml -- size label (bold)
    // and quantity side by side, days-left badge and price lines (each
    // toggled on independently) stacked below since they differ per size
    // just like the qty does.
    function variantPillHtml(p) {
      const qtyKnown = p.stock_qty != null;
      const zero = qtyKnown && p.stock_qty === 0;
      const days = daysLeftBadgeHtml(p);
      const priceLineHtml = priceLines(p)
        .map((line) => `<span class="inventory-variant-pill-price">${line}</span>`)
        .join("");
      return `
        <span class="inventory-variant-pill">
          <span class="inventory-variant-pill-top">
            ${p.unit ? `<span class="inventory-variant-pill-size">${escapeHtml(normalizeUnitLabel(p.unit))}</span>` : ""}
            <span class="inventory-variant-pill-qty ${zero ? "inventory-variant-pill-qty-zero" : ""}">${qtyKnown ? `${p.stock_qty}${t("warehouse_pcs_suffix")}` : t("warehouse_stock_unknown")}</span>
          </span>
          ${days}
          ${priceLineHtml}
        </span>`;
    }

    // A product stocked in more than one size: name prints once, every
    // stocked size becomes its own pill underneath instead of a whole
    // separate near-identical card per size -- this is the thing that was
    // making 1L/4L/drum variants of the same oil hard to tell apart. Falls
    // back to the plain single row above when there's only one size, so a
    // filter or brake pad doesn't get a pointless one-pill row. The header
    // totals reuse groupQtyLabel/groupAmountLines (defined below) -- same
    // "118pcs | 222L" shape (plus a value line when a price mode is on) as
    // the brand/family headers, just summed across this one product's own
    // sizes instead.
    function productGroupHtml(group) {
      if (group.products.length === 1) return productRowHtml(group.products[0]);
      const totals = emptyTotals();
      for (const p of group.products) sumRowIntoTotals(totals, p);
      const amountLines = groupAmountLines(totals)
        .map((line) => `<div class="inventory-row-prices">${line}</div>`)
        .join("");
      return `
        <div class="card inventory-row-card">
          <div class="inventory-row">
            <span class="inventory-row-name">${escapeHtml(group.name)}</span>
            <span class="inventory-row-qty">${groupQtyLabel(totals)}</span>
          </div>
          ${amountLines}
          <div class="inventory-variant-pills">${group.products.map(variantPillHtml).join("")}</div>
        </div>`;
    }

    // Price lines on a single-size product's card: wholesale first, cost
    // basis (LC/NC) under it (see priceLines above), omitted entirely if
    // nothing is toggled on or this product has no value for what's
    // toggled (a still-unsynced row, or net cost simply never entered for
    // it).
    function pricesRowHtml(p) {
      return priceLines(p)
        .map((line) => `<div class="inventory-row-prices">${line}</div>`)
        .join("");
    }

    // "570pcs | 7,090L" -- a group's own stock summed across every product
    // in it (stock_qty null counts as 0, same as the qty each row already
    // shows individually), liters only appended when at least one product
    // in the group has a parseable per-unit liter size.
    function groupQtyLabel(totals) {
      const pcsLabel = `${totals.pcs}${t("warehouse_pcs_suffix")}`;
      return totals.liters > 0 ? `${pcsLabel} | ${formatLitersCompact(totals.liters)}` : pcsLabel;
    }

    // Stock *value* for a group of rows, at whichever price basis is
    // currently toggled on (same toggles the per-row price lines already
    // read -- wholesale, or LC/NC depending on costMode) -- omitted
    // entirely when that toggle is off, or when none of the rows in this
    // group have a value for it at all.
    function groupAmountLines(totals) {
      const lines = [];
      if (showWholesale && totals.wholesaleAmd > 0) lines.push(formatAmd(totals.wholesaleAmd));
      if (costMode === "landing" && totals.lcAmd > 0) lines.push(`${t("lc_short")} ${formatAmd(totals.lcAmd)}`);
      if (costMode === "net" && totals.ncAmd > 0) lines.push(`${t("nc_short")} ${formatAmd(totals.ncAmd)}`);
      return lines;
    }

    function groupHeaderHtml({ label, toggleAttr, key, expanded, totals, extraClass = "" }) {
      const amountLines = groupAmountLines(totals)
        .map((line) => `<div class="list-group-heading-amount">${line}</div>`)
        .join("");
      return `
        <button type="button" class="list-group-heading list-group-heading-toggle ${extraClass}" ${toggleAttr}="${escapeHtml(key)}" aria-expanded="${expanded}">
          <span class="list-group-heading-label">${icons.chevronDown}${escapeHtml(label)}</span>
          <span class="list-group-heading-qty">${groupQtyLabel(totals)}</span>
        </button>
        ${amountLines}`;
    }

    function emptyTotals() {
      return { pcs: 0, liters: 0, wholesaleAmd: 0, lcAmd: 0, ncAmd: 0 };
    }
    // Folds one product row's stock into a running totals object -- shared
    // by computeTotals (brand/family), productGroupHtml (one product's own
    // sizes) and the grand-total row (every currently loaded row), so all
    // four levels of subtotal are computed the exact same way.
    function sumRowIntoTotals(totals, p) {
      const pcs = p.stock_qty ?? 0;
      totals.pcs += pcs;
      const perUnitLiters = parseLiters(p.unit);
      if (perUnitLiters != null) totals.liters += perUnitLiters * pcs;
      if (p.bronze_price_amd != null) totals.wholesaleAmd += Number(p.bronze_price_amd) * pcs;
      if (p.landing_cost_amd != null) totals.lcAmd += Number(p.landing_cost_amd) * pcs;
      if (p.net_cost_amd != null) totals.ncAmd += Number(p.net_cost_amd) * pcs;
    }

    // Sums stock/liters/value per brand and per brand+family, for the
    // collapsible headers' own totals -- independent of which rows are
    // actually expanded/visible right now.
    function computeTotals(rows) {
      const brandTotals = new Map();
      const familyTotals = new Map();
      for (const p of rows) {
        const bKey = p.brand || "";
        if (!brandTotals.has(bKey)) brandTotals.set(bKey, emptyTotals());
        sumRowIntoTotals(brandTotals.get(bKey), p);
        const fKey = `${bKey}||${p.family || ""}`;
        if (!familyTotals.has(fKey)) familyTotals.set(fKey, emptyTotals());
        sumRowIntoTotals(familyTotals.get(fKey), p);
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
      const forceExpand =
        Boolean(searchInput.value.trim()) || Boolean(brandFilter) || Boolean(sizeFilter) || Boolean(stockFilter) || costMode !== "off" || showWholesale;
      if (!forceExpand && wasForceExpand) {
        // Leaving forced mode -- these overrides only ever meant anything
        // relative to forceExpand being on, so drop them rather than carry
        // stale entries into a later forced session.
        forceCollapsedBrands.clear();
        forceCollapsedFamilies.clear();
      }
      wasForceExpand = forceExpand;
      const { brandTotals, familyTotals } = computeTotals(lastRows);

      // Bucket the already-sorted rows into brand -> family -> [product
      // groups], each group being every stocked size of the same product
      // name (case-insensitive) -- sort order is preserved throughout since
      // compareProducts already groups same brand/family/name runs
      // together, sizes ascending.
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
          // Family-less products (no oil family, or a non-oil item like a
          // filter) get their own collapsible "Other" group instead of
          // rendering flat under the brand with no header at all.
          family = { key: fKey, label: p.family || t("warehouse_other_family"), groups: new Map(), groupOrder: [] };
          brand.families.set(fKey, family);
          brand.familyOrder.push(fKey);
        }
        const nameKey = normalizeProductKey(p.name);
        let group = family.groups.get(nameKey);
        if (!group) {
          group = { name: p.name, products: [] };
          family.groups.set(nameKey, group);
          family.groupOrder.push(nameKey);
        }
        group.products.push(p);
      }

      // Grand total across every row currently loaded (the full
      // search/filter result, not just what's expanded on screen) --
      // qty/liters always, stock value on top of that once a price mode is
      // toggled on, same shape as every other subtotal level below it.
      const grandTotals = emptyTotals();
      for (const p of lastRows) sumRowIntoTotals(grandTotals, p);
      const grandAmountLines = groupAmountLines(grandTotals)
        .map((line) => `<div class="inventory-grand-total-amount">${line}</div>`)
        .join("");
      let html = `
        <div class="inventory-grand-total">
          <div class="inventory-grand-total-row">
            <span class="inventory-grand-total-label">${t("warehouse_total_label")}</span>
            <span class="inventory-grand-total-qty">${groupQtyLabel(grandTotals)}</span>
          </div>
          ${grandAmountLines}
        </div>`;
      for (const brand of brands) {
        const brandExpanded = forceExpand ? !forceCollapsedBrands.has(brand.key) : expandedBrands.has(brand.key);
        html += groupHeaderHtml({
          label: brand.label,
          toggleAttr: "data-brand-toggle",
          key: brand.key,
          expanded: brandExpanded,
          totals: brandTotals.get(brand.key) || emptyTotals(),
        });
        if (!brandExpanded) continue;
        for (const fKey of brand.familyOrder) {
          const family = brand.families.get(fKey);
          const familyKey = `${brand.key}||${fKey}`;
          const familyExpanded = forceExpand ? !forceCollapsedFamilies.has(familyKey) : expandedFamilies.has(familyKey);
          html += groupHeaderHtml({
            label: family.label,
            toggleAttr: "data-family-toggle",
            key: familyKey,
            expanded: familyExpanded,
            totals: familyTotals.get(familyKey) || emptyTotals(),
            extraClass: "list-group-heading-family",
          });
          if (familyExpanded) html += family.groupOrder.map((k) => productGroupHtml(family.groups.get(k))).join("");
        }
      }
      listEl.innerHTML = html;

      listEl.querySelectorAll("[data-brand-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.brandToggle;
          if (forceExpand) {
            if (forceCollapsedBrands.has(key)) forceCollapsedBrands.delete(key);
            else forceCollapsedBrands.add(key);
          } else if (expandedBrands.has(key)) {
            expandedBrands.delete(key);
          } else {
            expandedBrands.add(key);
          }
          render();
        });
      });
      listEl.querySelectorAll("[data-family-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.familyToggle;
          if (forceExpand) {
            if (forceCollapsedFamilies.has(key)) forceCollapsedFamilies.delete(key);
            else forceCollapsedFamilies.add(key);
          } else if (expandedFamilies.has(key)) {
            expandedFamilies.delete(key);
          } else {
            expandedFamilies.add(key);
          }
          render();
        });
      });
    }

    async function paint(q) {
      lastRows = (await api.getInventory(q, { brand: brandFilter, size: sizeFilter, stock: stockFilter })).sort(compareProducts);
      render();
    }
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => paint(searchInput.value.trim()), 250);
    });

    const COST_MODE_LABEL = { off: t("warehouse_show_landing_cost"), landing: t("lc_short"), net: t("nc_short") };
    landingBtn.addEventListener("click", () => {
      costMode = costMode === "off" ? "landing" : costMode === "landing" ? "net" : "off";
      landingBtn.classList.toggle("filter-icon-btn-active", costMode !== "off");
      landingBtn.setAttribute("aria-pressed", String(costMode !== "off"));
      landingBtn.setAttribute("aria-label", COST_MODE_LABEL[costMode]);
      landingBtn.title = COST_MODE_LABEL[costMode];
      landingBtnBadge.hidden = costMode !== "net";
      landingBtnBadge.textContent = costMode === "net" ? "N" : "";
      render();
    });
    wholesaleBtn.addEventListener("click", () => {
      showWholesale = !showWholesale;
      wholesaleBtn.classList.toggle("filter-icon-btn-active", showWholesale);
      wholesaleBtn.setAttribute("aria-pressed", String(showWholesale));
      render();
    });
    daysBtn.addEventListener("click", () => {
      showDaysLeft = !showDaysLeft;
      daysBtn.classList.toggle("filter-icon-btn-active", showDaysLeft);
      daysBtn.setAttribute("aria-pressed", String(showDaysLeft));
      render();
    });

    const STOCK_FILTER_OPTIONS = [
      { value: "on_stock", label: t("warehouse_in_stock") },
      { value: "low_stock", label: t("warehouse_stock_low") },
      { value: "out_of_stock", label: t("warehouse_stock_out") },
    ];
    // Full-width list, one option per row with a checkmark -- used for
    // Brand, where names vary a lot in length and there's usually a
    // handful of them, so a scannable list reads better than a chip grid.
    function filterSectionHtml(title, options, currentValue, dataAttr) {
      return `
        <div class="filter-sheet-section">
          <h3 class="filter-sheet-section-title">${escapeHtml(title)}</h3>
          <div class="filter-sheet-options">
            ${options
              .map(
                (o) => `
              <button type="button" class="filter-sheet-option ${o.value === currentValue ? "filter-sheet-option-selected" : ""}" data-${dataAttr}="${escapeHtml(o.value)}">
                <span>${escapeHtml(o.label)}</span>
                ${o.value === currentValue ? `<span class="filter-sheet-check">${icons.checkCircle}</span>` : ""}
              </button>`
              )
              .join("")}
          </div>
        </div>`;
    }

    // Compact wrapping pill grid -- used for Size and Stock status, where
    // every label is short (a size, or one of three fixed words). The old
    // one-row-per-size vertical list was the "messy" part of this sheet:
    // a catalog with many sizes turned into a long scroll of near-identical
    // rows. A wrapping chip grid fits far more options in the same space
    // and reads as a single glanceable set instead of a list to scroll.
    function filterChipSectionHtml(title, options, currentValue, dataAttr) {
      return `
        <div class="filter-sheet-section">
          <h3 class="filter-sheet-section-title">${escapeHtml(title)}</h3>
          <div class="filter-sheet-chips">
            ${options
              .map(
                (o) => `
              <button type="button" class="filter-sheet-chip ${o.value === currentValue ? "filter-sheet-chip-selected" : ""}" data-${dataAttr}="${escapeHtml(o.value)}">
                ${escapeHtml(o.label)}
              </button>`
              )
              .join("")}
          </div>
        </div>`;
    }

    // One sheet, three independent single-select sections (brand/size/stock
    // status) -- each tap just re-highlights within its own section rather
    // than closing the sheet, since picking e.g. a brand AND a stock status
    // in the same visit is the whole point of combining them. Clear resets
    // all three; Done commits whichever combination is currently selected.
    filterBtn.addEventListener("click", async () => {
      if (!brandOptions) {
        try {
          brandOptions = await api.getInventoryBrands();
        } catch {
          brandOptions = [];
        }
      }
      if (!sizeOptions) {
        try {
          sizeOptions = (await api.getInventorySizes()).sort((a, b) => {
            const la = parseLiters(a);
            const lb = parseLiters(b);
            if (la != null && lb != null) return la - lb;
            if (la != null) return -1;
            if (lb != null) return 1;
            return a.localeCompare(b);
          });
        } catch {
          sizeOptions = [];
        }
      }
      let workingBrand = brandFilter;
      let workingSize = sizeFilter;
      let workingStock = stockFilter;

      const overlay = document.createElement("div");
      overlay.className = "sheet-overlay";
      overlay.innerHTML = `
        <div class="sheet filter-sheet">
          <h2>${t("warehouse_filters_title")}</h2>
          ${filterSectionHtml(t("filter_brand"), [{ value: "", label: t("all_brands") }, ...brandOptions.map((b) => ({ value: b, label: b }))], workingBrand, "brand-value")}
          ${filterChipSectionHtml(
            t("warehouse_filter_size"),
            [{ value: "", label: t("warehouse_all_sizes") }, ...sizeOptions.map((s) => ({ value: s, label: normalizeUnitLabel(s) }))],
            workingSize,
            "size-value"
          )}
          ${filterChipSectionHtml(t("warehouse_filter_stock"), [{ value: "", label: t("all_statuses") }, ...STOCK_FILTER_OPTIONS], workingStock, "stock-value")}
          <div class="sheet-actions">
            <button type="button" class="btn" id="inventory-filter-clear">${t("clear")}</button>
            <button type="button" class="btn btn-primary" id="inventory-filter-done">${t("done")}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      activateDialog(overlay);
      overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

      // Brand uses the full-row list (with its own checkmark element);
      // size/stock use the compact chip grid (selected state is just its
      // own background/border, no separate checkmark node to manage).
      function reselectList(groupSelector, attr, value) {
        overlay.querySelectorAll(groupSelector).forEach((btn) => {
          const selected = btn.dataset[attr] === value;
          btn.classList.toggle("filter-sheet-option-selected", selected);
          const check = btn.querySelector(".filter-sheet-check");
          if (selected && !check) btn.insertAdjacentHTML("beforeend", `<span class="filter-sheet-check">${icons.checkCircle}</span>`);
          else if (!selected && check) check.remove();
        });
      }
      function reselectChips(groupSelector, attr, value) {
        overlay.querySelectorAll(groupSelector).forEach((btn) => {
          btn.classList.toggle("filter-sheet-chip-selected", btn.dataset[attr] === value);
        });
      }
      overlay.querySelectorAll("[data-brand-value]").forEach((btn) => {
        btn.addEventListener("click", () => {
          workingBrand = btn.dataset.brandValue;
          reselectList("[data-brand-value]", "brandValue", workingBrand);
        });
      });
      overlay.querySelectorAll("[data-size-value]").forEach((btn) => {
        btn.addEventListener("click", () => {
          workingSize = btn.dataset.sizeValue;
          reselectChips("[data-size-value]", "sizeValue", workingSize);
        });
      });
      overlay.querySelectorAll("[data-stock-value]").forEach((btn) => {
        btn.addEventListener("click", () => {
          workingStock = btn.dataset.stockValue;
          reselectChips("[data-stock-value]", "stockValue", workingStock);
        });
      });

      function commit(brand, size, stock) {
        brandFilter = brand;
        sizeFilter = size;
        stockFilter = stock;
        filterBtn.classList.toggle("inventory-search-filter-btn-active", Boolean(brandFilter || sizeFilter || stockFilter));
        overlay.remove();
        paint(searchInput.value.trim());
      }
      overlay.querySelector("#inventory-filter-clear").addEventListener("click", () => commit("", "", ""));
      overlay.querySelector("#inventory-filter-done").addEventListener("click", () => commit(workingBrand, workingSize, workingStock));
    });

    await paint("");
  }

  load();
}
