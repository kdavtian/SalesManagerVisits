// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { MAP_DEFAULT_CHANNEL_FILTERS, NEARBY_RADIUS_METERS } from "../map.js";
import { CATEGORY_LIST, TIER_OPTIONS, activateDialog, channelDisplayLabel, escapeHtml, getCurrentPosition, haversineMeters } from "../../util.js";
import { t } from "../../i18n.js";
import { loadWithCache } from "../../listCache.js";
import { api } from "../../api.js";
import { brandSearchText, buildBrandChipTree, indexBrandSummary, matchesSelectedChips } from "../../brandChips.js";
import { FILTER_ICONS } from "../../filterIcons.js";
import { buildDirectionManagerTree, openTriStateTreeSheet } from "../../regionTree.js";
import { repColor } from "../../repColors.js";

export function passesAssignment(ctx, c) {
  // Default: only the field channels (a customer with no channel at all is never hidden by it).
  if (ctx.assignmentKeys === null) return !c.sales_channel || MAP_DEFAULT_CHANNEL_FILTERS.includes(c.sales_channel);
  return !ctx.assignmentKeys.size || ctx.assignmentKeys.has(ctx.assignmentKeyOf(c));
}

export function currentAssignmentIds(ctx) {
  if (ctx.assignmentKeys !== null) return ctx.assignmentKeys;
  return new Set(ctx.lastCustomers.filter(({ c }) => ctx.passesAssignment(c)).map(({ c }) => ctx.assignmentKeyOf(c)));
}

// Competitors stay hidden unless asked for; picking the Competitor tier (or a COMPETITORS
// channel) is that explicit ask, and un-picking it hides them again.
export function syncCompetitorsForFilters(ctx) {
  const mapView = ctx.root.querySelector(".map-view");
  if (!mapView) return;
  const wanted = ctx.tierFilters.has("competitor") || (ctx.assignmentKeys !== null && [...ctx.assignmentKeys].some((k) => k.startsWith("COMPETITORS::")));
  if (wanted && !mapView.classList.contains("kad-show-competitors")) {
    mapView.dataset.competitorsForcedByFilter = "true";
    mapView.classList.add("kad-show-competitors");
  } else if (!wanted && mapView.dataset.competitorsForcedByFilter === "true") {
    delete mapView.dataset.competitorsForcedByFilter;
    mapView.classList.remove("kad-show-competitors");
  }
}

export function openMapTypeTierSheet(ctx, currentCategories, currentTiers, onApply) {
  const workingCategories = new Set(currentCategories);
  const workingTiers = new Set(currentTiers);
  const tiers = ctx.MAP_TIER_ORDER.map((v) => TIER_OPTIONS.find((o) => o.value === v)).filter(Boolean);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet map-type-tier-sheet">
      <h2>${escapeHtml(t("customer_tier"))}</h2>
      <h3 class="map-tier-filter-title">${escapeHtml(t("customer_tier"))}</h3>
      <div class="tier-selector map-tier-filter-chips" role="group" aria-label="${escapeHtml(t("customer_tier"))}">
        ${tiers
          .map(
            (opt) => `
          <button type="button" class="tier-btn ${opt.cls} ${workingTiers.has(opt.value) ? "tier-btn-active" : ""}" data-tier="${opt.value}" aria-pressed="${workingTiers.has(opt.value)}">
            <span class="tier-icon">${opt.icon}</span>
            <span class="tier-label">${escapeHtml(t(opt.labelKey))}</span>
          </button>`
          )
          .join("")}
      </div>
      <h3 class="map-tier-filter-title">${escapeHtml(t("category"))}</h3>
      <div class="filter-sheet-options map-type-options">
        ${CATEGORY_LIST.map(
          (o) => `
          <button type="button" role="menuitemcheckbox" aria-checked="${workingCategories.has(o.value)}" class="filter-sheet-option ${workingCategories.has(o.value) ? "filter-sheet-option-selected" : ""}" data-value="${escapeHtml(o.value)}">
            <span class="filter-sheet-box" aria-hidden="true"></span>
            <span>${escapeHtml(t(o.labelKey))}</span>
          </button>`
        ).join("")}
      </div>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" id="map-type-tier-clear">${t("clear")}</button>
        <button type="button" class="btn btn-primary" id="map-type-tier-done">${t("show_results")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelectorAll(".filter-sheet-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.value;
      if (workingCategories.has(value)) workingCategories.delete(value);
      else workingCategories.add(value);
      btn.classList.toggle("filter-sheet-option-selected", workingCategories.has(value));
      btn.setAttribute("aria-checked", String(workingCategories.has(value)));
    });
  });
  overlay.querySelectorAll(".map-tier-filter-chips .tier-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.tier;
      if (workingTiers.has(value)) workingTiers.delete(value);
      else workingTiers.add(value);
      btn.classList.toggle("tier-btn-active", workingTiers.has(value));
      btn.setAttribute("aria-pressed", String(workingTiers.has(value)));
    });
  });
  overlay.querySelector("#map-type-tier-clear").addEventListener("click", () => {
    overlay.remove();
    onApply(new Set(), new Set());
  });
  overlay.querySelector("#map-type-tier-done").addEventListener("click", () => {
    overlay.remove();
    onApply(workingCategories, workingTiers);
  });
}

