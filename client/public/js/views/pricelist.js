import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, canManageProducts, seesProductCosts, canPrintCostColumns } from "../state.js";
import { icons } from "../icons.js";
import { compareProducts, sortedBrands } from "../productSort.js";
import { NO_GROUP_KEY, openTriStateTreeSheet } from "../regionTree.js";
import { searchProducts } from "../productSearch.js";

// Brand -> Category (family) -> Product, for the pricelist's own filter
// sheet (Brand>Category>product per the tree-picker's generic {key, name,
// allIds, customerCount, leaves, children} shape from regionTree.js).
// Brand order follows the same priority list every other product screen
// uses (productSort.js); a product missing a brand/category falls into a
// trailing "unbranded"/"uncategorized" bucket rather than being dropped.
function buildProductTree(products) {
  const brandKeys = [...sortedBrands(products), ...(products.some((p) => !p.brand) ? [NO_GROUP_KEY] : [])];

  return brandKeys.map((brandKey, i) => {
    const brandProducts = products.filter((p) => (p.brand || NO_GROUP_KEY) === brandKey);
    const key = `b${i}`;
    const categoryMap = new Map();
    const categoryOrder = [];
    for (const p of brandProducts) {
      const cKey = p.family || NO_GROUP_KEY;
      if (!categoryMap.has(cKey)) {
        categoryMap.set(cKey, []);
        categoryOrder.push(cKey);
      }
      categoryMap.get(cKey).push(p);
    }
    categoryOrder.sort((a, b) => {
      if (a === NO_GROUP_KEY) return 1;
      if (b === NO_GROUP_KEY) return -1;
      return a.localeCompare(b);
    });

    return {
      key,
      name: brandKey === NO_GROUP_KEY ? t("pricelist_no_brand") : brandKey,
      allIds: brandProducts.map((p) => p.id),
      customerCount: brandProducts.length,
      leaves: null,
      children: categoryOrder.map((cKey, j) => {
        const categoryProducts = [...categoryMap.get(cKey)].sort((a, b) => a.name.localeCompare(b.name));
        return {
          key: `${key}-c${j}`,
          name: cKey === NO_GROUP_KEY ? t("pricelist_no_category") : cKey,
          allIds: categoryProducts.map((p) => p.id),
          customerCount: categoryProducts.length,
          leaves: categoryProducts.map((p) => ({ id: p.id, name: p.name })),
          children: null,
        };
      }),
    };
  });
}

// Price columns a user can show. Gold, landing cost and net cost are
// management-only (the API does not even send them to anyone else).
const PRICE_COLUMNS = [
  { key: "bronze", label: () => t("col_bronze"), get: (p) => p.bronze_price_amd ?? p.unit_price_amd },
  { key: "silver", label: () => t("col_silver"), get: (p) => p.silver_price_amd },
  { key: "gold", label: () => t("col_gold"), get: (p) => p.gold_price_amd, costOnly: true },
  { key: "retail", label: () => t("price_retail"), get: (p) => p.effective_retail_amd },
  { key: "landing", label: () => t("landing_cost"), get: (p) => p.landing_cost_amd, costOnly: true },
  { key: "net", label: () => t("net_cost"), get: (p) => p.net_cost_amd, costOnly: true },
];
const COLUMNS_STORAGE_KEY = "fv_products_cols";
const DEFAULT_COLUMNS = ["silver", "retail"];

function allowedColumns() {
  return PRICE_COLUMNS.filter((c) => !c.costOnly || seesProductCosts());
}

function loadVisibleColumns() {
  const allowed = new Set(allowedColumns().map((c) => c.key));
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) || "null");
    const valid = Array.isArray(saved) ? saved.filter((k) => allowed.has(k)) : [];
    if (valid.length) return valid;
  } catch {
    // storage unavailable -- defaults
  }
  return DEFAULT_COLUMNS;
}

