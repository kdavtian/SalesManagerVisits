import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, canManageProducts } from "../state.js";
import { icons } from "../icons.js";
import { compareProducts, sortedBrands } from "../productSort.js";
import { NO_GROUP_KEY, openTriStateTreeSheet } from "../regionTree.js";

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

function sortProducts(products, sortBy, reversed = false) {
  const sorted = [...products];
  const flip = reversed ? -1 : 1;
  if (sortBy === "standard_price") sorted.sort((a, b) => flip * (a.effective_standard_amd - b.effective_standard_amd));
  else if (sortBy === "retail_price") sorted.sort((a, b) => flip * (a.effective_retail_amd - b.effective_retail_amd));
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

  let products, companyProfile;
  try {
    [products, companyProfile] = await Promise.all([api.listProducts(), api.getCompanyProfile()]);
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
  let packageFilter = "";
  let specialOnly = false;
  let sortBy = "default";
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
        <h1>${t("pricelist_title")}</h1>
      </div>
      <div class="detail-header-actions">
        <button type="button" class="icon-btn" id="select-mode-btn" aria-label="${t("select_products")}">${icons.checkCircle}</button>
        ${canManageProducts() ? `<button type="button" class="icon-btn" id="manage-btn" aria-label="${t("manage_prices")}">${icons.tag}</button>` : ""}
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
        <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="standard_price"><span>${t("price_standard")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
        <button class="sort-menu-item" role="menuitemradio" aria-checked="false" data-sort="retail_price"><span>${t("price_retail")}</span><span class="sort-menu-arrow" aria-hidden="true"></span></button>
      </div>
    </div>
    <div class="pricelist-filter-row pricelist-no-print" id="pricelist-filter-row"></div>
    <div id="pricelist-select-bar" class="pricelist-select-bar pricelist-no-print" hidden></div>

    <div id="pricelist-catalog"></div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  container.querySelector("#manage-btn")?.addEventListener("click", () => navigate("#/settings"));
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

  // Single-select bottom sheet, e.g. for the package/unit filter -- same
  // shape as customers.js's own openFilterSheet.
  function openFilterSheet(titleText, options, currentValue, onSelect) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${escapeHtml(titleText)}</h2>
        <div class="filter-sheet-options">
          ${options
            .map(
              (o) => `
            <button type="button" class="filter-sheet-option ${o.value === currentValue ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(o.value)}">
              <span>${escapeHtml(o.label)}</span>
              ${o.value === currentValue ? `<span class="filter-sheet-check">${icons.checkCircle}</span>` : ""}
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelectorAll(".filter-sheet-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        onSelect(btn.dataset.value);
        overlay.remove();
      });
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
            active: Boolean(packageFilter),
          })
        : "",
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

    filterRow.querySelector('[data-filter-btn="package"]')?.addEventListener("click", () => {
      openFilterSheet(
        t("unit"),
        [{ value: "", label: t("all_packages") }, ...packages.map((p) => ({ value: p, label: p }))],
        packageFilter,
        (value) => {
          packageFilter = value;
          renderFilters();
          paint();
        }
      );
    });

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
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedProductIds.size && !selectedProductIds.has(String(p.id))) return false;
      if (packageFilter && p.unit !== packageFilter) return false;
      if (specialOnly && p.effective_special_amd === null) return false;
      if (q && !`${p.name} ${p.sku ?? ""} ${p.brand ?? ""}`.toLowerCase().includes(q)) return false;
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
      catalogEl.innerHTML = renderDesktopTable(sortProducts(filtered, sortBy, sortReversed));
      return;
    }
    const visibleBrands = sortedBrands(filtered);
    catalogEl.innerHTML = visibleBrands.length
      ? visibleBrands
          .map((brand) => {
            const brandProducts = sortProducts(
              filtered.filter((p) => p.brand === brand),
              sortBy,
              sortReversed
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

  function productRowHtml(p) {
    // Price hierarchy (item 37): an active special is the loudest number
    // on the row; standard becomes secondary/muted; retail always shows,
    // clearly labeled, since it's the number a customer would recognize.
    const hasSpecial = p.effective_special_amd !== null;
    const selected = selectedIds.has(p.id);
    return `
      <div class="card pricelist-row ${selectMode ? "pricelist-row-selectable" : ""}" ${selectMode ? `data-select-id="${p.id}"` : ""}>
        ${selectMode ? `<span class="pricelist-select-check ${selected ? "pricelist-select-check-on" : ""}">${selected ? icons.checkCircle : ""}</span>` : ""}
        ${
          p.image_path
            ? `<img class="pricelist-row-thumb" src="${api.productImageUrl(p.id)}" alt="" loading="lazy" />`
            : `<span class="pricelist-row-thumb pricelist-row-thumb-placeholder">${icons.box}</span>`
        }
        <div class="pricelist-row-main">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="muted">${[p.brand, p.family, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}${p.sku ? ` · ${escapeHtml(p.sku)}` : ""}</span>
        </div>
        <div class="pricelist-row-prices">
          ${
            hasSpecial
              ? `<span class="pricelist-price-special">${formatAmd(p.effective_special_amd)}</span>
                 <span class="pricelist-price-standard-struck">${formatAmd(p.effective_standard_amd)}</span>`
              : `<span class="pricelist-price-standard">${formatAmd(p.effective_standard_amd)}</span>`
          }
          <span class="pricelist-price-retail">${t("price_retail")}: ${formatAmd(p.effective_retail_amd)}</span>
          ${hasSpecial ? `<span class="muted pricelist-special-valid">${t("valid_through")} ${escapeHtml(p.special_valid_to)}</span>` : ""}
        </div>
      </div>
    `;
  }

  // Dense table for wide viewports (item 35) -- same canonical fields as
  // the mobile card, just laid out as real table rows/columns instead of
  // squeezing a desktop table into phone width.
  function renderDesktopTable(list) {
    if (!list.length) return `<p class="empty-state">${t("no_products_found")}</p>`;
    return `
      <div class="pricelist-table-wrap">
        <table class="pricelist-table pricelist-desktop-table">
          <thead>
            <tr>
              <th>${t("brand")}</th>
              <th>${t("product_name")}</th>
              <th>${t("unit")}</th>
              <th>${t("price_standard")}</th>
              <th>${t("price_special_period")}</th>
              <th>${t("price_retail")}</th>
            </tr>
          </thead>
          <tbody>
            ${list
              .map(
                (p) => `
              <tr>
                <td>${escapeHtml(p.brand ?? "")}</td>
                <td>${escapeHtml(p.name)}</td>
                <td>${escapeHtml(p.unit ?? "")}</td>
                <td>${formatAmd(p.effective_standard_amd)}</td>
                <td>${p.effective_special_amd !== null ? `<strong class="pricelist-promo">${formatAmd(p.effective_special_amd)}</strong>` : "&mdash;"}</td>
                <td>${formatAmd(p.effective_retail_amd)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  paint();

  // --- Export sheet (items 15-21) ---
  function openExportSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("export")}</h2>
        <form id="export-form">
          <fieldset>
            <legend>${t("export_content")}</legend>
            <label class="radio-row"><input type="radio" name="content" value="all" checked /> ${t("export_content_all")}</label>
            <label class="radio-row"><input type="radio" name="content" value="filtered" /> ${t("export_content_filtered")}</label>
            ${
              selectedIds.size
                ? `<label class="radio-row"><input type="radio" name="content" value="selected" /> ${t("export_content_selected")} (${selectedIds.size})</label>`
                : ""
            }
          </fieldset>
          <fieldset>
            <legend>${t("export_columns")}</legend>
            <label class="radio-row"><input type="checkbox" name="col_standard" checked /> ${t("price_standard")}</label>
            <label class="radio-row"><input type="checkbox" name="col_special" checked /> ${t("price_special_period")}</label>
            <label class="radio-row"><input type="checkbox" name="col_retail" checked /> ${t("price_retail")}</label>
          </fieldset>
          <fieldset>
            <legend>${t("prepared_by")}</legend>
            <p class="muted">${escapeHtml(state.user.name)}${state.user.position ? ` · ${escapeHtml(state.user.position)}` : ""}</p>
          </fieldset>
          <div class="sheet-actions" style="flex-wrap:wrap;">
            <button type="button" class="btn" id="export-print-btn">${t("print_pdf")}</button>
            <button type="button" class="btn btn-primary" id="export-excel-btn">${t("download_excel")}</button>
          </div>
          <div class="sheet-actions">
            <button type="button" class="btn btn-block" id="cancel-export">${t("cancel")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-export").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    function readOptions() {
      const data = new FormData(overlay.querySelector("#export-form"));
      const content = data.get("content");
      const cols = ["standard", "special", "retail"].filter((c) => data.get(`col_${c}`));
      return { content, cols };
    }

    function docProductsFor(content) {
      if (content === "selected") return products.filter((p) => selectedIds.has(p.id));
      if (content === "filtered") return currentlyFiltered();
      return products;
    }

    overlay.querySelector("#export-print-btn").addEventListener("click", () => {
      const { content, cols } = readOptions();
      const docProducts = docProductsFor(content);
      overlay.remove();
      openPrintView(docProducts, cols);
    });

    overlay.querySelector("#export-excel-btn").addEventListener("click", () => {
      const { content, cols } = readOptions();
      const params = { cols: cols.join(",") };
      if (content === "selected") {
        params.ids = [...selectedIds].join(",");
      } else if (content === "filtered") {
        // The brand/category tree filter can span multiple brands/categories
        // at once, so there's no single brand/family shorthand left to fall
        // back to -- always send an explicit id list of whatever's actually
        // visible on screen right now.
        params.ids = currentlyFiltered().map((p) => p.id).join(",");
      }
      window.location.href = api.productsExportXlsxUrl(params);
      overlay.remove();
    });
  }

  // Full-page printable document -- reuses the browser's native print-to-
  // PDF flow (see @media print in styles.css) instead of a server-side PDF
  // renderer. Swaps the whole view rather than opening a new window so it
  // still has the app's cookies/session for nothing extra to fetch.
  function openPrintView(docProducts, cols) {
    const today = new Date().toLocaleDateString();
    const docBrands = sortedBrands(docProducts);
    root.innerHTML = `
      <div class="detail-header pricelist-no-print">
        <button class="icon-btn" id="exit-print-btn" aria-label="${t("cancel")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("pricelist_title")}</h1></div>
        <button type="button" class="icon-btn" id="do-print-btn" aria-label="${t("print")}">${icons.print ?? "🖨️"}</button>
      </div>
      <div class="pricelist-doc">
        <div class="pricelist-doc-header">
          <div>
            ${companyProfile.logo_path ? `<img src="${escapeHtml(companyProfile.logo_path)}" class="pricelist-doc-logo" alt="" />` : ""}
            <h1>${escapeHtml(companyProfile.name || "KAD Motors")}</h1>
            <p class="muted">
              ${[companyProfile.phone, companyProfile.email, companyProfile.website].filter(Boolean).map(escapeHtml).join(" · ")}
            </p>
            ${companyProfile.address ? `<p class="muted">${escapeHtml(companyProfile.address)}</p>` : ""}
            <p class="muted">${t("generated_on")} ${escapeHtml(today)}</p>
          </div>
          <div class="pricelist-rep-card">
            <span class="muted">${t("prepared_by")}</span>
            <strong>${escapeHtml(state.user.name)}</strong>
            ${state.user.position ? `<span>${escapeHtml(state.user.position)}</span>` : ""}
            ${state.user.phone ? `<span>${escapeHtml(state.user.phone)}</span>` : ""}
            <span>${escapeHtml(state.user.email)}</span>
          </div>
        </div>
        ${
          cols.includes("special")
            ? `<p class="pricelist-legend"><span>${t("special_price_validity_note")}</span></p>`
            : ""
        }
        ${docBrands
          .map((brand) => {
            const brandProducts = sortProducts(
              docProducts.filter((p) => p.brand === brand),
              "default"
            );
            return `
            <h2 class="pricelist-brand-heading">${escapeHtml(brand)}</h2>
            <div class="pricelist-table-wrap">
            <table class="pricelist-table">
              <thead>
                <tr>
                  <th>${t("product_name")}</th>
                  <th>${t("unit")}</th>
                  ${cols.includes("standard") ? `<th>${t("price_standard")}</th>` : ""}
                  ${cols.includes("special") ? `<th>${t("price_special_period")}</th>` : ""}
                  ${cols.includes("retail") ? `<th>${t("price_retail")}</th>` : ""}
                </tr>
              </thead>
              <tbody>
                ${brandProducts
                  .map(
                    (p) => `
                  <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>${escapeHtml(p.unit ?? "")}</td>
                    ${cols.includes("standard") ? `<td>${formatAmd(p.effective_standard_amd)}</td>` : ""}
                    ${
                      cols.includes("special")
                        ? `<td>${p.effective_special_amd !== null ? `<strong class="pricelist-promo">${formatAmd(p.effective_special_amd)}</strong> <span class="muted">(${escapeHtml(p.special_valid_from)} – ${escapeHtml(p.special_valid_to)})</span>` : "&mdash;"}</td>`
                        : ""
                    }
                    ${cols.includes("retail") ? `<td>${formatAmd(p.effective_retail_amd)}</td>` : ""}
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
    root.querySelector("#exit-print-btn").addEventListener("click", () => renderPricelist(root, navigate));
    root.querySelector("#do-print-btn").addEventListener("click", () => window.print());
  }
}