export function mapFilterIconButton(ctx, { key, icon, label, active, count }) {
  // Same "(2)" count-badge language as Customers.js's own multi-select
  // filter buttons -- a plain dot for zero/one selection, the actual
  // number once there's more than one to distinguish from a single-value
  // filter's own active state.
  const a11yLabel = count > 1 ? `${label} (${count})` : label;
  return `<button type="button" class="filter-icon-btn ${active ? "filter-icon-btn-active" : ""}" data-map-filter-btn="${key}" aria-label="${escapeHtml(a11yLabel)}" title="${escapeHtml(a11yLabel)}">
    ${icon}
    ${count > 1 ? `<span class="filter-icon-count" aria-hidden="true">${count}</span>` : active ? `<span class="filter-icon-dot" aria-hidden="true"></span>` : ""}
  </button>`;
}

// Best-effort: without the chips the map simply has no chip filter.
export async function loadBrandSummary(ctx) {
  try {
    await loadWithCache("customers-brand-summary", () => api.getBrandSummary(), (rows) => {
      ctx.brandSummary = indexBrandSummary(rows);
      ctx.renderIconFilterRow();
      if (ctx.brandChipIds.size || ctx.searchQuery) ctx.applyFilter({ refit: false });
    });
  } catch {
    /* optional feature */
  }
}

