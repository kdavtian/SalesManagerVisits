// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { t } from "../../i18n.js";
import { channelDisplayLabel, escapeHtml, formatDistance, haversineMeters } from "../../util.js";
import { api } from "../../api.js";

export function phoneMatches(ctx, c, q) {
  const query = ctx.phoneTailDigits(q);
  return query.length >= 3 && ctx.phoneTailDigits(c.phone).includes(query);
}

export function hideAddressResults(ctx) {
  ctx.searchPanelOpen = false;
  ctx.addressResultsEl.hidden = true;
  ctx.addressResultsEl.innerHTML = "";
}

export function renderSearchPanel(ctx) {
  const q = ctx.mapSearchInput.value.trim();
  if (q.length < 2) {
    ctx.hideAddressResults();
    return;
  }
  const ref = ctx.myLocation || (() => { const c = ctx.map.getCenter(); return { lat: c.lat, lng: c.lng }; })();
  const customers = ctx.lastMatches
    .map(({ c }) => ({ c, d: haversineMeters(ref.lat, ref.lng, c.lat, c.lng) }))
    .sort((a, b) => a.d - b.d);
  const shown = customers.slice(0, ctx.SEARCH_PANEL_CUSTOMER_CAP);
  const customerRows = shown
    .map(({ c, d }) => {
      const byPhone = ctx.phoneMatches(c, q);
      const sub = [byPhone ? c.phone : "", c.erp_customer_id ? `ID ${c.erp_customer_id}` : "", c.sales_channel ? channelDisplayLabel(c.sales_channel) : "", c.address || ""].filter(Boolean).join(" · ");
      return `<button type="button" class="map-sr-row" data-cid="${c.id}">
        <span class="map-sr-main"><strong>${escapeHtml(c.name)}</strong>${sub ? `<span class="muted">${escapeHtml(sub)}</span>` : ""}</span>
        <span class="map-sr-dist">${formatDistance(d)}</span>
      </button>`;
    })
    .join("");
  const showAddresses = q.length >= 3;
  const addressBody = ctx.addressLoading
    ? `<p class="map-sr-empty muted">${t("map_search_searching")}</p>`
    : ctx.addressResults.length
      ? ctx.addressResults.map((r, i) => `<button type="button" class="map-sr-row map-sr-address" data-aidx="${i}"><span class="map-sr-main"><strong>${escapeHtml(r.address)}</strong></span></button>`).join("")
      : `<p class="map-sr-empty muted">${t("map_search_no_addresses")}</p>`;
  // Tabs: nothing found among customers but addresses found -> show the addresses until the person picks a tab.
  if (!ctx.searchTabChosen) ctx.searchTab = !customers.length && showAddresses && ctx.addressResults.length ? "addresses" : "customers";
  if (!showAddresses) ctx.searchTab = "customers";
  const addrCount = ctx.addressLoading ? "…" : ctx.addressResults.length;
  ctx.addressResultsEl.innerHTML = `
    ${
      showAddresses
        ? `<div class="map-sr-tabs" role="tablist">
            <button type="button" role="tab" class="map-sr-tab ${ctx.searchTab === "customers" ? "map-sr-tab-active" : ""}" aria-selected="${ctx.searchTab === "customers"}" data-sr-tab="customers">${t("map_search_customers")} <span class="map-sr-count">${customers.length}</span></button>
            <button type="button" role="tab" class="map-sr-tab ${ctx.searchTab === "addresses" ? "map-sr-tab-active" : ""}" aria-selected="${ctx.searchTab === "addresses"}" data-sr-tab="addresses">${t("map_search_address_matches")} <span class="map-sr-count">${addrCount}</span></button>
          </div>`
        : `<p class="map-address-results-label">${t("map_search_customers")} · ${customers.length}</p>`
    }
    <div class="map-sr-list">${ctx.searchTab === "addresses" ? addressBody : customerRows || `<p class="map-sr-empty muted">${t("map_search_no_results")}</p>`}</div>
  `;
  ctx.addressResultsEl.querySelectorAll("[data-sr-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ctx.searchTab = btn.dataset.srTab;
      ctx.searchTabChosen = true;
      ctx.renderSearchPanel();
    })
  );
  ctx.searchPanelOpen = true;
  ctx.addressResultsEl.hidden = false;
  ctx.addressResultsEl.querySelectorAll("[data-cid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.hideAddressResults();
      ctx.mapSearchInput.blur();
      ctx.focusOnCustomerMarker(btn.dataset.cid);
    });
  });
  ctx.addressResultsEl.querySelectorAll("[data-aidx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.mapSearchInput.blur();
      ctx.selectAddressResult(ctx.addressResults[Number(btn.dataset.aidx)]);
    });
  });
}

export function selectAddressResult(ctx, result) {
  ctx.hideAddressResults();
  const latlng = L.latLng(result.lat, result.lng);
  ctx.map.setView(latlng, 16);
  if (ctx.addressSearchMarker) ctx.map.removeLayer(ctx.addressSearchMarker);
  ctx.addressSearchMarker = L.marker(latlng, {
    icon: L.divIcon({ className: "", html: ctx.SEARCH_PIN_HTML, iconSize: [26, 26], iconAnchor: [13, 26] }),
  }).addTo(ctx.map);
  ctx.addressSearchMarker.bindPopup(escapeHtml(result.address)).openPopup();
}

// Real external geocoding, unlike the instant client-side customer
// filter above -- only worth firing past a few characters (shorter is
// mostly noise and burns API calls for nothing) and on its own, longer
// debounce (400ms, matching the old address-search sheet) since it's a
// network round trip rather than a local array scan.
export async function runAddressSearch(ctx, query) {
  if (query.length < 3) {
    ctx.addressResults = [];
    ctx.addressLoading = false;
    ctx.renderSearchPanel();
    return;
  }
  const myToken = ++ctx.addressSearchToken;
  ctx.addressLoading = true;
  ctx.renderSearchPanel();
  let results = [];
  try {
    results = await api.searchAddress(query);
  } catch {
    results = [];
  }
  if (myToken !== ctx.addressSearchToken) return; // a newer query already superseded this one
  ctx.addressResults = results;
  ctx.addressLoading = false;
  ctx.renderSearchPanel();
}

// Dismiss the address-match dropdown on an outside tap, same as any other
// lightweight popover in this app -- it isn't a modal sheet, so nothing
// else should block interacting with the rest of the map while it's open.
export function dismissAddressResultsOutside(ctx, e) {
  // composedPath is fixed when the click starts: a tap on a panel button that re-renders the panel (a tab) has already
  // detached e.target by the time this runs, and closest() on a detached node would wrongly count it as "outside".
  const inside = (e.composedPath?.() ?? []).some((n) => n.classList?.contains("map-search-row")) || e.target.closest(".map-search-row");
  if (ctx.addressResultsEl && !ctx.addressResultsEl.hidden && !inside) ctx.hideAddressResults();
}