function colValue(p, key) {
  const n = PRICE_COLUMNS.find((c) => c.key === key)?.get(p);
  return n == null || n === "" || Number(n) <= 0 ? null : Number(n);
}

function sortProducts(products, sortBy, reversed = false, primaryColumn = "silver") {
  const sorted = [...products];
  const flip = reversed ? -1 : 1;
  if (sortBy === "price") sorted.sort((a, b) => flip * ((colValue(a, primaryColumn) ?? 0) - (colValue(b, primaryColumn) ?? 0)));
  else if (sortBy === "retail_price") sorted.sort((a, b) => flip * ((colValue(a, "retail") ?? 0) - (colValue(b, "retail") ?? 0)));
  else if (sortBy === "name") sorted.sort((a, b) => flip * a.name.localeCompare(b.name));
  // Default: the order a rep actually presents a pricelist to a
  // customer -- brand, then family, then viscosity grade, then size --
  // not alphabetical. See productSort.js for the full priority lists.
  else sorted.sort((a, b) => flip * compareProducts(a, b));
  return sorted;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// dateStr is a plain calendar date (product_promos.ends_on, no time
// component). Parsing it via `new Date(dateStr)` reads it as UTC
// midnight; .setHours(0,0,0,0) then re-zeroes it in the LOCAL day that
// UTC instant falls on, which is the previous day in any timezone
// behind UTC -- shifting every promo's expiry by a day for those
// viewers (same bug class fixed in debtBalances.js's formatDateOnly).
// Read the y/m/d digits straight out of the string and build a local
// Date from them instead, so it's never round-tripped through UTC.
function daysUntil(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!match) return NaN;
  const [, yyyy, mm, dd] = match;
  const target = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

export async function renderPricelist(root, navigate) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let products;
  try {
    products = await api.listProducts();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const packages = [...new Set(products.map((p) => p.unit).filter(Boolean))].sort();
  const isDesktop = window.matchMedia("(min-width: 900px)").matches;

  let searchQuery = "";
  // Ids of the specific products picked in the Brand>Category>Product tree
  // sheet -- empty means no filter applied (same convention as
  // customers.js's regionSubregionKeys), rather than an explicit "all
  // brands"/"all categories" state to track separately.
  const selectedProductIds = new Set();
  const packageFilters = new Set();
  let specialOnly = false;
  let sortBy = "default";
  let visibleColumns = loadVisibleColumns();
  // A native <select> has no "tap the active option again" gesture, so
  // every other list's sort menu instead uses a dropdown where clicking the
  // already-active option flips the direction -- see customers.js's
  // #sort-btn/#sort-menu, replicated here.
  let sortReversed = false;
  let selectMode = false;
  const selectedIds = new Set();
  const collapsedBrands = new Set();

  container.innerHTML = `
    <div class="detail-header pricelist-no-print">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("products_page_title")}</h1>
      </div>
      <div class="detail-header-actions">
        <button type="button" class="icon-btn" id="select-mode-btn" aria-label="${t("select_products")}">${icons.checkCircle}</button>
        <button type="button" class="icon-btn" id="export-btn" aria-label="${t("export")}">${icons.send}</button>
      </div>
    </div>

    <div id="expiring-soon-banner" class="pricelist-no-print"></div>

    <div class="list-toolbar pricelist-no-print">
      <label class="visually-hidden" for="pricelist-search">${t("search_products_placeholder")}</label>
      <input type="search" id="pricelist-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" />
      <button class="icon-btn" id="pricelist-sort-btn" type="button" aria-label="${t("sort")}" aria-haspopup="menu" aria-expanded="false" aria-controls="pricelist-sort-menu">${icons.sort}</button>
      <div id="pricelist-sort-menu" class="dropdown-menu" role="menu" hidden>
        <button class="sort-menu-item" role="menuitemradio" aria-checked="true" data-sort="default"><span>${t("sort_default")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
        <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="name"><span>${t("product_name")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
        <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="price"><span>${t("sort_price")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
        <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="retail_price"><span>${t("price_retail")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
      </div>
    </div>
    <div class="pricelist-filter-row pricelist-no-print" id="pricelist-filter-row"></div>
    <div id="pricelist-select-bar" class="pricelist-select-bar pricelist-no-print" hidden></div>

    <div id="pricelist-catalog"></div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  container.querySelector("#export-btn").addEventListener("click", () => openExportSheet());

  const sortBtn = container.querySelector("#pricelist-sort-btn");
  const sortMenu = container.querySelector("#pricelist-sort-menu");
  sortBtn.addEventListener("click", () => {
    sortMenu.hidden = !sortMenu.hidden;
    sortBtn.setAttribute("aria-expanded", String(!sortMenu.hidden));
    if (!sortMenu.hidden) sortMenu.querySelector("button")?.focus();
  });
  function paintSortArrows() {
    sortMenu.querySelectorAll("[data-sort]").forEach((item) => {
      const arrow = item.querySelector(".sort-menu-arrow");
      arrow.textContent = item.dataset.sort === sortBy ? (sortReversed ? "▲" : "▼") : "";
    });
  }
  sortMenu.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.sort === sortBy) sortReversed = !sortReversed;
      else sortReversed = false;
      sortBy = btn.dataset.sort;
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
      sortMenu.querySelectorAll("button").forEach((item) => item.setAttribute("aria-checked", String(item === btn)));
      paintSortArrows();
      paint();
    });
  });
  paintSortArrows();
  container.addEventListener("click", (e) => {
    if (!sortMenu.hidden && !sortMenu.contains(e.target) && e.target !== sortBtn && !sortBtn.contains(e.target)) {
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
    }
  });
  sortMenu.addEventListener("keydown", (e) => {
    const items = [...sortMenu.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      sortMenu.hidden = true;
      sortBtn.setAttribute("aria-expanded", "false");
      sortBtn.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    }
  });

  // --- Expiring-soon banner (item 39) -- surfaces specials ending within
  // 3 days so a manager can decide whether to renew before they lapse.
  if (canManageProducts()) {
    const expiring = products.filter((p) => p.special_valid_to && daysUntil(p.special_valid_to) >= 0 && daysUntil(p.special_valid_to) <= 3);
    if (expiring.length) {
      container.querySelector("#expiring-soon-banner").innerHTML = `
        <div class="card pricelist-expiring-banner">
          ${icons.warning}
          <span>${expiring.length} ${t("products_expiring_soon")}</span>
        </div>
      `;
    }
  }

  // --- Filters ---
  // A compact 44px icon button that opens a bottom sheet -- same shape as
  // customers.js's own filterIconButton, kept local here since nothing
  // outside this view needs it (see customers.js for the original).
  function filterIconButton({ key, icon, label, active, count }) {
    const a11yLabel = count > 1 ? `${label} (${count})` : label;
    return `<button type="button" class="filter-icon-btn ${active ? "filter-icon-btn-active" : ""}" data-filter-btn="${key}" data-filter-count="${count || 0}" aria-label="${escapeHtml(a11yLabel)}" title="${escapeHtml(a11yLabel)}">
      ${icon}
      ${count > 1 ? `<span class="filter-icon-count" aria-hidden="true">${count}</span>` : active ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
    </button>`;
  }

  // Pack sizes as tappable chips (multi-select) with Clear / Show pinned at the
  // bottom of the sheet -- same pattern as the other filter sheets.
  function openSizeChipsSheet() {
    const picked = new Set(packageFilters);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <h2>${t("unit")}</h2>
        <div class="pd-edit-scroll">
          <div class="filter-sheet-chips" id="size-chips">
            ${packages
              .map((p) => `<button type="button" class="filter-sheet-chip ${picked.has(p) ? "filter-sheet-chip-selected" : ""}" data-size="${escapeHtml(p)}" aria-pressed="${picked.has(p)}">${escapeHtml(p)}</button>`)
              .join("")}
          </div>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="size-clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" id="size-show">${t("show_results")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#size-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-size]");
      if (!chip) return;
      const size = chip.dataset.size;
      if (picked.has(size)) picked.delete(size);
      else picked.add(size);
      chip.classList.toggle("filter-sheet-chip-selected", picked.has(size));
      chip.setAttribute("aria-pressed", String(picked.has(size)));
    });
    overlay.querySelector("#size-clear").addEventListener("click", () => {
      picked.clear();
      overlay.querySelectorAll("[data-size]").forEach((c) => {
        c.classList.remove("filter-sheet-chip-selected");
        c.setAttribute("aria-pressed", "false");
      });
    });
    overlay.querySelector("#size-show").addEventListener("click", () => {
      packageFilters.clear();
      for (const s of picked) packageFilters.add(s);
      overlay.remove();
      renderFilters();
      paint();
    });
  }

  // Which price columns the list shows (saved per device).
  function openColumnsSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${t("price_columns")}</h2>
        <div class="filter-sheet-options">
          ${allowedColumns()
            .map(
              (c) => `<label class="filter-sheet-option pl-col-option">
                <span>${escapeHtml(c.label())}</span>
                <input type="checkbox" data-col="${c.key}" ${visibleColumns.includes(c.key) ? "checked" : ""} />
              </label>`
            )
            .join("")}
        </div>
        <div class="sheet-actions"><button type="button" class="btn btn-primary" id="cols-apply">${t("show_results")}</button></div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#cols-apply").addEventListener("click", () => {
      const picked = [...overlay.querySelectorAll("[data-col]:checked")].map((i) => i.dataset.col);
      visibleColumns = picked.length ? picked : DEFAULT_COLUMNS;
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(visibleColumns));
      } catch {
        // storage unavailable -- applies for this visit only
      }
      overlay.remove();
      renderFilters();
      paint();
    });
  }

  const filterRow = container.querySelector("#pricelist-filter-row");
  function renderFilters() {
    filterRow.innerHTML = [
      filterIconButton({
        key: "tree",
        icon: icons.filter,
        label: t("pricelist_filter_title"),
        active: selectedProductIds.size > 0,
        count: selectedProductIds.size,
      }),
      packages.length
        ? filterIconButton({
            key: "package",
            icon: icons.box,
            label: t("unit"),
            active: packageFilters.size > 0,
            count: packageFilters.size,
          })
        : "",
      filterIconButton({
        key: "columns",
        icon: icons.filter,
        label: t("price_columns"),
        active: visibleColumns.join() !== DEFAULT_COLUMNS.join(),
      }),
      filterIconButton({
        key: "special",
        icon: icons.tag,
        label: t("has_special_price"),
        active: specialOnly,
      }),
    ]
      .filter(Boolean)
      .join("");

    filterRow.querySelector('[data-filter-btn="tree"]')?.addEventListener("click", () => {
      openTriStateTreeSheet(t("pricelist_filter_title"), {
        tree: buildProductTree(products),
        initialSelectedIds: selectedProductIds,
        countUnitLabel: t("products_unit"),
        totalLabel: (n) => t("products_selected_count").replace("{n}", n),
        searchPlaceholder: t("pricelist_search_brands_categories"),
        onApply: (ids) => {
          selectedProductIds.clear();
          for (const id of ids) selectedProductIds.add(id);
          renderFilters();
          paint();
        },
      });
    });

    filterRow.querySelector('[data-filter-btn="package"]')?.addEventListener("click", () => openSizeChipsSheet());

    filterRow.querySelector('[data-filter-btn="columns"]')?.addEventListener("click", () => openColumnsSheet());

    filterRow.querySelector('[data-filter-btn="special"]')?.addEventListener("click", () => {
      specialOnly = !specialOnly;
      renderFilters();
      paint();
    });
  }
  renderFilters();

  const searchInput = container.querySelector("#pricelist-search");
  searchInput.addEventListener(
    "input",
    debounce(() => {
      searchQuery = searchInput.value;
      paint();
    }, 250)
  );

  function currentlyFiltered() {
    const base = searchQuery.trim() ? searchProducts(products, searchQuery) : products;
    return base.filter((p) => {
      if (selectedProductIds.size && !selectedProductIds.has(String(p.id))) return false;
      if (packageFilters.size && !packageFilters.has(p.unit)) return false;
      if (specialOnly && p.effective_special_amd === null) return false;
      return true;
    });
  }

  const catalogEl = container.querySelector("#pricelist-catalog");
  const selectBar = container.querySelector("#pricelist-select-bar");

  function renderSelectBar() {
    selectBar.hidden = !selectMode;
    if (!selectMode) return;
    selectBar.innerHTML = `
      <span>${selectedIds.size} ${t("selected")}</span>
      <button type="button" class="btn-link" id="select-clear-btn">${t("clear")}</button>
    `;
    selectBar.querySelector("#select-clear-btn").addEventListener("click", () => {
      selectedIds.clear();
      paint();
    });
  }

  container.querySelector("#select-mode-btn").addEventListener("click", () => {
    selectMode = !selectMode;
    if (!selectMode) selectedIds.clear();
    paint();
  });

  function paint() {
    renderSelectBar();
    const filtered = currentlyFiltered();
    // Desktop gets a dense table (item 35); mobile keeps the card list
    // (item 34) -- same data, laid out for the space actually available.
    if (isDesktop && !selectMode) {
      catalogEl.innerHTML = renderDesktopTable(sortProducts(filtered, sortBy, sortReversed, visibleColumns[0]));
      return;
    }
    const visibleBrands = sortedBrands(filtered);
    catalogEl.innerHTML = visibleBrands.length
      ? visibleBrands
          .map((brand) => {
            const brandProducts = sortProducts(
              filtered.filter((p) => p.brand === brand),
              sortBy,
              sortReversed,
              visibleColumns[0]
            );
            const collapsed = collapsedBrands.has(brand);
            return `
            <button type="button" class="pricelist-brand-toggle" data-toggle-brand="${escapeHtml(brand)}">
              <span>${escapeHtml(brand)}</span>
              <span class="muted">${brandProducts.length}</span>
              <span class="pricelist-collapse-icon">${collapsed ? icons.chevronDown : icons.chevronUp}</span>
            </button>
            <div class="card-list" ${collapsed ? "hidden" : ""}>
              ${brandProducts.map((p) => productRowHtml(p)).join("")}
            </div>
          `;
          })
          .join("")
      : `<p class="empty-state">${t("no_products_found")}</p>`;

    catalogEl.querySelectorAll("[data-toggle-brand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const brand = btn.dataset.toggleBrand;
        if (collapsedBrands.has(brand)) collapsedBrands.delete(brand);
        else collapsedBrands.add(brand);
        paint();
      });
    });
    catalogEl.querySelectorAll("[data-select-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const id = Number(el.dataset.selectId);
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        paint();
      });
    });
  }

  function thumbHtml(p) {
    return p.image_path
      ? `<img class="pricelist-row-thumb" src="${api.productImageUrl(p.id)}" alt="" loading="lazy" />`
      : `<span class="pricelist-row-thumb pricelist-row-thumb-placeholder">${icons.box}</span>`;
  }

  function productRowHtml(p) {
    // An active special is the loudest number on the row; otherwise the first
    // chosen price column is the bold one and the rest sit under it, small.
    const hasSpecial = p.effective_special_amd !== null;
    const selected = selectedIds.has(p.id);
    // Every price is one line "Silver: 8,500 AMD" (label and amount together);
    // the first chosen column is the bold one. An active special replaces the
    // first line's amount and keeps the regular one struck through under it.
    const priceLines = visibleColumns
      .map((key, i) => {
        const value = colValue(p, key);
        if (value == null) return "";
        const label = PRICE_COLUMNS.find((c) => c.key === key).label();
        if (i === 0 && hasSpecial) {
          return `<span class="pl-price-line pl-price-primary"><span class="pl-price-label">${escapeHtml(label)}:</span> <strong class="pricelist-price-special">${formatAmd(p.effective_special_amd)}</strong></span><span class="pricelist-price-standard-struck">${formatAmd(value)}</span>`;
        }
        return `<span class="pl-price-line ${i === 0 ? "pl-price-primary" : ""}"><span class="pl-price-label">${escapeHtml(label)}:</span> <strong>${formatAmd(value)}</strong></span>`;
      })
      .join("");
    return `
      <div class="card pricelist-row pricelist-row-open ${selectMode ? "pricelist-row-selectable" : ""}" ${selectMode ? `data-select-id="${p.id}"` : `data-open-id="${p.id}"`} role="button" tabindex="0">
        ${selectMode ? `<span class="pricelist-select-check ${selected ? "pricelist-select-check-on" : ""}">${selected ? icons.checkCircle : ""}</span>` : ""}
        ${thumbHtml(p)}
        <div class="pricelist-row-main">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="muted pricelist-row-meta">${[p.brand, p.family, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}</span>
        </div>
        <div class="pricelist-row-prices">
          ${priceLines}
          ${hasSpecial ? `<span class="muted pricelist-special-valid">${t("valid_through")} ${escapeHtml(p.special_valid_to)}</span>` : ""}
        </div>
      </div>
    `;
  }

  // Dense table for wide viewports -- amounts and sizes right-aligned.
  function renderDesktopTable(list) {
    if (!list.length) return `<p class="empty-state">${t("no_products_found")}</p>`;
    return `
      <div class="pricelist-table-wrap">
        <table class="pricelist-table pricelist-desktop-table">
          <thead>
            <tr>
              <th class="pl-th-photo"></th>
              <th>${t("brand")}</th>
              <th>${t("product_name")}</th>
              <th class="num">${t("size_label")}</th>
              ${visibleColumns.map((key) => `<th class="num">${escapeHtml(PRICE_COLUMNS.find((c) => c.key === key).label())}</th>`).join("")}
              <th class="num">${t("price_special_period")}</th>
            </tr>
          </thead>
          <tbody>
            ${list
              .map(
                (p) => `
              <tr class="pricelist-table-row" data-open-id="${p.id}" tabindex="0">
                <td class="pl-td-photo">${thumbHtml(p)}</td>
                <td>${escapeHtml(p.brand ?? "")}</td>
                <td>${escapeHtml(p.name)}</td>
                <td class="num">${escapeHtml(p.unit ?? "")}</td>
                ${visibleColumns.map((key) => `<td class="num">${colValue(p, key) != null ? formatAmd(colValue(p, key)) : "&mdash;"}</td>`).join("")}
                <td class="num">${p.effective_special_amd !== null ? `<strong class="pricelist-promo">${formatAmd(p.effective_special_amd)}</strong>` : "&mdash;"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // One delegated listener: tapping a card/row opens that product's detail card.
  catalogEl.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-id]");
    if (open) navigate(`#/product/${open.dataset.openId}`);
  });
  catalogEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const open = e.target.closest("[data-open-id]");
    if (open) navigate(`#/product/${open.dataset.openId}`);
  });

  paint();

  // --- Export sheet: PDF pricelist builder, Excel, workbook import -----------
  function openExportSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("export")}</h2>
        <div class="export-choices">
          <button type="button" class="btn btn-primary btn-block" id="export-pdf-btn">${t("pdf_builder_title")}</button>
          <button type="button" class="btn btn-block" id="export-excel-btn">${t("download_excel")}</button>
          ${canManageProducts() ? `<button type="button" class="btn btn-block" id="import-btn">${t("import_pricelist")}</button>` : ""}
        </div>
        <fieldset>
          <legend>${t("export_content")}</legend>
          <label class="radio-row"><input type="radio" name="content" value="all" checked /> ${t("export_content_all")}</label>
          <label class="radio-row"><input type="radio" name="content" value="filtered" /> ${t("export_content_filtered")}</label>
          ${selectedIds.size ? `<label class="radio-row"><input type="radio" name="content" value="selected" /> ${t("export_content_selected")} (${selectedIds.size})</label>` : ""}
        </fieldset>
        <div class="sheet-actions"><button type="button" class="btn btn-block" id="cancel-export">${t("cancel")}</button></div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-export").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    overlay.querySelector("#export-pdf-btn").addEventListener("click", () => {
      overlay.remove();
      openPdfBuilder();
    });
    overlay.querySelector("#import-btn")?.addEventListener("click", () => {
      overlay.remove();
      openImportSheet();
    });
    overlay.querySelector("#export-excel-btn").addEventListener("click", () => {
      const content = overlay.querySelector('input[name="content"]:checked').value;
      const params = { cols: "standard,special,retail" };
      if (content === "selected") params.ids = [...selectedIds].join(",");
      // The brand/category tree filter can span several brands at once, so
      // "filtered" always sends the explicit ids that are on screen now.
      else if (content === "filtered") params.ids = currentlyFiltered().map((p) => p.id).join(",");
      window.location.href = api.productsExportXlsxUrl(params);
      overlay.remove();
    });
  }

  // Per-user pricelist PDF (server-side, Armenian): the user's own contact
  // block for sales managers, office details for management.
  function openPdfBuilder() {
    const costs = seesProductCosts();
    // Bronze/Silver/Retail for everyone, Gold for management; landing / net cost
    // (an internal sheet) only for admin, CEO and operations director.
    const tierOptions = PRICE_COLUMNS.filter((c) => {
      if (c.key === "landing" || c.key === "net") return canPrintCostColumns();
      return !c.costOnly || costs;
    });
    const brands = sortedBrands(products);
    const nextMonthEnd = new Date();
    nextMonthEnd.setMonth(nextMonthEnd.getMonth() + 1, 0);
    const defaultValid = `${nextMonthEnd.getFullYear()}-${String(nextMonthEnd.getMonth() + 1).padStart(2, "0")}-${String(nextMonthEnd.getDate()).padStart(2, "0")}`;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <div class="pd-edit-scroll">
          <h2>${t("pdf_builder_title")}</h2>
          <fieldset>
            <legend>${t("price_columns")}</legend>
            ${tierOptions
              .map((c) => `<label class="radio-row"><input type="checkbox" name="col" value="${c.key}" ${["silver", "retail"].includes(c.key) || (c.key === "bronze" && !costs) ? "checked" : ""} /> ${escapeHtml(c.label())}</label>`)
              .join("")}
          </fieldset>
          <fieldset>
            <legend>${t("pdf_brands")}</legend>
            ${brands.map((b) => `<label class="radio-row"><input type="checkbox" name="brand" value="${escapeHtml(b)}" checked /> ${escapeHtml(b)}</label>`).join("")}
          </fieldset>
          <label class="radio-row"><input type="checkbox" id="pdf-photos" checked /> ${t("pdf_include_photos")}</label>
          <label class="radio-row"><input type="checkbox" id="pdf-commercial" checked /> ${t("pdf_include_commercial")}</label>
          <label class="field-label" for="pdf-valid">${t("pdf_valid_until")}</label>
          <input type="date" id="pdf-valid" value="${defaultValid}" />
          <p class="muted">${t(costs && state.user.role !== "sales_director" ? "pdf_contact_note_mgmt" : "pdf_contact_note")}</p>
          <p class="form-error" id="pdf-error" hidden></p>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pdf-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="pdf-build">${t("pdf_build")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#pdf-cancel").addEventListener("click", () => overlay.remove());
    const buildBtn = overlay.querySelector("#pdf-build");
    const errorEl = overlay.querySelector("#pdf-error");
    buildBtn.addEventListener("click", async () => {
      const columns = [...overlay.querySelectorAll('[name="col"]:checked')].map((i) => i.value);
      const picked = [...overlay.querySelectorAll('[name="brand"]:checked')].map((i) => i.value);
      errorEl.hidden = true;
      if (!columns.length) {
        errorEl.textContent = t("pdf_pick_column");
        errorEl.hidden = false;
        return;
      }
      buildBtn.disabled = true;
      buildBtn.textContent = t("pdf_building");
      try {
        const blob = await api.buildPricelistPdf({
          columns,
          brands: picked.length === brands.length ? null : picked,
          valid_until: overlay.querySelector("#pdf-valid").value,
          include_photos: overlay.querySelector("#pdf-photos").checked,
          include_commercial: overlay.querySelector("#pdf-commercial").checked,
        });
        const file = new File([blob], `kad-pricelist-${new Date().toISOString().slice(0, 10)}.pdf`, { type: "application/pdf" });
        // Phones: the native share sheet (WhatsApp, Telegram, mail...); desktop: a normal download.
        if (navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({ files: [file] });
          } catch {
            // user dismissed the share sheet
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        overlay.remove();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        buildBtn.disabled = false;
        buildBtn.textContent = t("pdf_build");
      }
    });
  }

  // Management: pull product photos and commercial specs out of the
  // company's pricelist workbook (preview first, then apply).
  function openImportSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <div class="pd-edit-scroll">
          <h2>${t("import_pricelist")}</h2>
          <input type="file" id="import-file" accept=".xlsx" />
          <label class="radio-row"><input type="checkbox" id="import-overwrite" /> ${t("import_overwrite")}</label>
          <div id="import-report" class="muted"></div>
          <p class="form-error" id="import-error" hidden></p>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="import-cancel">${t("cancel")}</button>
          <button type="button" class="btn" id="import-preview">${t("import_preview")}</button>
          <button type="button" class="btn btn-primary" id="import-apply" disabled>${t("import_apply")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#import-cancel").addEventListener("click", () => overlay.remove());
    const reportEl = overlay.querySelector("#import-report");
    const errorEl = overlay.querySelector("#import-error");
    const applyBtn = overlay.querySelector("#import-apply");

    async function run(apply) {
      const file = overlay.querySelector("#import-file").files[0];
      errorEl.hidden = true;
      if (!file) {
        errorEl.textContent = t("import_choose_file");
        errorEl.hidden = false;
        return;
      }
      const form = new FormData();
      form.append("file", file);
      form.append("apply", apply ? "1" : "0");
      form.append("overwrite", overlay.querySelector("#import-overwrite").checked ? "1" : "0");
      try {
        const r = await api.importPricelistWorkbook(form);
        const unmatched = r.unmatched_groups.slice(0, 12).map(escapeHtml).join("<br>");
        reportEl.innerHTML = `
          <p>${t("import_result").replace("{matched}", r.matched_groups).replace("{groups}", r.groups).replace("{products}", r.matched_products).replace("{photos}", r.groups_with_photo)}</p>
          ${apply ? `<p><strong>${t("import_applied").replace("{photos}", r.applied.photos).replace("{commercial}", r.applied.commercial)}</strong></p>` : ""}
          ${unmatched ? `<p><strong>${t("import_unmatched")}</strong><br>${unmatched}${r.unmatched_groups.length > 12 ? "<br>…" : ""}</p>` : ""}`;
        applyBtn.disabled = apply || r.matched_groups === 0;
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }
    overlay.querySelector("#import-preview").addEventListener("click", () => run(false));
    applyBtn.addEventListener("click", () => run(true));
  }
}