export function renderIconFilterRow(ctx) {
  if (!ctx.iconFilterRow) return;
  const assignmentIds = ctx.currentAssignmentIds();
  const assignmentChannelCount = new Set([...assignmentIds].map((k) => k.split("::")[0])).size;
  const typeCount = ctx.categoryFilters.size + ctx.tierFilters.size;

  ctx.iconFilterRow.innerHTML = [
    ctx.lastCustomers.length
      ? ctx.mapFilterIconButton({ key: "assignment", icon: FILTER_ICONS.manager, label: t("filter_direction_manager_title"), active: assignmentIds.size > 0, count: assignmentChannelCount })
      : "",
    ctx.brandSummary.size
      ? ctx.mapFilterIconButton({ key: "brandchips", icon: FILTER_ICONS.brands, label: t("filter_brands_title"), active: ctx.brandChipIds.size > 0, count: ctx.brandChipIds.size })
      : "",
    ctx.lastCustomers.length
      ? ctx.mapFilterIconButton({ key: "category", icon: FILTER_ICONS.category, label: t("category"), active: typeCount > 0, count: typeCount })
      : "",
  ]
    .filter(Boolean)
    .join("");

  ctx.iconFilterRow.querySelector('[data-map-filter-btn="assignment"]')?.addEventListener("click", () => {
    openTriStateTreeSheet(t("filter_direction_manager_title"), {
      tree: buildDirectionManagerTree(
        ctx.lastCustomers.map(({ c }) => c),
        { channelLabel: channelDisplayLabel, noDirectionLabel: t("no_direction"), unassignedLabel: t("unassigned") }
      ),
      initialSelectedIds: assignmentIds,
      countUnitLabel: t("perf_dq_customers_unit"),
      onApply: (selectedIds) => {
        ctx.assignmentKeys = new Set(selectedIds);
        ctx.renderIconFilterRow();
        // "Planned" follows the picked rep, so it has to re-fetch when the pick changes.
        if (ctx.activeFilter === "planned") ctx.loadPlannedFilter();
        else if (ctx.plannedMode !== "off") ctx.refreshPlannedToday();
        else ctx.applyFilter();
      },
    });
  });

  ctx.iconFilterRow.querySelector('[data-map-filter-btn="brandchips"]')?.addEventListener("click", () => {
    openTriStateTreeSheet(t("filter_brands_title"), {
      tree: buildBrandChipTree(ctx.brandSummary, ctx.lastCustomers.map(({ c }) => c.id)),
      initialSelectedIds: ctx.brandChipIds,
      countUnitLabel: t("perf_dq_customers_unit"),
      searchPlaceholder: t("search"),
      onApply: (selectedIds) => {
        ctx.brandChipIds = selectedIds;
        ctx.renderIconFilterRow();
        ctx.applyFilter();
      },
    });
  });

  ctx.iconFilterRow.querySelector('[data-map-filter-btn="category"]')?.addEventListener("click", () => {
    ctx.openMapTypeTierSheet(ctx.categoryFilters, ctx.tierFilters, (cats, tiers) => {
      ctx.categoryFilters = cats;
      ctx.tierFilters = tiers;
      ctx.renderIconFilterRow();
      ctx.applyFilter();
    });
  });
}

// available/full_range -> green, unavailable -> red (or absent from the
// competitors list -> unknown grey, since that list is presence-only --
// a competitor not ticked was never confirmed absent, just not recorded).
export function brandAvailabilityStatus(ctx, c) {
  const status = ctx.brandStatusByCustomer?.get(c.id);
  if (!status) return "unknown";
  if (ctx.selectedBrand.startsWith("competitor:")) {
    const key = ctx.selectedBrand.slice("competitor:".length);
    return (status.competitors ?? []).includes(key) ? "available" : "unknown";
  }
  const tags = status[ctx.selectedBrand] ?? [];
  if (tags.includes("available") || tags.includes("full_range")) return "available";
  if (tags.includes("unavailable")) return "unavailable";
  return "unknown";
}

