import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, canManageProducts } from "../state.js";
import { icons } from "../icons.js";

// Same brand ordering the order-creation flow uses, so the pricelist reads
// in the order a rep actually presents it to a customer.
const BRAND_PRIORITY = ["Castrol", "Lotos", "Royal"];

function sortedBrands(products) {
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
  return brands.sort((a, b) => {
    const pa = BRAND_PRIORITY.indexOf(a);
    const pb = BRAND_PRIORITY.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.localeCompare(b);
  });
}

const FAMILY_PRIORITY = ["Edge", "Magnatec", "GTX", "Vecton/CRB", "Engine oils", "Transmission oils", "Other"];

function sortProducts(products, sortBy) {
  const sorted = [...products];
  if (sortBy === "standard_price") return sorted.sort((a, b) => a.effective_standard_amd - b.effective_standard_amd);
  if (sortBy === "retail_price") return sorted.sort((a, b) => a.effective_retail_amd - b.effective_retail_amd);
  if (sortBy === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
  // Default: brand's own family order, then name -- the order a rep
  // actually presents a pricelist to a customer, not alphabetical.
  return sorted.sort((a, b) => {
    const fa = FAMILY_PRIORITY.indexOf(a.family ?? "Other");
    const fb = FAMILY_PRIORITY.indexOf(b.family ?? "Other");
    if (fa !== fb) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);
    return a.name.localeCompare(b.name);
  });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
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

  const brands = sortedBrands(products);
  const categories = [...new Set(products.map((p) => p.family).filter(Boolean))];
  const packages = [...new Set(products.map((p) => p.unit).filter(Boolean))].sort();
  const isDesktop = window.matchMedia("(min-width: 900px)").matches;

  let searchQuery = "";
  let brandFilter = "";
  let categoryFilter = "";
  let packageFilter = "";
  let priceMin = null;
  let priceMax = null;
  let specialOnly = false;
  let sortBy = "default";
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
        <span class="muted">${t("pricelist_subtitle")}</span>
      </div>
      <button type="button" class="icon-btn" id="select-mode-btn" aria-label="${t("select_products")}">${icons.checkCircle}</button>
      ${canManageProducts() ? `<button type="button" class="icon-btn" id="manage-btn" aria-label="${t("manage_prices")}">${icons.tag}</button>` : ""}
      <button type="button" class="icon-btn" id="export-btn" aria-label="${t("export")}">${icons.send}</button>
    </div>

    <div id="expiring-soon-banner" class="pricelist-no-print"></div>

    <div class="order-search-row pricelist-no-print">
      <input type="search" id="pricelist-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" />
    </div>
    <div class="pricelist-filter-row pricelist-no-print" id="pricelist-filter-row"></div>
    <div id="pricelist-select-bar" class="pricelist-select-bar pricelist-no-print" hidden></div>

    <div id="pricelist-catalog"></div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  container.querySelector("#manage-btn")?.addEventListener("click", () => navigate("#/settings"));
  container.querySelector("#export-btn").addEventListener("click", () => openExportSheet());

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
  const filterRow = container.querySelector("#pricelist-filter-row");
  function renderFilters() {
    filterRow.innerHTML = `
      <div class="segmented pricelist-brand-chips">
        <button type="button" class="chip ${!brandFilter ? "chip-active" : ""}" data-brand="">${t("all_brands")}</button>
        ${brands.map((b) => `<button type="button" class="chip ${brandFilter === b ? "chip-active" : ""}" data-brand="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join("")}
      </div>
      <div class="segmented pricelist-brand-chips">
        <button type="button" class="chip ${!categoryFilter ? "chip-active" : ""}" data-category="">${t("category_all")}</button>
        ${categories.map((c) => `<button type="button" class="chip ${categoryFilter === c ? "chip-active" : ""}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
      </div>
      <div class="segmented pricelist-brand-chips">
        <button type="button" class="chip ${!packageFilter ? "chip-active" : ""}" data-package="">${t("all_packages")}</button>
        ${packages.map((p) => `<button type="button" class="chip ${packageFilter === p ? "chip-active" : ""}" data-package="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join("")}
      </div>
      <div class="pricelist-filter-controls">
        <button type="button" class="chip ${specialOnly ? "chip-active" : ""}" id="special-only-toggle">${t("has_special_price")}</button>
        <select id="pricelist-sort" aria-label="${t("sort")}">
          <option value="default" ${sortBy === "default" ? "selected" : ""}>${t("sort_default")}</option>
          <option value="name" ${sortBy === "name" ? "selected" : ""}>${t("product_name")}</option>
          <option value="standard_price" ${sortBy === "standard_price" ? "selected" : ""}>${t("price_standard")}</option>
          <option value="retail_price" ${sortBy === "retail_price" ? "selected" : ""}>${t("price_retail")}</option>
        </select>
      </div>
      <div class="pricelist-price-range">
        <span class="muted">${t("price_range")}:</span>
        <input type="number" min="0" id="price-min" placeholder="${t("min")}" value="${priceMin ?? ""}" aria-label="${t("min")}" />
        <span class="muted">&ndash;</span>
        <input type="number" min="0" id="price-max" placeholder="${t("max")}" value="${priceMax ?? ""}" aria-label="${t("max")}" />
      </div>
    `;
    filterRow.querySelectorAll("[data-brand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        brandFilter = btn.dataset.brand;
        renderFilters();
        paint();
      });
    });
    filterRow.querySelectorAll("[data-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        categoryFilter = btn.dataset.category;
        renderFilters();
        paint();
      });
    });
    filterRow.querySelectorAll("[data-package]").forEach((btn) => {
      btn.addEventListener("click", () => {
        packageFilter = btn.dataset.package;
        renderFilters();
        paint();
      });
    });
    const priceMinInput = filterRow.querySelector("#price-min");
    const priceMaxInput = filterRow.querySelector("#price-max");
    const applyPriceRange = debounce(() => {
      priceMin = priceMinInput.value ? Number(priceMinInput.value) : null;
      priceMax = priceMaxInput.value ? Number(priceMaxInput.value) : null;
      paint();
    }, 300);
    priceMinInput.addEventListener("input", applyPriceRange);
    priceMaxInput.addEventListener("input", applyPriceRange);
    filterRow.querySelector("#special-only-toggle").addEventListener("click", () => {
      specialOnly = !specialOnly;
      renderFilters();
      paint();
    });
    filterRow.querySelector("#pricelist-sort").addEventListener("change", (e) => {
      sortBy = e.target.value;
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
      if (brandFilter && p.brand !== brandFilter) return false;
      if (categoryFilter && p.family !== categoryFilter) return false;
      if (packageFilter && p.unit !== packageFilter) return false;
      if (specialOnly && p.effective_special_amd === null) return false;
      if (priceMin !== null && p.effective_standard_amd < priceMin) return false;
      if (priceMax !== null && p.effective_standard_amd > priceMax) return false;
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
      catalogEl.innerHTML = renderDesktopTable(sortProducts(filtered, sortBy));
      return;
    }
    const visibleBrands = sortedBrands(filtered);
    catalogEl.innerHTML = visibleBrands.length
      ? visibleBrands
          .map((brand) => {
            const brandProducts = sortProducts(
              filtered.filter((p) => p.brand === brand),
              sortBy
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
        // The server's brand/family shorthand only covers those two
        // filters -- if anything else on screen is narrowing the list
        // (package, price range, search, special-only), fall back to an
        // explicit id list so the export can't include more than what's
        // actually visible.
        const onlyBrandOrFamily = !packageFilter && priceMin === null && priceMax === null && !specialOnly && !searchQuery.trim();
        if (onlyBrandOrFamily && (brandFilter || categoryFilter)) {
          if (brandFilter) params.brand = brandFilter;
          if (categoryFilter) params.family = categoryFilter;
        } else {
          params.ids = currentlyFiltered().map((p) => p.id).join(",");
        }
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