export function brandAvailabilityIcon(ctx, c) {
  const level = ctx.brandAvailabilityStatus(c);
  return L.divIcon({
    className: "",
    html: `<div class="brand-dot brand-dot-${level}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -9],
  });
}

// refit: whether this pass may move the camera to fit the visible pins.
// True for something the USER just did (a filter, search, toggle); false
// for a background repaint (live data arriving after the cached list, the
// brand summary or task flags loading) -- those used to re-run fitBounds
// and yank the map to a zoomed-out view a moment after it had settled.
export function applyFilter(ctx, { refit = true } = {}) {
  ctx.paintRepLegend();
  ctx.markerLayer.clearLayers();
  ctx.customerMarkerLayer.clearLayers();
  const bounds = [];
  const sideListEntries = [];
  // Collected and added to customerMarkerLayer in one addLayers() call
  // after the loop, instead of marker.addTo() inside it -- each
  // individual addLayer() on a MarkerClusterGroup re-runs its own
  // clustering pass, so adding one at a time turned every filter change
  // (search keystroke, toggle tap) into O(n) separate re-clusters for a
  // customer base past ~180 pins. One addLayers() call clusters the
  // whole batch in a single pass. Falls back to individual addTo() for
  // the plain (non-clustered) layer group, which has no addLayers() and
  // no per-add clustering cost to batch away anyway.
  const markersToAdd = [];
  let searchMatchCount = 0;
  // Competitors are hidden by default (see .map-competitor-toggle /
  // map-safe-enhancements.css, which hides their individual pins via
  // CSS). Clustering happens in JS before that CSS rule ever applies, so
  // without this check a cluster badge would count competitors that are
  // never actually visible once it splits apart -- leaving the number on
  // the badge wrong. Reading the toggle's own class keeps this in sync
  // without depending on anything from that module directly.
  ctx.syncCompetitorsForFilters();
  const showCompetitors = ctx.root.querySelector(".map-view")?.classList.contains("kad-show-competitors");
  for (const { c, marker } of ctx.lastCustomers) {
    const status = ctx.customerStatus(c);
    if (c.customer_tier === "competitor" && !showCompetitors) continue;
    if (ctx.managerFilter && String(c.assigned_manager_id) !== ctx.managerFilter) continue;
    if (ctx.tierFilters.size && !ctx.tierFilters.has(c.customer_tier || "potential")) continue;
    // A customer with no sales_channel at all (normally normalized to
    // "POTENTIAL" by customerPortfolioUi.js, but not for the edge case
    // of an ERP-linked customer whose channel just hasn't been assigned
    // yet -- see that module's own comment) is never hidden by this
    // filter, default-on or user-selected -- an ambiguous/unassigned
    // customer should stay visible, not silently disappear because it
    // doesn't match whatever channels happen to be selected.
    if (!ctx.passesAssignment(c)) continue;
    if (ctx.categoryFilters.size && !ctx.categoryFilters.has(c.category)) continue;
    if (ctx.plannedMode === "only" && !ctx.plannedTodayIdSet?.has(c.id)) continue;
    if (ctx.brandChipIds.size && !matchesSelectedChips(ctx.brandSummary.get(c.id), ctx.brandChipIds)) continue;
    if (ctx.searchQuery) {
      const haystack = `${c.name} ${c.address ?? ""} ${c.category ?? ""} ${c.erp_customer_id ?? ""} ${brandSearchText(ctx.brandSummary.get(c.id))}`.toLowerCase();
      if (!haystack.includes(ctx.searchQuery) && !ctx.phoneMatches(c, ctx.searchQuery)) continue;
    }
    searchMatchCount += 1;
    if (ctx.activeFilter === "brands") {
      marker.setIcon(ctx.selectedBrand ? ctx.brandAvailabilityIcon(c) : ctx.customerIcon(c, status));
    } else if (ctx.activeFilter === "nearby") {
      const distance = ctx.myLocation ? haversineMeters(ctx.myLocation.lat, ctx.myLocation.lng, c.lat, c.lng) : Infinity;
      if (distance > NEARBY_RADIUS_METERS) continue;
      marker.setIcon(ctx.customerIcon(c, status));
    } else if (ctx.activeFilter === "planned") {
      continue;
    } else {
      // visited-today/visited-7days read straight off the same
      // visited_today/visited_this_week booleans customerStatus() itself
      // derives status from -- visited_this_week is already a rolling
      // 7-day window server-side (see routes/customers.js), not a
      // calendar week, despite the "week" status label. There used to be
      // a third "Visited" chip combining both, but it went through
      // customerStatus()'s overdue-first priority instead of these raw
      // booleans, so a customer visited within 7 days AND independently
      // overdue by cadence fell out of it while still showing up under
      // "Visited last 7 days" -- confusingly near-duplicate AND subtly
      // inconsistent. Removed; these two are the whole, well-defined set.
      if (
        ctx.activeFilter &&
        !(ctx.activeFilter === "overdue"
          ? status === "overdue"
          : ctx.activeFilter === "visited-today"
            ? c.visited_today
            : ctx.activeFilter === "visited-7days"
              ? c.visited_today || c.visited_this_week
              : true)
      ) {
        continue;
      }
      marker.setIcon(ctx.customerIcon(c, status));
    }
    // Today's planned visits above the other customers (owner, 2026-10-27); see PIN_Z for the whole order.
    marker.setZIndexOffset(ctx.plannedTodayByRep.has(c.id) ? ctx.PIN_Z.planned : 0);
    markersToAdd.push(marker);
    bounds.push([c.lat, c.lng]);
    sideListEntries.push({ c, status });
  }
  if (typeof ctx.customerMarkerLayer.addLayers === "function") {
    ctx.customerMarkerLayer.addLayers(markersToAdd);
  } else {
    markersToAdd.forEach((m) => m.addTo(ctx.customerMarkerLayer));
  }
  ctx.renderSideList(sideListEntries);
  ctx.lastMatches = sideListEntries;
  // The grouped search panel lists exactly what is on the map now (same filters + search), so repaint it with the pins.
  if (ctx.searchQuery && ctx.searchPanelOpen) ctx.renderSearchPanel();
  if (ctx.searchNoResults) ctx.searchNoResults.hidden = !(ctx.searchQuery && searchMatchCount === 0);
  if (ctx.activeFilter === "planned") {
    ctx.renderStopListPanel();
    if (ctx.plannedCustomerIds?.length) {
      bounds.push(...ctx.plannedCustomerIds.map((id) => ctx.lastCustomers.find((e) => e.c.id === id)).filter(Boolean).map(({ c }) => [c.lat, c.lng]));
    }
    ctx.plannedEmptyHint.hidden = bounds.length > 0 || ctx.plannedCustomerIds === null;
  } else {
    ctx.clearRouteAndStops();
    ctx.plannedStopsPanel.hidden = true;
    ctx.plannedEmptyHint.hidden = true;
  }
  if (bounds.length && !ctx.keepRestoredView) {
    // The very first time the map settles (plain browsing, not while
    // relocating/adding a customer or opening straight into Plan Day),
    // prefer centering on the user's own position at a close zoom over
    // fitBounds-to-everyone -- fitBounds naturally zooms out to fit the
    // whole territory, which is the opposite of what someone opening the
    // map wants to see first (what's near them right now).
    if (!ctx.initialViewApplied && !ctx.relocateCustomerId && !ctx.startInAddMode && !ctx.startInPlanMode && ctx.focusCustomerId == null) {
      ctx.initialViewApplied = true;
      getCurrentPosition({ timeout: 6000, goodAccuracy: 150, refineMs: 1500 })
        .then((pos) => {
          ctx.myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          // The fix can take several seconds; if the user has already
          // panned/zoomed by then, never pull the map out from under them.
          if (!ctx.userTouchedMap) ctx.map.setView([ctx.myLocation.lat, ctx.myLocation.lng], 15);
          ctx.refreshNearestCustomerBar();
        })
        .catch(() => {
          if (ctx.userTouchedMap) return;
          try {
            ctx.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
          } catch {
            // See note below about the rotate-plugin pane-timing quirk.
          }
        });
      return;
    }
    if (!refit) return;
    try {
      ctx.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } catch {
      // See note below about the rotate-plugin pane-timing quirk.
    }
  }
}

export async function loadBrandStatus(ctx) {
  if (!ctx.brandStatusLoaded) {
    try {
      const rows = await api.getBrandStatusByCustomer();
      ctx.brandStatusByCustomer = new Map(rows.map((r) => [r.customer_id, r.brand_status]));
    } catch {
      ctx.brandStatusByCustomer = new Map();
    }
    ctx.brandStatusLoaded = true;
  }
  ctx.applyFilter();
}

// Colour by Tier | Rep: remembered per user; the rep list (name + colour) shows under the switch while "Rep" is on.
export function paintRepLegend(ctx) {
  const repLegendEl = ctx.root.querySelector("#map-rep-legend");
  if (!repLegendEl) return;
  if (ctx.colorBy !== "rep") {
    repLegendEl.hidden = true;
    return;
  }
  const reps = new Map();
  for (const { c } of ctx.lastCustomers) if (c.assigned_manager_id && !reps.has(c.assigned_manager_id)) reps.set(c.assigned_manager_id, { name: c.assigned_manager_name ?? "", color: repColor(c.assigned_manager_id, c.assigned_manager_color) });
  repLegendEl.innerHTML = [...reps.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `<li><span class="map-rep-dot" style="background:${r.color}"></span><span class="map-rep-name">${escapeHtml(r.name)}</span></li>`)
    .join("");
  repLegendEl.hidden = !reps.size;
}
