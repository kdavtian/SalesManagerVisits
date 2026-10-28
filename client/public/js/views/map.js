import { api } from "../api.js";
import { openInfoPopup, escapeHtml, formatAmd, parseDateOnly, formatDayMonth } from "../util.js";
import { t } from "../i18n.js";
import { NO_GROUP_KEY } from "../regionTree.js";
import { nextVisitRowHtml, formatLastVisit } from "../visitSchedule.js";
import { state } from "../state.js";
import { getClusterPins, setClusterPins, getCompassMode, setCompassMode, getColorBy, setColorBy, getPlannedMode, getDebtCoin, setDebtCoin } from "../mapPrefs.js";
import { repColor } from "../repColors.js";
import { getPerfMode } from "../perfMode.js";
import { ensureLeaflet } from "../leafletLoader.js";
import { paintCheckinSpots, parseHere } from "../checkinSpotsLayer.js";
import { routeLegs, openRouteInMaps, routeShareText, shareRouteToTelegram } from "../routeNavigation.js";
import { COMPETITORS, currentChips, matchedEverEntries, chipHtml, shortDate } from "../brandChips.js";
import * as mapTiles from "./map/tiles.js";
import * as mapMarkers from "./map/markers.js";
import * as mapFilters from "./map/filters.js";
import * as mapPlanning from "./map/planning.js";
import * as mapSearch from "./map/search.js";
import * as mapLocation from "./map/location.js";
import * as mapAddCustomer from "./map/addCustomer.js";
import * as mapTemplate from "./map/template.js";

export const NEARBY_RADIUS_METERS = 5000;

// The channel/rep filter's own default (per explicit request): a field sales
// manager's own assigned book -- every "SM ..." channel -- plus Potential
// (not yet ERP-linked, so not yet assigned to any channel at all). The
// non-field/office channels (SM B2B, PCO, CVO, OEM, KF, bare CAS) are
// real customers too, just not what a rep walking the map is usually
// looking for, so they start hidden -- still just a normal filter value,
// not a hard restriction: opening the channel filter sheet and selecting
// any of them (or Clear, for "show everything") works exactly as before.
export const MAP_DEFAULT_CHANNEL_FILTERS = ["POTENTIAL", "SM YVN", "SM Davtashen", "SM Shirak", "SM CAS"];

// Mirrors the brand_status shape recorded at check-in (see BRAND_GROUPS in
// checkin.js) -- castrol/lotos/royal get their own status tags, each
// competitor is a flat presence flag inside brand_status.competitors.
const BRAND_FILTER_OPTIONS = [
  { value: "castrol", labelKey: "brand_group_castrol" },
  { value: "lotos", labelKey: "brand_group_lotos" },
  { value: "royal", labelKey: "brand_group_royal" },
  ...COMPETITORS.map((v) => ({
    value: `competitor:${v}`,
    labelKey: `competitor_${v}`,
  })),
];

// CARTO's rastertiles (the previous primary provider here) now returns an
// "API key required" placeholder for every request, confirmed live against
// the exact URL this app calls -- not a flaky/blocked-by-some-networks
// problem, a permanent one, so it's no longer in rotation at all rather
// than wasting a health-check cycle on a provider guaranteed to fail.
// OpenStreetMap's own tile server needs no account/key and is the primary
// for both themes; CARTO had a dedicated dark style but OSM only ships one
// visual style, so dark mode is approximated with a CSS filter on the tile
// pane instead (see .leaflet-tile-pane in map-safe-enhancements.css).
export const TILE_URLS = {
  dark: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  light: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
};
// Some networks (certain mobile carriers in particular) block or can't
// resolve a given tile host outright, not just intermittently -- reported
// live from a real device, not a hypothetical. Wikimedia's own OSM-data
// mirror, on independent infrastructure, backs up the primary -- diversifying
// against one host having a bad day, not just one provider.
export const FALLBACK_TILE_URLS = [{ url: "https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png", subdomains: "" }];
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// How many of a provider's own early tile loads get the soft-block byte-size
// check below -- bounded so a healthy provider only pays this extra fetch
// cost briefly at startup/provider-switch, not for the rest of the session.
export const SOFT_BLOCK_SAMPLE_SIZE = 6;

// Leaflet itself is loaded on demand (see leafletLoader.js) rather than
// unconditionally at page load -- app.js idle-preloads it right after
// boot the same way it does the other bottom-nav view modules, so in the
// overwhelming common case ensureLeaflet() below resolves in a single
// microtask (window.L is already set) and this wrapper adds no
// perceptible delay. It only shows real loading/error UI on the rare
// path where a tap on Map/Add-customer lands before that preload has
// finished, or the load genuinely fails (offline on first visit, e.g.).

// Checklist glyph of the open-task marker on a pin (also drawn in the pin key).
export const TASK_PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10a1.5 1.5 0 0 1 1.5 1.5v14A1.5 1.5 0 0 1 17 21H7a1.5 1.5 0 0 1-1.5-1.5v-14A1.5 1.5 0 0 1 7 4Z"/><path d="m8.6 10 1.2 1.2 2-2.2M8.6 15.4l1.2 1.2 2-2.2M14 10.5h2.4M14 15.9h2.4"/></svg>';

export function renderMap(root, navigate, relocateCustomerId, startInAddMode = false, startInPlanMode = false, focusCustomerId = null) {
  root.innerHTML = `<div class="map-view map-view-loading"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  let cleanup = () => {};
  let cancelled = false;
  ensureLeaflet()
    .then(() => {
      if (cancelled) return;
      cleanup = renderMapInner(root, navigate, relocateCustomerId, startInAddMode, startInPlanMode, focusCustomerId);
    })
    .catch((err) => {
      // renderMapInner locks the app shell's scroll before it builds the
      // map; if it threw part-way nothing ever unlocks it, which left every
      // other screen unscrollable too. Always undo that on failure.
      document.getElementById("app")?.classList.remove("app-main-locked");
      document.body.classList.remove("map-active");
      if (cancelled) return;
      root.innerHTML = `
        <div class="map-view map-view-loading">
          <p class="form-error">${escapeHtml(err.message)}</p>
          <button type="button" class="btn" id="map-load-retry">${t("try_again")}</button>
        </div>
      `;
      root.querySelector("#map-load-retry").addEventListener("click", () => {
        cleanup = renderMap(root, navigate, relocateCustomerId, startInAddMode, startInPlanMode, focusCustomerId);
      });
    });
  const outerCleanup = () => {
    cancelled = true;
    cleanup();
  };
  // Forwards to whatever renderMapInner's own cleanup currently is (see its
  // own comment on onRestore) -- read live rather than captured once, since
  // `cleanup` is only reassigned asynchronously once ensureLeaflet()
  // resolves above.
  outerCleanup.onRestore = () => cleanup.onRestore?.();
  return outerCleanup;
}

// Last pan/zoom of a plain browsing session, so leaving the Map tab and
// coming back lands where the user was. Kept in localStorage (not
// sessionStorage): an installed PWA is often killed by the OS in the
// background, and the map used to forget its position every time that
// happened. Older than MAP_VIEW_MAX_AGE_MS (a new working day, say) it is
// ignored and the map starts on the user's own position instead.
const MAP_VIEW_KEY = "fv_map_view";
const MAP_VIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000;
function loadMapView() {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_VIEW_KEY) || sessionStorage.getItem(MAP_VIEW_KEY) || "null");
    const fresh = !v?.at || Date.now() - v.at < MAP_VIEW_MAX_AGE_MS;
    if (v && fresh && Array.isArray(v.center) && v.center.every(Number.isFinite) && Number.isFinite(v.zoom)) return v;
  } catch {
    // storage unavailable -- start fresh
  }
  return null;
}
function saveMapView(map) {
  try {
    // A map measured at 0x0 (parked/hidden) reports a meaningless centre.
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const c = map.getCenter();
    localStorage.setItem(MAP_VIEW_KEY, JSON.stringify({ center: [c.lat, c.lng], zoom: map.getZoom(), at: Date.now() }));
  } catch {
    // ignore
  }
}

function renderMapInner(root, navigate, relocateCustomerId, startInAddMode = false, startInPlanMode = false, focusCustomerId = null) {
  // The screen's variables, for its parts in other files (read and written through getters / setters, so they always see the current value).
  const ctx = {
    get advanceProvider() { return advanceProvider; },
    get blankChecks() { return blankChecks; }, set blankChecks(v) { blankChecks = v; },
    get blankTimer() { return blankTimer; }, set blankTimer(v) { blankTimer = v; },
    get checkMapNotBlank() { return checkMapNotBlank; },
    get currentProvider() { return currentProvider; },
    get hideMapError() { return hideMapError; },
    get latToTileY() { return latToTileY; },
    get lngToTileX() { return lngToTileX; },
    get makeTileLayer() { return makeTileLayer; },
    get map() { return map; },
    get mapEl() { return mapEl; },
    get mapErrorOverlay() { return mapErrorOverlay; },
    get mapIsMeasurable() { return mapIsMeasurable; },
    get mapRetryHint() { return mapRetryHint; },
    get primaryTileUrl() { return primaryTileUrl; },
    get providerIndex() { return providerIndex; }, set providerIndex(v) { providerIndex = v; },
    get showMapError() { return showMapError; },
    get startTileHealthCheck() { return startTileHealthCheck; },
    get tileEverLoaded() { return tileEverLoaded; }, set tileEverLoaded(v) { tileEverLoaded = v; },
    get tileHealthTimer() { return tileHealthTimer; }, set tileHealthTimer(v) { tileHealthTimer = v; },
    get tileLayer() { return tileLayer; }, set tileLayer(v) { tileLayer = v; },
    get warmedTileKeys() { return warmedTileKeys; },
    get addMode() { return addMode; },
    get applyFilter() { return applyFilter; },
    get colorBy() { return colorBy; },
    get customerClusterGroup() { return customerClusterGroup; },
    get customerIcon() { return customerIcon; },
    get customerMarkerLayer() { return customerMarkerLayer; }, set customerMarkerLayer(v) { customerMarkerLayer = v; },
    get customerStatus() { return customerStatus; },
    get customerStatusBadge() { return customerStatusBadge; },
    get debtCoinHtml() { return debtCoinHtml; },
    get debtCoinOn() { return debtCoinOn; },
    get debtCoinSize() { return debtCoinSize; },
    get debtors() { return debtors; }, set debtors(v) { debtors = v; },
    get emptyBoundsRecenterAttempted() { return emptyBoundsRecenterAttempted; }, set emptyBoundsRecenterAttempted(v) { emptyBoundsRecenterAttempted = v; },
    get factsCache() { return factsCache; },
    get fetchFacts() { return fetchFacts; },
    get focusCustomerId() { return focusCustomerId; },
    get focusCustomerPin() { return focusCustomerPin; },
    get focusOnCustomerMarker() { return focusOnCustomerMarker; },
    get initialViewApplied() { return initialViewApplied; }, set initialViewApplied(v) { initialViewApplied = v; },
    get lastCustomers() { return lastCustomers; }, set lastCustomers(v) { lastCustomers = v; },
    get lastPopupCustomerId() { return lastPopupCustomerId; }, set lastPopupCustomerId(v) { lastPopupCustomerId = v; },
    get loadBrandSummary() { return loadBrandSummary; },
    get loadDebtFlags() { return loadDebtFlags; },
    get loadSideDebt() { return loadSideDebt; },
    get loadTaskFlags() { return loadTaskFlags; },
    get markerKind() { return markerKind; },
    get markerLayer() { return markerLayer; },
    get navigate() { return navigate; },
    get nudgePopupIntoView() { return nudgePopupIntoView; },
    get paintCustomers() { return paintCustomers; },
    get PIN_SHAPED_KINDS() { return PIN_SHAPED_KINDS; },
    get PIN_TIP_RATIO() { return PIN_TIP_RATIO; },
    get pinArtHtml() { return pinArtHtml; },
    get pinSize() { return pinSize; },
    get plainCustomerLayer() { return plainCustomerLayer; },
    get plannedRingHtml() { return plannedRingHtml; },
    get popupBrandChipsHtml() { return popupBrandChipsHtml; },
    get popupFactsHtml() { return popupFactsHtml; },
    get refreshNearestCustomerBar() { return refreshNearestCustomerBar; },
    get renderIconFilterRow() { return renderIconFilterRow; },
    get reopenCustomerId() { return reopenCustomerId; }, set reopenCustomerId(v) { reopenCustomerId = v; },
    get repColorOf() { return repColorOf; },
    get resolveCustomersReady() { return resolveCustomersReady; },
    get sideListHost() { return sideListHost; },
    get sideTable() { return sideTable; }, set sideTable(v) { sideTable = v; },
    get syncSidePlanned() { return syncSidePlanned; },
    get taskFlags() { return taskFlags; }, set taskFlags(v) { taskFlags = v; },
    get taskMarkerHtml() { return taskMarkerHtml; },
    get userTouchedMap() { return userTouchedMap; },
    get warmVisiblePopups() { return warmVisiblePopups; },
    get activeFilter() { return activeFilter; },
    get assignmentKeyOf() { return assignmentKeyOf; },
    get assignmentKeys() { return assignmentKeys; }, set assignmentKeys(v) { assignmentKeys = v; },
    get brandAvailabilityIcon() { return brandAvailabilityIcon; },
    get brandAvailabilityStatus() { return brandAvailabilityStatus; },
    get brandChipIds() { return brandChipIds; }, set brandChipIds(v) { brandChipIds = v; },
    get brandStatusByCustomer() { return brandStatusByCustomer; }, set brandStatusByCustomer(v) { brandStatusByCustomer = v; },
    get brandStatusLoaded() { return brandStatusLoaded; }, set brandStatusLoaded(v) { brandStatusLoaded = v; },
    get brandSummary() { return brandSummary; }, set brandSummary(v) { brandSummary = v; },
    get categoryFilters() { return categoryFilters; }, set categoryFilters(v) { categoryFilters = v; },
    get clearRouteAndStops() { return clearRouteAndStops; },
    get currentAssignmentIds() { return currentAssignmentIds; },
    get iconFilterRow() { return iconFilterRow; },
    get keepRestoredView() { return keepRestoredView; },
    get lastMatches() { return lastMatches; }, set lastMatches(v) { lastMatches = v; },
    get loadPlannedFilter() { return loadPlannedFilter; },
    get managerFilter() { return managerFilter; },
    get MAP_TIER_ORDER() { return MAP_TIER_ORDER; },
    get mapFilterIconButton() { return mapFilterIconButton; },
    get myLocation() { return myLocation; }, set myLocation(v) { myLocation = v; },
    get openMapTypeTierSheet() { return openMapTypeTierSheet; },
    get paintRepLegend() { return paintRepLegend; },
    get passesAssignment() { return passesAssignment; },
    get phoneMatches() { return phoneMatches; },
    get PIN_Z() { return PIN_Z; },
    get plannedCustomerIds() { return plannedCustomerIds; },
    get plannedEmptyHint() { return plannedEmptyHint; },
    get plannedMode() { return plannedMode; },
    get plannedStopsPanel() { return plannedStopsPanel; },
    get plannedTodayByRep() { return plannedTodayByRep; },
    get plannedTodayIdSet() { return plannedTodayIdSet; },
    get refreshPlannedToday() { return refreshPlannedToday; },
    get relocateCustomerId() { return relocateCustomerId; },
    get renderSearchPanel() { return renderSearchPanel; },
    get renderSideList() { return renderSideList; },
    get renderStopListPanel() { return renderStopListPanel; },
    get root() { return root; },
    get searchNoResults() { return searchNoResults; },
    get searchPanelOpen() { return searchPanelOpen; },
    get searchQuery() { return searchQuery; },
    get selectedBrand() { return selectedBrand; },
    get startInAddMode() { return startInAddMode; },
    get startInPlanMode() { return startInPlanMode; },
    get syncCompetitorsForFilters() { return syncCompetitorsForFilters; },
    get tierFilters() { return tierFilters; }, set tierFilters(v) { tierFilters = v; },
    get customersReady() { return customersReady; },
    get fetchPlannedToday() { return fetchPlannedToday; },
    get fetchTodayPlannedIds() { return fetchTodayPlannedIds; },
    get loadPlannedTodayByRep() { return loadPlannedTodayByRep; },
    get numberedIcon() { return numberedIcon; },
    get paintPlannedControls() { return paintPlannedControls; },
    get PLAN_STATUS_KEY() { return PLAN_STATUS_KEY; },
    get plannedBtn() { return plannedBtn; },
    set plannedCustomerIds(v) { plannedCustomerIds = v; },
    get plannedLabel() { return plannedLabel; },
    set plannedMode(v) { plannedMode = v; },
    set plannedTodayByRep(v) { plannedTodayByRep = v; },
    set plannedTodayIdSet(v) { plannedTodayIdSet = v; },
    get routeLine() { return routeLine; }, set routeLine(v) { routeLine = v; },
    get selectedPlanManagerId() { return selectedPlanManagerId; },
    get sidePlannedOff() { return sidePlannedOff; }, set sidePlannedOff(v) { sidePlannedOff = v; },
    get stopListEl() { return stopListEl; },
    get stopMarkers() { return stopMarkers; },
    get WEEKDAY_KEYS() { return WEEKDAY_KEYS; },
    get WEEKDAY_ORDER() { return WEEKDAY_ORDER; },
    get addressLoading() { return addressLoading; }, set addressLoading(v) { addressLoading = v; },
    get addressResults() { return addressResults; }, set addressResults(v) { addressResults = v; },
    get addressResultsEl() { return addressResultsEl; },
    get addressSearchMarker() { return addressSearchMarker; }, set addressSearchMarker(v) { addressSearchMarker = v; },
    get addressSearchToken() { return addressSearchToken; }, set addressSearchToken(v) { addressSearchToken = v; },
    get hideAddressResults() { return hideAddressResults; },
    get mapSearchInput() { return mapSearchInput; },
    get phoneTailDigits() { return phoneTailDigits; },
    get SEARCH_PANEL_CUSTOMER_CAP() { return SEARCH_PANEL_CUSTOMER_CAP; },
    get SEARCH_PIN_HTML() { return SEARCH_PIN_HTML; },
    set searchPanelOpen(v) { searchPanelOpen = v; },
    get searchTab() { return searchTab; }, set searchTab(v) { searchTab = v; },
    get searchTabChosen() { return searchTabChosen; }, set searchTabChosen(v) { searchTabChosen = v; },
    get selectAddressResult() { return selectAddressResult; },
    get headingEventName() { return headingEventName; }, set headingEventName(v) { headingEventName = v; },
    get locateBtn() { return locateBtn; },
    get locationMode() { return locationMode; }, set locationMode(v) { locationMode = v; },
    get meAccuracyCircle() { return meAccuracyCircle; }, set meAccuracyCircle(v) { meAccuracyCircle = v; },
    get meIcon() { return meIcon; },
    get meMarker() { return meMarker; }, set meMarker(v) { meMarker = v; },
    get nearbyList() { return nearbyList; },
    get nearbyPanel() { return nearbyPanel; },
    get nearbyPanelTitle() { return nearbyPanelTitle; },
    get nearestBar() { return nearestBar; },
    get nearestCustomer() { return nearestCustomer; }, set nearestCustomer(v) { nearestCustomer = v; },
    get nearestInfo() { return nearestInfo; },
    get onHeading() { return onHeading; },
    get renderNearbyList() { return renderNearbyList; },
    get stopHeading() { return stopHeading; },
    get stopWatch() { return stopWatch; },
    get TEAM_AVATAR_COLORS() { return TEAM_AVATAR_COLORS; },
    get teamAvatarColor() { return teamAvatarColor; },
    get teamBtn() { return teamBtn; },
    get teamEmptyHint() { return teamEmptyHint; },
    get teamEmptyHintTimer() { return teamEmptyHintTimer; }, set teamEmptyHintTimer(v) { teamEmptyHintTimer = v; },
    get teamLayer() { return teamLayer; },
    get teamMemberIcon() { return teamMemberIcon; },
    get updateLocateButtonState() { return updateLocateButtonState; },
    get watchId() { return watchId; }, set watchId(v) { watchId = v; },
    set addMode(v) { addMode = v; },
    get cancelLocationPicker() { return cancelLocationPicker; },
    get closeLocationPanel() { return closeLocationPanel; },
    get fab() { return fab; },
    get geocodeToken() { return geocodeToken; }, set geocodeToken(v) { geocodeToken = v; },
    get handoffToCustomerForm() { return handoffToCustomerForm; },
    get hint() { return hint; },
    get lastTapPoint() { return lastTapPoint; }, set lastTapPoint(v) { lastTapPoint = v; },
    get lastTapTime() { return lastTapTime; }, set lastTapTime(v) { lastTapTime = v; },
    get loadCustomers() { return loadCustomers; },
    get locationPanel() { return locationPanel; },
    get longPressStart() { return longPressStart; }, set longPressStart(v) { longPressStart = v; },
    get longPressTimer() { return longPressTimer; }, set longPressTimer(v) { longPressTimer = v; },
    get NEW_PIN_HTML() { return NEW_PIN_HTML; },
    get openAddressSearchSheet() { return openAddressSearchSheet; },
    get openNewCustomerForm() { return openNewCustomerForm; },
    get openRelocateConfirmDetails() { return openRelocateConfirmDetails; },
    get placeLocationPin() { return placeLocationPin; },
    get placingMarker() { return placingMarker; }, set placingMarker(v) { placingMarker = v; },
    get removePlacingMarker() { return removePlacingMarker; },
    get renderLocationPanelShell() { return renderLocationPanelShell; },
    get showLocationErrorPanel() { return showLocationErrorPanel; },
    get showLocationPanel() { return showLocationPanel; },
    get startAddCustomerFlow() { return startAddCustomerFlow; },
    set startInAddMode(v) { startInAddMode = v; },
    get syncAddHint() { return syncAddHint; },
  };
  const plainBrowse = !relocateCustomerId && !startInAddMode && !startInPlanMode && focusCustomerId == null;
  const restoredView = plainBrowse ? loadMapView() : null;
  // Pin-popup facts (last visit / debt / planned date), cached per customer
  // for the session so a re-tap is instant; prefetched on touch-down.
  const factsCache = new Map();
  const fetchFacts = async (id) => {
    const data = await api.getMapFacts(id);
    factsCache.set(id, { at: Date.now(), data });
    return data;
  };
  // Leaflet's auto-pan measured the popup before its content settled, so
  // nudge the map until the popup is fully inside (clear of the search bar).
  // (Not popup.update(): that re-renders the original content.)
  const nudgePopupIntoView = (popupEl) => {
    const mapRect = map.getContainer().getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();
    const overflow = Math.max(0, mapRect.top + 76 - popupRect.top);
    const dx = Math.max(0, mapRect.left + 8 - popupRect.left) - Math.max(0, popupRect.right - (mapRect.right - 8));
    if (overflow > 0 || dx !== 0) map.panBy([-dx, -overflow]);
  };
  // Silent warm-up: once the map settles, fetch the popup facts of the pins
  // on screen (nearest the centre first, at most WARM_MAX) in ONE batched
  // request, so tapping a pin opens its popup already filled in. Skipped on
  // data-saver / efficiency mode, and a pin whose facts are fresh is not
  // re-requested. A failure is ignored -- the tap path still fetches by itself.
  const WARM_MAX = 40;
  let warmTimer = null;
  const warmVisiblePopups = () => {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(async () => {
      if (navigator.connection?.saveData || document.hidden) return;
      const bounds = map.getBounds();
      const center = map.getCenter();
      const ids = lastCustomers
        .filter(({ c, marker }) => marker && bounds.contains([c.lat, c.lng]) && !(factsCache.get(c.id) && Date.now() - factsCache.get(c.id).at < 60000))
        .sort((a, b) => center.distanceTo([a.c.lat, a.c.lng]) - center.distanceTo([b.c.lat, b.c.lng]))
        .slice(0, WARM_MAX)
        .map(({ c }) => c.id);
      if (!ids.length) return;
      try {
        const facts = await api.getMapFactsBatch(ids);
        for (const [id, data] of Object.entries(facts)) factsCache.set(Number(id), { at: Date.now(), data });
      } catch {
        // best effort
      }
    }, 600);
  };
  // What check-ins recorded about the brands on this shop's shelf: the
  // current chips, plus (while a chip filter is on) the matched older ones
  // with the date they were last seen -- same wording as the Customers tab.
  const popupBrandChipsHtml = (id) => {
    const summary = brandSummary.get(id);
    if (!summary) return "";
    const current = currentChips(summary.current);
    const currentIds = new Set(current.map((d) => `${d.group}:${d.value}`));
    const older = matchedEverEntries(summary, { selectedIds: brandChipIds, query: "" }).filter(
      (m) => !currentIds.has(`${m.def.group}:${m.def.value}`)
    );
    return current.map((d) => chipHtml(d)).join("") + older.map((m) => chipHtml(m.def, shortDate(m.last_at))).join("");
  };
  const popupFactsHtml = (data) => {
    if (!data) {
      // Same three-row height as the real facts, so nothing jumps on arrival.
      return [0, 1, 2, 3].map(() => '<div class="popup-fact popup-fact-skeleton"><span class="skeleton-bar"></span></div>').join("");
    }
    const debtLabel = data.erp_debt_amd != null ? formatAmd(data.erp_debt_amd) : "—";
    const lastVisitLabel = data.last_visit_at ? formatLastVisit(data.last_visit_at) : t("never_visited");
    // Last order, as on the customer card (roadmap step 8): the workbook's latest order date
    const lastOrder = parseDateOnly(data.erp_last_order_date);
    const lastOrderLabel = lastOrder ? formatDayMonth(lastOrder, { year: lastOrder.getFullYear() !== new Date().getFullYear() }) : "—";
    return `
      <div class="popup-fact"><span class="muted">${t("outstanding_debt")}</span><strong>${escapeHtml(debtLabel)}</strong></div>
      <div class="popup-fact"><span class="muted">${t("last_order")}</span><strong>${escapeHtml(lastOrderLabel)}</strong></div>
      <div class="popup-fact"><span class="muted">${t("last_visit")}</span><strong>${escapeHtml(lastVisitLabel)}</strong></div>
      ${nextVisitRowHtml(data)}
    `;
  };
  function mapViewHtml(...args) { return mapTemplate.mapViewHtml(ctx, ...args); }
  root.innerHTML = mapViewHtml();

  const mapEl = root.querySelector("#leaflet-map");
  const hint = root.querySelector("#map-hint");
  const teamEmptyHint = root.querySelector("#team-empty-hint");
  const fab = root.querySelector("#add-customer-fab");
  const compassBtn = root.querySelector("#compass-btn");
  const locateBtn = root.querySelector("#locate-btn");
  const nearestBar = root.querySelector("#nearest-customer-bar");
  const nearestCheckinBtn = root.querySelector("#nearest-checkin-btn");
  const nearestInfo = root.querySelector("#nearest-customer-info");
  let nearestCustomer = null;
  // Desktop only (see .map-side-list in styles.css): the customers passing every active filter/search, as a sortable table next to
  // the map (mapSideTable.js, roadmap step 8). A row click pans to the pin and opens its popup. null on the relocate-pin flow.
  const sideListHost = root.querySelector("#map-side-list");
  let sideTable = null;
  function renderSideList(...args) { return mapMarkers.renderSideList(ctx, ...args); }
  function loadSideDebt(...args) { return mapMarkers.loadSideDebt(ctx, ...args); }
  function focusCustomerPin(...args) { return mapMarkers.focusCustomerPin(ctx, ...args); }

  // Leaflet's internal pan/zoom gesture handling can fight with an ancestor
  // scroll container on iOS, producing the "freezes while panning" bug.
  // Suspend the app shell's own scrolling while the map view is mounted.
  const appMain = document.getElementById("app");
  appMain.classList.add("app-main-locked");
  document.body.classList.add("map-active");
  mapEl.style.touchAction = "none";

  // Efficiency mode (perfMode.js, opt-in under Settings > Preferences).
  // Leaflet's own zoom/fade/marker-zoom CSS transitions are pure visual
  // polish with no feature attached to them, so those are always turned
  // off. rotate/touchRotate are turned off too -- leaflet-rotate's
  // rotation-aware math runs on every pan/zoom/tile update whether or not
  // the map is actually rotated (bearing 0 still goes through the same
  // extra point-rotation calls), a real ongoing cost, not just a one-time
  // one paid while actively rotating. setBearing()/getBearing() stay safe
  // to call either way -- the plugin defines them unconditionally on
  // L.Map.prototype and setBearing() itself no-ops (and never fires the
  // "rotate" event) when the map wasn't constructed with rotate: true, so
  // every existing call site in this file (the compass reset button, the
  // device-heading auto-rotate handlers) degrades to doing nothing rather
  // than throwing. The one place that needed an explicit guard is the
  // locate button's heading-tracking mode itself (see skipTrack below) --
  // starting a device-orientation watch whose whole purpose is to spin a
  // map that no longer rotates would silently do nothing instead of
  // failing loudly, so Efficiency mode makes that button skip straight to
  // its plain show/hide behavior instead, the same way the user's own
  // compass-mode-off preference already does.
  const perfEfficiency = getPerfMode() === "efficiency";
  const map = L.map(mapEl, {
    zoomControl: false,
    rotate: !perfEfficiency,
    touchRotate: !perfEfficiency,
    rotateControl: false,
    bearing: 0,
    zoomAnimation: !perfEfficiency,
    fadeAnimation: !perfEfficiency,
    markerZoomAnimation: !perfEfficiency,
    // Attribution to OpenStreetMap is a required condition of using their
    // free tiles (ODbL terms) -- it can't be removed outright, but the
    // default control (with Leaflet's own "Leaflet |" branding prefix) is
    // oversized for this app. Re-added below as a minimal, unobtrusive
    // control instead.
    attributionControl: false,
    // Leaflet's own window-resize handler measures the container even while
    // this view is parked (detached) in app.js's back stack, where it is 0x0:
    // the map then believed it had no size and drew no tiles after returning
    // (the blank map with working buttons). Resizing is handled below by a
    // ResizeObserver that ignores a detached / zero-size container.
    trackResize: false,
    // Change location: its own view (pin + the real check-in spots), not the Map tab's remembered one.
    kadPlainView: Boolean(relocateCustomerId),
  }).setView(restoredView ? restoredView.center : [20, 0], restoredView ? restoredView.zoom : 2);
  L.control.attribution({ prefix: false, position: "bottomright" }).addTo(map);
  // "Me" lives in its own pane above every customer pin (selected, task, cluster): the rep's dot is never hidden under a customer, and
  // it ignores taps so the pin underneath stays tappable (owner, 2026-10-23).
  // It is created next to the marker and popup panes (inside the rotate plugin's "norotate" pane): created on the map itself it sat above
  // that whole pane, popups included, and the blue dot showed through an open customer card (owner, 2026-10-27). Here: above the pins
  // (600), below the popups (700).
  const pinPanesParent = map.getPane("markerPane")?.parentNode;
  map.createPane("mePane", pinPanesParent);
  map.getPane("mePane").style.zIndex = "620";
  map.getPane("mePane").style.pointerEvents = "none";
  // Teammates above every customer pin (owner, 2026-10-27), still under my own dot and the popups.
  map.createPane("teamPane", pinPanesParent);
  map.getPane("teamPane").style.zIndex = "610";
  // Remember the view as it changes (not only on teardown: the back-cache can
  // keep this instance alive and evict it later, or the app can be closed).
  if (plainBrowse) map.on("moveend", () => saveMapView(map));
  map.on("moveend", () => warmVisiblePopups());
  map.on("moveend", () => sideTable?.mapMoved());

  // Root cause of "the map doesn't show anything": the tile provider (a
  // third-party CDN) can be unreachable -- blocked by a network/firewall,
  // an ad/tracker blocker, no longer offering free access, or just down --
  // and until now nothing detected that. Leaflet just sits there with an
  // empty gray .map-view forever, which reads exactly as "the map isn't
  // showing" with no way for the user to tell what's wrong or do anything
  // about it. Track whether any tile has actually loaded, and surface a
  // real error with a retry instead of failing silently.
  const mapErrorOverlay = root.querySelector("#map-error-overlay");
  const mapRetryHint = root.querySelector("#map-retry-hint");
  let tileEverLoaded = false;
  let tileHealthTimer = null;
  // 0 = primary (OSM); 1..FALLBACK_TILE_URLS.length = that fallback's index+1.
  let providerIndex = 0;

  function hideMapError(...args) { return mapTiles.hideMapError(ctx, ...args); }

  function showMapError(...args) { return mapTiles.showMapError(ctx, ...args); }

  function currentProvider(...args) { return mapTiles.currentProvider(ctx, ...args); }

  function makeTileLayer(...args) { return mapTiles.makeTileLayer(ctx, ...args); }

  function primaryTileUrl(...args) { return mapTiles.primaryTileUrl(ctx, ...args); }

  function advanceProvider(...args) { return mapTiles.advanceProvider(ctx, ...args); }

  function startTileHealthCheck(...args) { return mapTiles.startTileHealthCheck(ctx, ...args); }

  let tileLayer = makeTileLayer(currentProvider()).addTo(map);
  startTileHealthCheck();

  // ---- Proactive tile-cache warming (map_tile_cache pref, strong devices only) ----
  // Leaflet only ever requests tiles for the area currently on screen, so
  // panning to a not-yet-visited area always waits on the network first,
  // even though the service worker (sw.js) caches every tile it ever sees.
  // When the pref is on, this fetches a one-tile buffer ring around the
  // current viewport after every pan/zoom -- the exact same URLs Leaflet
  // itself would request, so the SW's existing tile.openstreetmap.org
  // handler caches them the same way, just before the rep pans there
  // rather than after. Only warms the primary provider (no point caching
  // a fallback CDN nobody's using) and skips entirely once offline.
  const warmedTileKeys = new Set();
  let warmTilesTimer = null;
  function lngToTileX(...args) { return mapTiles.lngToTileX(ctx, ...args); }
  function latToTileY(...args) { return mapTiles.latToTileY(ctx, ...args); }
  function warmTileCache(...args) { return mapTiles.warmTileCache(ctx, ...args); }
  map.on("moveend zoomend", () => {
    clearTimeout(warmTilesTimer);
    warmTilesTimer = setTimeout(warmTileCache, 600);
  });

  function retryTiles(...args) { return mapTiles.retryTiles(ctx, ...args); }
  root.querySelector("#map-error-retry").addEventListener("click", retryTiles);
  // All three tile providers can fail together on a connection that's
  // still technically "online" per the OS (e.g. a mobile carrier that
  // blocks/can't resolve these specific tile CDNs) as much as on a true
  // offline/airplane-mode drop -- retrying automatically the moment the
  // browser's own connectivity signal flips back on covers the "signal
  // came back" case without the rep having to remember to tap Retry.
  window.addEventListener("online", retryTiles);

  function refreshTileStyle(...args) { return mapTiles.refreshTileStyle(ctx, ...args); }
  document.addEventListener("visibilitychange", refreshTileStyle);
  // iOS/Android can drop the map's GPU layers while the app sits in the
  // background; on return, re-measure and redraw instead of showing a blank map.
  // A parked (detached) or hidden container measures 0x0 -- never re-measure
  // then, or the map keeps that size and stays blank once it is shown again.
  const mapIsMeasurable = () => mapEl.isConnected && mapEl.clientWidth > 0 && mapEl.clientHeight > 0;
  const redrawOnResume = () => {
    if (document.visibilityState !== "visible" || !mapIsMeasurable()) return;
    try {
      map.invalidateSize();
      tileLayer?.redraw?.();
    } catch {
      // map already torn down
    }
    checkMapNotBlank();
  };
  // Safety net: a measurable map with no tile elements at all is the blank
  // map. First try a re-measure + redraw; if it is still empty a moment later
  // rebuild the screen once (app.js listens for "app-rerender"). Tile ERRORS
  // (no network) still create tile elements, so offline use never loops.
  let blankChecks = 0;
  let blankTimer = null;
  function checkMapNotBlank(...args) { return mapTiles.checkMapNotBlank(ctx, ...args); }
  // Size changes (rotation, keyboard, sidebar, returning from the back stack):
  // re-measure only when the container really has a size.
  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        if (!mapIsMeasurable()) return;
        try {
          map.invalidateSize({ animate: false });
        } catch {
          // map already torn down
        }
      })
    : null;
  resizeObserver?.observe(mapEl);
  window.addEventListener("orientationchange", redrawOnResume);
  document.addEventListener("visibilitychange", redrawOnResume);
  window.addEventListener("pageshow", redrawOnResume);

  // Wait for Leaflet's own internal setup (panes, position tracking) to
  // finish before touching layout — calling invalidateSize/fitBounds too
  // early throws inside the rotate plugin's pane-position bookkeeping.
  map.whenReady(() => {
    try {
      map.invalidateSize();
    } catch {
      // See the matching try/catch around fitBounds below.
    }
    checkMapNotBlank();
  });

  map.on("rotate", () => {
    const bearing = map.getBearing();
    compassBtn.hidden = Math.abs(bearing) < 1;
    const needle = compassBtn.querySelector("svg");
    if (needle) needle.style.transform = `rotate(${-bearing}deg)`;
  });

  root.querySelector("#zoom-in-btn").addEventListener("click", () => map.zoomIn());
  root.querySelector("#zoom-out-btn").addEventListener("click", () => map.zoomOut());
  compassBtn.addEventListener("click", () => {
    map.setBearing(0);
  });

  // Leaflet's built-in doubleClickZoom listens for a native "dblclick" DOM
  // event, but mapEl's touch-action:none (needed to stop the app-shell
  // scroll fight above) also stops iOS/Android from synthesizing dblclick
  // from a double-tap -- so double-tap-to-zoom silently stopped working.
  // Detect it ourselves from raw touchend timing/distance instead.
  let lastTapTime = 0;
  let lastTapPoint = null;
  function onMapTouchEnd(...args) { return mapAddCustomer.onMapTouchEnd(ctx, ...args); }
  mapEl.addEventListener("touchend", onMapTouchEnd);

  // Long-press (touch) / right-click (desktop) anywhere on the map, outside
  // of an already-active add/relocate flow, drops a new-customer pin right
  // there -- a one-gesture shortcut for "there's a shop right here" that
  // skips the FAB tap + GPS-fix step of the normal add flow (still there,
  // unchanged, as the deliberate/GPS-anchored way in). Desktop gets this
  // for free from Leaflet's own "contextmenu" event (already carries
  // latlng); touch has no equivalent once touchAction:none above stops the
  // browser's native long-press/context-menu gesture, so it's detected
  // here from raw touch timing + movement, the same way onMapTouchEnd above
  // hand-rolls double-tap detection for the same reason.
  const LONG_PRESS_MS = 550;
  const LONG_PRESS_MOVE_TOLERANCE = 12;
  let longPressTimer = null;
  let longPressStart = null;
  let longPressFired = false;

  function cancelLongPress(...args) { return mapAddCustomer.cancelLongPress(ctx, ...args); }

  function triggerAddAtPoint(...args) { return mapAddCustomer.triggerAddAtPoint(ctx, ...args); }

  mapEl.addEventListener("touchstart", (e) => {
    if (relocateCustomerId || addMode) return;
    if (e.touches.length !== 1 || e.target.closest(".leaflet-control, .leaflet-popup, .fab, .map-control-btn")) {
      cancelLongPress();
      return;
    }
    longPressFired = false;
    longPressStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    const point = map.mouseEventToContainerPoint(e.touches[0]);
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      longPressTimer = null;
      triggerAddAtPoint(map.containerPointToLatLng(point));
    }, LONG_PRESS_MS);
  });
  mapEl.addEventListener("touchmove", (e) => {
    if (!longPressStart || !e.touches.length) return;
    const dx = e.touches[0].clientX - longPressStart.x;
    const dy = e.touches[0].clientY - longPressStart.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
  });
  mapEl.addEventListener("touchend", () => cancelLongPress());
  mapEl.addEventListener("touchcancel", () => cancelLongPress());

  map.on("contextmenu", (e) => {
    e.originalEvent?.preventDefault();
    if (relocateCustomerId || addMode) return;
    triggerAddAtPoint(e.latlng);
  });

  let addMode = startInAddMode && !relocateCustomerId;
  if (addMode) {
    fab.classList.add("fab-active");
    fab.setAttribute("aria-pressed", "true");
    mapEl.classList.add("map-picking");
  }
  let placingMarker = null;
  function syncAddHint(...args) { return mapAddCustomer.syncAddHint(ctx, ...args); }
  syncAddHint();
  const markerLayer = L.layerGroup().addTo(map);
  // Customer pins specifically (not plan-day stop numbers, not team member
  // dots) get clustered -- a real customer base packed into a district
  // renders as dozens of overlapping 22px pins otherwise, which is
  // unreadable and near-impossible to tap accurately. Clustering collapses
  // that into a count badge that splits apart as you zoom in; pins already
  // spread out (a rural territory, or once you're zoomed to street level)
  // render exactly as before since there's nothing to cluster.
  // ...unless the user turned "Group nearby pins" off in the map's own Pin
  // key popup, in which case every pin is drawn individually at every zoom
  // level so the true geographic spread is visible.
  const clusteringEnabled = getClusterPins();
  const plainCustomerLayer = L.layerGroup();
  const customerClusterGroup = L.markerClusterGroup({
    maxClusterRadius: 60,
    disableClusteringAtZoom: 17,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    // Splits a big addLayers() batch (see applyFilter below) across
    // animation frames instead of clustering all of it synchronously in
    // one go -- keeps a filter change from janking the UI thread once the
    // customer base is past a couple hundred pins.
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const size = count < 10 ? 32 : count < 50 ? 38 : 44;
      return L.divIcon({
        html: `<div class="pin-cluster" style="width:${size}px;height:${size}px;line-height:${size}px;">${count}</div>`,
        className: "",
        iconSize: [size, size],
      });
    },
  });
  // Exactly one of the two is ever on the map, and every add/clear below
  // goes through customerMarkerLayer -- so marker construction, filtering
  // and fitBounds stay a single code path regardless of the setting. `let`
  // (not `const`) because the Pin key popup's toggle switches this live
  // while the map is open -- see setClusteringPreference below.
  let customerMarkerLayer = clusteringEnabled ? customerClusterGroup : plainCustomerLayer;
  customerMarkerLayer.addTo(map);

  function setClusteringPreference(...args) { return mapMarkers.setClusteringPreference(ctx, ...args); }

  // A plain solid teardrop with nothing inside read as "blank"/broken once
  // dropped -- an X glyph makes it obvious this pin is just a pending
  // placement, and it's also the tap target that cancels it (see the click
  // handler wired onto placingMarker below, in addition to the sheet's own
  // Cancel button).
  const NEW_PIN_HTML = `<div class="pin pin-new"><span class="pin-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></span></div>`;
  // Distinct from NEW_PIN_HTML (an X, meaning "tap to cancel this pending
  // placement") -- this one marks a plain address-search result, which
  // isn't part of the add-customer flow at all and isn't tappable.
  const SEARCH_PIN_HTML = `<div class="pin pin-search-result"><span class="pin-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="3"/><path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11Z"/></svg></span></div>`;

  function customerStatus(...args) { return mapMarkers.customerStatus(ctx, ...args); }

  function customerStatusBadge(...args) { return mapMarkers.customerStatusBadge(ctx, ...args); }

  function markerKind(...args) { return mapMarkers.markerKind(ctx, ...args); }

  // The green customer pin is a teardrop whose point sits ~10% above the
  // bottom edge of its (square) source canvas; potential/competitor are
  // crosshair/circle marks with no point, so they read as centered on the
  // coordinate. Hence two anchors, but one size/anchor formula for the pin.
  const PIN_SHAPED_KINDS = new Set(["customer"]);
  // Bumped 32 -> 38: the raster artwork's own detail (category glyph inside
  // the pin) was reading small on a phone. Both anchors below are computed
  // from this constant rather than stored as pixel literals, so the tip/
  // center anchoring stays exact at any size.
  const MARKER_SIZE = 38;
  const PIN_TIP_RATIO = 0.904;
  // The potential customer's crosshair fills its square, our customers' teardrop does not, so at one size the potential pins looked much
  // bigger (owner, 2026-10-27): our customers (Bronze / Silver / Gold) a little larger, potential ones a little smaller.
  const PIN_SIZE_BY_KIND = { customer: 44, potential: 32 };
  const pinSize = (kind) => PIN_SIZE_BY_KIND[kind] ?? MARKER_SIZE;

  // Marker shape+color say what kind of site this is (our customer /
  // potential customer / competitor) and the glyph inside encodes the
  // *category*. Both come from one SVG per (kind, category) in icons/markers/
  // (drawn by scripts/make-pin-art.mjs -- edit that script, not the files).
  // Visit status (today's check, overdue) stays a small badge layered over it.
  // Customers with an open task: a checklist marker on the LEFT of the pin --
  // yellow while the deadline is ahead, red when due today or overdue.
  let taskFlags = new Map(); // customer id -> due (boolean)
  function taskMarkerHtml(...args) { return mapMarkers.taskMarkerHtml(ctx, ...args); }
  function loadTaskFlags(...args) { return mapMarkers.loadTaskFlags(ctx, ...args); }

  // Optional "debt coin" (owner, 2026-10-26; Off by default): a coin at the lower left of every customer pin that owes money, in three sizes and colours
  // by the amount (AMD): under 300,000 small yellow, under 1,000,000 medium orange, 1,000,000 and more large red.
  // The debtors come from one light request (ids + amounts, same RBAC as every debt figure) and are only fetched while the switch is on.
  const DEBT_COIN_STEPS = [300000, 1000000];
  const debtCoinSize = (amd) => (amd < DEBT_COIN_STEPS[0] ? "s" : amd < DEBT_COIN_STEPS[1] ? "m" : "l");
  let debtCoinOn = getDebtCoin(state.user?.id);
  let debtors = new Map(); // customer id -> debt in AMD
  const debtCoinHtml = (c) => (debtCoinOn && debtors.has(c.id) ? `<span class="pin-debt pin-debt-${debtCoinSize(debtors.get(c.id))}" aria-hidden="true"></span>` : "");
  function loadDebtFlags(...args) { return mapMarkers.loadDebtFlags(ctx, ...args); }

  // "Colour by Rep": the pin keeps its own colour and gets a ring in the rep's colour behind it (owner, 2026-10-25, design B). `icons/markers/ring-<kind>.svg`
  // is the pin's outline only; it is used as a mask over a box in the rep colour, so there is no artwork per rep. A customer without a rep keeps the plain pin.
  let colorBy = getColorBy(state.user?.id);
  const repColorOf = (c) => repColor(c.assigned_manager_id, c.assigned_manager_color);
  // "Today's planned visits" in three states (owner, 2026-10-24): off / highlight (a ring in the colour of the rep who planned the customer, plus the
  // stop number of that rep's route) / only today (highlight + every other pin hidden). One state, two controls: the map button and the pin key.
  let plannedMode = getPlannedMode(state.user?.id);
  let plannedTodayByRep = new Map(); // customer id -> { userId, color, order }
  // What is drawn on top of what, bottom to top (owner, 2026-10-27): customers (Leaflet: the pin lower on the screen in front) < today's
  // planned visits < the pin whose card is open (.kad-marker-selected, a CSS z-index in map-marker-system.css) < teammates (teamPane 610)
  // < my location (mePane 620) < the card itself (popups, 700).
  const PIN_Z = { planned: 2000 };
  const plannedRingHtml = (c) => {
    const planned = plannedMode !== "off" ? plannedTodayByRep.get(c.id) : null;
    return planned
      ? `<span class="pin-rep-ring" style="--rep-color:${planned.color}" aria-hidden="true"></span><span class="pin-stop-no" style="--rep-color:${planned.color}" aria-hidden="true">${planned.order}</span>`
      : "";
  };
  function pinArtHtml(...args) { return mapMarkers.pinArtHtml(ctx, ...args); }

  function customerIcon(...args) { return mapMarkers.customerIcon(ctx, ...args); }

  let activeFilter = "";
  // Sales managers don't get the "team locations" manager-filter dropdown
  // (that's canViewTeamLocations()-gated, admin/sales_director/ceo only) --
  // default them straight to their own book instead of showing the whole
  // company's pins with no way for them to narrow it down themselves.
  let managerFilter = state.user?.role === "sales_manager" ? String(state.user.id) : "";
  let searchQuery = "";
  // Customers currently passing every filter + the search (what applyFilter put on the map) and the last address lookup:
  // the grouped search panel (Customers / Addresses) is drawn from these two.
  let lastMatches = [];
  let addressResults = [];
  let addressLoading = false;
  let searchPanelOpen = false;
  let searchDebounceTimer;
  let selectedBrand = "";
  // Multi-select ("show me A OR B") like Customers.js's own channel
  // filter -- comparing two channels or categories side by side on the map
  // is a real, common query, and a single-value filter forced picking one
  // at a time to do it.
  // One merged "sales channel > sales rep" filter (the same tri-state tree the Customers tab
  // uses): leaf ids are "channel::managerId". null = the default channel set above, a Set =
  // the user's own choice (empty = no filter at all).
  let assignmentKeys = null;
  // Customer tier chips (potential/bronze/silver/gold/competitor); empty = no filter.
  let tierFilters = new Set();
  // "Products at the shop" chips recorded at check-ins (fake Castrol, no
  // Castrol, Lotos available, ...) -- the same data and the same picker as
  // the Customers tab (brandChips.js). brandChipIds are "group:value" ids;
  // empty = no filter. brandSummary is customer id -> { current, ever },
  // loaded once in the background; the filter button appears when it lands.
  let brandChipIds = new Set();
  let brandSummary = new Map();
  let categoryFilters = new Set();
  let brandStatusByCustomer = null;

  // Same 44px icon-button + bottom-sheet pattern as the Customers tab's own
  // filter row (openFilterSheet there is identical) -- duplicated here
  // rather than imported since it's a private closure over that view's own
  // state, not an exported helper.
  const assignmentKeyOf = (c) => `${c.sales_channel || NO_GROUP_KEY}::${c.assigned_manager_id ?? NO_GROUP_KEY}`;
  function passesAssignment(...args) { return mapFilters.passesAssignment(ctx, ...args); }
  function currentAssignmentIds(...args) { return mapFilters.currentAssignmentIds(ctx, ...args); }
  function selectedPlanManagerId(...args) { return mapPlanning.selectedPlanManagerId(ctx, ...args); }
  function syncCompetitorsForFilters(...args) { return mapFilters.syncCompetitorsForFilters(ctx, ...args); }

  // Customer tier chips (gold, silver, bronze, potential, competitor -- multi-select, the same
  // chips as the new-customer form) above the customer type rows (oil change point, shop,
  // workshop, other, always all four). Both empty = no filter. Compact on purpose: the whole
  // sheet shows without scrolling (.map-type-tier-sheet).
  const MAP_TIER_ORDER = ["gold", "silver", "bronze", "potential", "competitor"];
  function openMapTypeTierSheet(...args) { return mapFilters.openMapTypeTierSheet(ctx, ...args); }

  function mapFilterIconButton(...args) { return mapFilters.mapFilterIconButton(ctx, ...args); }

  const iconFilterRow = root.querySelector("#map-icon-filter-row");

  function loadBrandSummary(...args) { return mapFilters.loadBrandSummary(ctx, ...args); }

  function renderIconFilterRow(...args) { return mapFilters.renderIconFilterRow(ctx, ...args); }

  function brandAvailabilityStatus(...args) { return mapFilters.brandAvailabilityStatus(ctx, ...args); }

  function brandAvailabilityIcon(...args) { return mapFilters.brandAvailabilityIcon(ctx, ...args); }
  let lastCustomers = [];
  // Guards the empty-bounds geolocation recenter at the bottom of
  // paintCustomers() -- loadCustomersCached() below can paint twice (a
  // cached list, then the live fetch), and without this a customer base
  // that's genuinely empty (or every customer skipped) would prompt for
  // location access / recenter a second time instead of the once a real
  // page load ever needs.
  let emptyBoundsRecenterAttempted = false;
  let resolveCustomersReady;
  // Lets anything that needs the full customer list (like the plan sheet)
  // wait for the initial load instead of racing it -- lastCustomers is
  // still [] for a beat after the map view mounts.
  const customersReady = new Promise((resolve) => {
    resolveCustomersReady = resolve;
  });
  let myLocation = null;
  // The very first time the map settles on a view, prefer centering on the
  // user's current position at a close zoom (so nearby customers are
  // already visible) over the default "fit every customer" behavior, which
  // zooms out to the whole territory and makes people zoom back in
  // manually just to see what's around them.
  let initialViewApplied = Boolean(restoredView);
  // Set on the first finger/mouse down on the map canvas: from then on no
  // automatic recentre (late GPS fix, fallback fit) may move the camera.
  let userTouchedMap = false;
  mapEl.addEventListener("pointerdown", () => (userTouchedMap = true), { once: true, passive: true });
  // While true, applyFilter leaves the restored pan/zoom alone; any tap or
  // keystroke in the toolbar/filters (outside the map canvas) lets it re-fit.
  let lastPopupCustomerId = null; // pin whose More/Check in was tapped
  let reopenCustomerId = null; // set on back-restore, consumed by the next paint
  let keepRestoredView = false;
  let releaseHold = null;
  const holdView = () => {
    keepRestoredView = true;
    if (releaseHold) return;
    releaseHold = (e) => {
      if (e.target.closest?.(".leaflet-container")) return;
      keepRestoredView = false;
      root.removeEventListener("click", releaseHold, true);
      root.removeEventListener("input", releaseHold, true);
      releaseHold = null;
    };
    root.addEventListener("click", releaseHold, true);
    root.addEventListener("input", releaseHold, true);
  };
  if (restoredView) holdView();
  let plannedCustomerIds = null;
  let routeLine = null;
  const stopMarkers = [];

  const plannedEmptyHint = root.querySelector("#planned-empty-hint");
  const plannedStopsPanel = root.querySelector("#planned-stops-panel");
  const stopListEl = root.querySelector("#stop-list");

  function numberedIcon(...args) { return mapMarkers.numberedIcon(ctx, ...args); }

  function clearRouteAndStops(...args) { return mapPlanning.clearRouteAndStops(ctx, ...args); }

  function renderStopListPanel(...args) { return mapPlanning.renderStopListPanel(ctx, ...args); }

  root.querySelector("#planned-stops-close").addEventListener("click", () => {
    plannedStopsPanel.hidden = true;
  });

  // One tap: the whole planned route (the stops not visited yet, in this order) in Google/Yandex Maps.
  root.querySelector("#open-route-btn").addEventListener("click", () => {
    const remaining = (plannedCustomerIds ?? [])
      .map((id) => lastCustomers.find((entry) => entry.c.id === id))
      .filter((entry) => entry && customerStatus(entry.c) !== "today")
      .map(({ c }) => ({ lat: c.lat, lng: c.lng }));
    openRouteInMaps(remaining, myLocation);
  });

  // One tap: today's stops (all of them, the visited ones ticked) + the Maps link for the rest, to Telegram.
  root.querySelector("#share-route-btn").addEventListener("click", () => {
    const stops = (plannedCustomerIds ?? [])
      .map((id) => lastCustomers.find((entry) => entry.c.id === id))
      .filter(Boolean)
      .map(({ c }) => ({ name: c.name, lat: Number(c.lat), lng: Number(c.lng), done: customerStatus(c) === "today" }));
    if (!stops.length) return;
    const { total } = routeLegs(stops, myLocation);
    shareRouteToTelegram(routeShareText(stops, { repName: state.user?.name ?? "", totalMeters: total, origin: myLocation }));
  });

  function nearestNeighborOrder(...args) { return mapPlanning.nearestNeighborOrder(ctx, ...args); }

  root.querySelector("#optimize-route-btn").addEventListener("click", async () => {
    if (!plannedCustomerIds?.length) return;
    plannedCustomerIds = nearestNeighborOrder(plannedCustomerIds);
    renderStopListPanel();
    try {
      await api.saveVisitPlan(undefined, plannedCustomerIds);
    } catch {
      // Order is still reflected locally; the next plan load will
      // reconcile if the save genuinely failed.
    }
  });

  function applyFilter(...args) { return mapFilters.applyFilter(ctx, ...args); }

  function refreshNearestCustomerBar(...args) { return mapLocation.refreshNearestCustomerBar(ctx, ...args); }

  nearestCheckinBtn?.addEventListener("click", () => {
    if (nearestCustomer) navigate(`#/checkin/${nearestCustomer.id}`);
  });

  const nearbyPanel = root.querySelector("#nearby-panel");
  const nearbyPanelTitle = root.querySelector("#nearby-panel-title");
  const nearbyList = root.querySelector("#nearby-list");

  function openNearbyPanel(...args) { return mapLocation.openNearbyPanel(ctx, ...args); }

  function renderNearbyList(...args) { return mapLocation.renderNearbyList(ctx, ...args); }

  root.querySelector("#nearby-panel-close").addEventListener("click", () => {
    nearbyPanel.hidden = true;
    root.querySelectorAll(".map-filter-chip").forEach((c) => {
      c.classList.remove("chip-active");
      c.setAttribute("aria-pressed", "false");
    });
    const allChip = root.querySelector('.map-filter-chip[data-filter=""]');
    allChip.classList.add("chip-active");
    allChip.setAttribute("aria-pressed", "true");
    activeFilter = "";
    applyFilter();
  });
  root.querySelector("#nearby-view-all").addEventListener("click", () => navigate("#/customers"));

  function fetchTodayPlannedIds(...args) { return mapPlanning.fetchTodayPlannedIds(ctx, ...args); }

  function loadPlannedFilter(...args) { return mapPlanning.loadPlannedFilter(ctx, ...args); }

  // Today's planned customers (all reps, or the one picked in the manager filter) for the highlight / only-today modes; see plannedMode above.
  let plannedTodayIdSet = null;

  root.querySelectorAll(".map-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      root.querySelectorAll(".map-filter-chip").forEach((c) => {
        c.classList.remove("chip-active");
        c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("chip-active");
      chip.setAttribute("aria-pressed", "true");
      activeFilter = chip.dataset.filter;
      if (activeFilter !== "brands") selectedBrand = "";
      brandPickerRow.hidden = activeFilter !== "brands";
      brandLegend.hidden = activeFilter !== "brands" || !selectedBrand;
      if (activeFilter === "nearby") {
        openNearbyPanel();
      } else if (activeFilter === "planned") {
        nearbyPanel.hidden = true;
        loadPlannedFilter();
      } else if (activeFilter === "brands") {
        nearbyPanel.hidden = true;
        loadBrandStatus();
      } else {
        nearbyPanel.hidden = true;
        applyFilter();
      }
    });
  });

  const brandPickerRow = root.querySelector("#brand-picker-row");
  const brandLegend = root.querySelector("#brand-legend");
  if (brandPickerRow) {
    brandPickerRow.innerHTML = BRAND_FILTER_OPTIONS.map(
      (o) => `<button type="button" class="map-filter-chip brand-picker-chip" data-brand="${o.value}" aria-pressed="false">${t(o.labelKey)}</button>`
    ).join("");
    brandPickerRow.querySelectorAll(".brand-picker-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        brandPickerRow.querySelectorAll(".brand-picker-chip").forEach((c) => {
          c.classList.toggle("chip-active", c === chip);
          c.setAttribute("aria-pressed", String(c === chip));
        });
        selectedBrand = chip.dataset.brand;
        brandLegend.hidden = false;
        applyFilter();
      });
    });
  }

  let brandStatusLoaded = false;
  function loadBrandStatus(...args) { return mapFilters.loadBrandStatus(ctx, ...args); }

  const mapSearchInput = root.querySelector("#map-customer-search");
  const searchNoResults = root.querySelector("#map-search-no-results");
  const addressResultsEl = root.querySelector("#map-address-results");
  // This field used to be two separate searches -- an instant customer
  // filter plus a magnifying-glass icon that opened a whole separate sheet
  // for geocoded addresses -- which meant deciding up front which kind of
  // thing you were looking for before you could even start typing. Now a
  // single field always runs both at once: the customer-book filter below
  // (debounced like the Customers list search, 300ms -- applyFilter()
  // clears and rebuilds every marker on the map, expensive enough on a
  // full customer book to visibly stutter typing on low-RAM devices if run
  // on every keystroke) and a background address lookup (see
  // runAddressSearch below), surfacing both kinds of matches together.
  let addressSearchMarker = null;
  let addressSearchDebounceTimer;
  let addressSearchToken = 0;

  // "091 007 019", "+374 91 007019", "91007" all find the customer with phone +37491007019 (3+ digits; the country code and
  // leading zeros are ignored on both sides).
  const phoneTailDigits = (v) => String(v ?? "").replace(/\D/g, "").replace(/^374/, "").replace(/^0+/, "");
  function phoneMatches(...args) { return mapSearch.phoneMatches(ctx, ...args); }

  // Which tab of the search panel is open: "customers" | "addresses". Follows the results until the person taps a tab.
  let searchTab = "customers";
  let searchTabChosen = false;

  function hideAddressResults(...args) { return mapSearch.hideAddressResults(ctx, ...args); }

  // One panel under the search field with two tabs, each with its count: the customers on the map that match (nearest
  // first, with the distance; name, ID, address, phone and brands match) and the street addresses the geocoder found. Tap a customer -> the map flies to the pin and
  // opens its card; tap an address -> a search pin is dropped there.
  const SEARCH_PANEL_CUSTOMER_CAP = 60;
  function renderSearchPanel(...args) { return mapSearch.renderSearchPanel(ctx, ...args); }

  function selectAddressResult(...args) { return mapSearch.selectAddressResult(ctx, ...args); }

  function runAddressSearch(...args) { return mapSearch.runAddressSearch(ctx, ...args); }

  mapSearchInput?.addEventListener("input", () => {
    const raw = mapSearchInput.value.trim();
    searchTabChosen = false;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchQuery = raw.toLowerCase();
      applyFilter();
      renderSearchPanel();
    }, 300);
    clearTimeout(addressSearchDebounceTimer);
    addressSearchDebounceTimer = setTimeout(() => runAddressSearch(raw), 400);
    if (!raw) {
      addressResults = [];
      addressLoading = false;
      hideAddressResults();
    }
  });
  // Coming back to a half-typed search reopens the panel.
  mapSearchInput?.addEventListener("focus", () => {
    if (mapSearchInput.value.trim().length >= 2) renderSearchPanel();
  });

  function dismissAddressResultsOutside(...args) { return mapSearch.dismissAddressResultsOutside(ctx, ...args); }
  document.addEventListener("click", dismissAddressResultsOutside);

  // The competitor visibility toggle is mounted separately (see
  // mapSafeUi.js) and is deliberately CSS-only/DOM-only with no direct call
  // into this module. Re-clustering on its click (delegated, since the
  // button doesn't exist yet at render time) keeps cluster badge counts
  // honest -- see the showCompetitors check in applyFilter above.
  root.addEventListener("click", (e) => {
    if (e.target.closest(".map-competitor-toggle")) applyFilter();
  });

  function focusOnCustomerMarker(...args) { return mapMarkers.focusOnCustomerMarker(ctx, ...args); }

  function paintCustomers(...args) { return mapMarkers.paintCustomers(ctx, ...args); }

  function loadCustomers(...args) { return mapMarkers.loadCustomers(ctx, ...args); }

  function loadCustomersCached(...args) { return mapMarkers.loadCustomersCached(ctx, ...args); }

  // "My location" — blue dot + accuracy circle, kept live with watchPosition.
  // Three states cycled by tapping the same button: off -> on (shows the dot,
  // no auto-recenter) -> track (map follows + rotates to heading) -> off.
  let meMarker = null;
  let meAccuracyCircle = null;
  let watchId = null;
  let locationMode = "off"; // "off" | "on" | "track"
  let headingEventName = null;

  function meIcon(...args) { return mapLocation.meIcon(ctx, ...args); }

  function updateLocateButtonState(...args) { return mapLocation.updateLocateButtonState(ctx, ...args); }

  function stopWatch(...args) { return mapLocation.stopWatch(ctx, ...args); }

  function onHeading(...args) { return mapLocation.onHeading(ctx, ...args); }

  function stopHeading(...args) { return mapLocation.stopHeading(ctx, ...args); }

  function startHeading(...args) { return mapLocation.startHeading(ctx, ...args); }

  function startWatch(...args) { return mapLocation.startWatch(ctx, ...args); }

  locateBtn.addEventListener("click", async () => {
    if (!navigator.geolocation) return;

    // With compass mode off (Pin key popup), the button is a plain show/hide
    // toggle -- "on" goes straight back to "off" instead of stepping through
    // heading-tracking, which some reps found disorienting and don't need.
    // Efficiency mode forces the same behavior even if compass mode is on:
    // the map itself no longer rotates (see the L.map() options above), so
    // starting a device-orientation watch to drive a rotation that can't
    // happen would just silently do nothing.
    const skipTrack = locationMode === "on" && (!getCompassMode() || perfEfficiency);

    if (locationMode === "off") {
      locationMode = "on";
      updateLocateButtonState();
      startWatch();
      if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 15));
    } else if (locationMode === "on" && !skipTrack) {
      locationMode = "track";
      updateLocateButtonState();
      if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16));
      await startHeading();
    } else {
      locationMode = "off";
      updateLocateButtonState();
      stopHeading();
      stopWatch();
      if (meMarker) {
        map.removeLayer(meMarker);
        map.removeLayer(meAccuracyCircle);
        meMarker = null;
        meAccuracyCircle = null;
      }
    }
  });

  // Team locations (admin/sales_director only) — foreground-only pings
  // from teammates, polled while this toggle is on and this view is
  // mounted; cleared on toggle-off and on view teardown.
  const teamBtn = root.querySelector("#team-locations-btn");
  const teamLayer = L.layerGroup();
  let teamPollId = null;
  let teamEmptyHintTimer = null;

  // A stable, distinguishable outline color per teammate -- keyed off their
  // user id (not name, which two people could share) so the same manager
  // always gets the same ring color across sessions and devices.
  const TEAM_AVATAR_COLORS = ["#e8590c", "#2f9e44", "#1971c2", "#9c36b5", "#c2255c", "#f08c00", "#0c8599", "#5c5f66", "#e64980", "#2b8a3e"];
  function teamAvatarColor(...args) { return mapLocation.teamAvatarColor(ctx, ...args); }

  function teamMemberIcon(...args) { return mapLocation.teamMemberIcon(ctx, ...args); }

  function refreshTeamLocations(...args) { return mapLocation.refreshTeamLocations(ctx, ...args); }

  teamBtn?.addEventListener("click", () => {
    const active = teamBtn.classList.toggle("map-control-active");
    if (active) {
      teamLayer.addTo(map);
      refreshTeamLocations({ fitBounds: true });
      teamPollId = setInterval(refreshTeamLocations, 15000);
    } else {
      map.removeLayer(teamLayer);
      clearInterval(teamPollId);
      teamPollId = null;
      clearTimeout(teamEmptyHintTimer);
      teamEmptyHint.hidden = true;
    }
  });

  const PLAN_STATUS_KEY = {
    pending: "plan_status_pending",
    approved: "plan_status_approved",
    rejected: "plan_status_rejected",
  };

  const WEEKDAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];
  // Display order only -- the underlying day_of_week values stay 0=Sun..6=Sat
  // (matching JS Date#getDay(), which the visit_plan_rules schema is built
  // on), but the week is shown Monday-first everywhere in the UI.
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  function openPlanDaySheet(...args) { return mapPlanning.openPlanDaySheet(ctx, ...args); }

  root.querySelector("#plan-day-btn").addEventListener("click", () => {
    openPlanDaySheet();
  });
  if (startInPlanMode) openPlanDaySheet();

  const legendBtn = root.querySelector("#map-legend-btn");
  const legendPanel = root.querySelector("#map-legend-panel");
  const closeLegend = () => {
    legendPanel.hidden = true;
    legendPanel.style.transform = "";
    legendBtn.setAttribute("aria-expanded", "false");
  };
  // Swipe the handle / header down to close, like any iOS sheet.
  {
    let startY = null;
    const grab = root.querySelector("#map-legend-grab");
    const header = legendPanel.querySelector(".map-legend-header");
    const begin = (e) => {
      if (e.target.closest("button")) return;
      startY = e.touches[0].clientY;
      legendPanel.style.transition = "none";
    };
    const move = (e) => {
      if (startY == null) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      legendPanel.style.transform = `translateY(${dy}px)`;
    };
    const end = (e) => {
      if (startY == null) return;
      const dy = (e.changedTouches?.[0]?.clientY ?? startY) - startY;
      startY = null;
      legendPanel.style.transition = "";
      if (dy > 70) closeLegend();
      else legendPanel.style.transform = "";
    };
    for (const el of [grab, header]) {
      el.addEventListener("touchstart", begin, { passive: true });
      el.addEventListener("touchmove", move, { passive: true });
      el.addEventListener("touchend", end, { passive: true });
      el.addEventListener("touchcancel", end, { passive: true });
    }
  }
  legendBtn.addEventListener("click", () => {
    const open = legendPanel.hidden;
    legendPanel.hidden = !open;
    legendBtn.setAttribute("aria-expanded", String(open));
  });
  root.querySelector("#map-legend-close").addEventListener("click", closeLegend);

  const clusterToggle = root.querySelector("#map-legend-toggle-cluster");
  clusterToggle.addEventListener("click", () => {
    const next = clusterToggle.getAttribute("aria-checked") !== "true";
    clusterToggle.setAttribute("aria-checked", String(next));
    setClusterPins(next);
    setClusteringPreference(next);
  });

  // Debt coin: Off by default, remembered per user. Switching it on fetches the debtors once; off just repaints without the coins.
  const debtCoinToggle = root.querySelector("#map-legend-toggle-debt");
  debtCoinToggle.addEventListener("click", async () => {
    debtCoinOn = debtCoinToggle.getAttribute("aria-checked") !== "true";
    debtCoinToggle.setAttribute("aria-checked", String(debtCoinOn));
    setDebtCoin(state.user?.id, debtCoinOn);
    if (debtCoinOn) await loadDebtFlags();
    else {
      debtors = new Map();
      applyFilter({ refit: false });
    }
  });

  function paintRepLegend(...args) { return mapFilters.paintRepLegend(ctx, ...args); }
  root.querySelectorAll("[data-color-by]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = btn.dataset.colorBy;
      if (next === colorBy) return;
      colorBy = next;
      setColorBy(state.user?.id, next);
      root.querySelectorAll("[data-color-by]").forEach((b) => {
        b.classList.toggle("chip-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      paintRepLegend();
      applyFilter({ refit: false });
    })
  );
  paintRepLegend();

  // Today's planned visits: three states shared by the map button and the pin key (default off, remembered per user).
  const plannedBtn = root.querySelector("#planned-today-filter-btn");
  const PLANNED_MODES = ["off", "highlight", "only"];
  const plannedLabel = { off: t("map_planned_off"), highlight: t("map_planned_highlight"), only: t("map_planned_only") };
  function loadPlannedTodayByRep(...args) { return mapPlanning.loadPlannedTodayByRep(ctx, ...args); }
  function fetchPlannedToday(...args) { return mapPlanning.fetchPlannedToday(ctx, ...args); }
  // The side table's "Today" column shows the planned stops whether or not the pins highlight them (fetched once while highlighting is off).
  let sidePlannedOff = null;
  function syncSidePlanned(...args) { return mapPlanning.syncSidePlanned(ctx, ...args); }
  function refreshPlannedToday(...args) { return mapPlanning.refreshPlannedToday(ctx, ...args); }
  function paintPlannedControls(...args) { return mapPlanning.paintPlannedControls(ctx, ...args); }
  function setPlannedModeTo(...args) { return mapPlanning.setPlannedModeTo(ctx, ...args); }
  plannedBtn?.addEventListener("click", () => setPlannedModeTo(PLANNED_MODES[(PLANNED_MODES.indexOf(plannedMode) + 1) % PLANNED_MODES.length]));
  root.querySelectorAll("[data-planned-mode]").forEach((b) => b.addEventListener("click", () => setPlannedModeTo(b.dataset.plannedMode)));
  const openRingsInfo = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openInfoPopup(t("map_planned_rings_info"));
  };
  const ringsInfoBtn = root.querySelector("#map-planned-rings-info");
  ringsInfoBtn.addEventListener("click", openRingsInfo);
  ringsInfoBtn.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && openRingsInfo(e));
  window.addEventListener("plans-changed", () => root.isConnected && plannedMode !== "off" && refreshPlannedToday());
  paintPlannedControls();
  if (plannedMode !== "off") refreshPlannedToday({ refit: false });

  const compassToggle = root.querySelector("#map-legend-toggle-compass");
  compassToggle.addEventListener("click", () => {
    const next = compassToggle.getAttribute("aria-checked") !== "true";
    compassToggle.setAttribute("aria-checked", String(next));
    setCompassMode(next);
    // Turning compass mode off while already mid-track drops straight back
    // to the plain "on" (dot visible, no heading/rotation) state instead of
    // leaving the map stuck rotated with no way to get out of track mode
    // short of the button's own now-skipped third tap.
    if (!next && locationMode === "track") {
      locationMode = "on";
      updateLocateButtonState();
      stopHeading();
    }
  });

  root.addEventListener("click", (event) => {
    // >= 1400 px the key is a panel beside the map (desktop.css): it stays open while the map is used
    if (window.matchMedia?.("(min-width: 1400px)").matches) return;
    if (!legendPanel.hidden && !legendPanel.contains(event.target) && event.target !== legendBtn && !legendBtn.contains(event.target)) {
      closeLegend();
    }
  });

  // ---- Shared customer-location picker (Add Customer + Relocate) ----
  // One flow services both: propose a location (a fresh GPS fix, the
  // customer's existing saved coordinates, or a plain tap), let the rep
  // drag the pin or search an address instead, and only ever write lat/lng
  // once they explicitly tap Confirm. The panel is a bottom-docked HUD
  // (.location-picker-panel), not a modal .sheet-overlay -- a full-screen
  // overlay would sit above the whole map and block exactly the dragging
  // and panning this flow depends on.
  const locationPanel = root.querySelector("#location-picker-panel");
  let geocodeToken = 0; // discards a stale reverse-geocode reply if the pin moved again before it returned

  function removePlacingMarker(...args) { return mapAddCustomer.removePlacingMarker(ctx, ...args); }

  function closeLocationPanel(...args) { return mapAddCustomer.closeLocationPanel(ctx, ...args); }

  function cancelLocationPicker(...args) { return mapAddCustomer.cancelLocationPicker(ctx, ...args); }

  function handoffToCustomerForm(...args) { return mapAddCustomer.handoffToCustomerForm(ctx, ...args); }

  function placeLocationPin(...args) { return mapAddCustomer.placeLocationPin(ctx, ...args); }

  function renderLocationPanelShell(...args) { return mapAddCustomer.renderLocationPanelShell(ctx, ...args); }

  function showLocationPanel(...args) { return mapAddCustomer.showLocationPanel(ctx, ...args); }

  function showLocationErrorPanel(...args) { return mapAddCustomer.showLocationErrorPanel(ctx, ...args); }

  function openAddressSearchSheet(...args) { return mapAddCustomer.openAddressSearchSheet(ctx, ...args); }

  function startAddCustomerFlow(...args) { return mapAddCustomer.startAddCustomerFlow(ctx, ...args); }

  if (relocateCustomerId) {
    fab.hidden = true;
    mapEl.classList.add("map-picking");
    root.querySelector("#cancel-relocate")?.addEventListener("click", () => {
      (navigate.replace ?? navigate)(`#/customers/${relocateCustomerId}`);
    });
    customersReady.then(() => {
      const existing = lastCustomers.find((entry) => String(entry.c.id) === String(relocateCustomerId));
      const startLatLng = existing ? L.latLng(existing.c.lat, existing.c.lng) : map.getCenter();
      // Not animated: Leaflet drops any setView/fitBounds issued while a zoom animation is still running,
      // which would swallow the fit to the check-in spots below.
      if (existing) map.setView(startLatLng, Math.max(map.getZoom(), 16), { animate: false });
      placeLocationPin(startLatLng, { source: "existing_customer", onConfirm: openRelocateConfirmDetails });
      // The real GPS spots of the last check-ins (and "you are here" when coming from a blocked check-in),
      // so the pin can be dragged to where the shop really is, or set with "Use this spot".
      api
        .getCheckinSpots(relocateCustomerId)
        .then((data) => {
          const here = parseHere(new URLSearchParams(location.hash.split("?")[1] || "").get("here"));
          const { bounds } = paintCheckinSpots(map, data, {
            here,
            showPin: false,
            onUse: (latlng) => placeLocationPin(latlng, { source: "dragged_pin", onConfirm: openRelocateConfirmDetails }),
          });
          if (data.spots.length || here) {
            bounds.extend(startLatLng);
            map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17, animate: false });
          }
        })
        .catch(() => {});
    });
  } else {
    // Tapping the FAB a second time while already picking cancels --
    // mirrors the button's own pressed/active state, so there's always one
    // obvious way to back out beyond navigating away entirely.
    fab.addEventListener("click", () => {
      if (addMode) {
        cancelLocationPicker();
        return;
      }
      addMode = true;
      fab.classList.add("fab-active");
      fab.setAttribute("aria-pressed", "true");
      mapEl.classList.add("map-picking");
      startAddCustomerFlow();
    });
  }

  // Manual fallback: while addMode/relocate is active, a plain tap anywhere
  // on the map also drops (or moves) the pin -- the GPS-first flow above is
  // the default, not the only way in, per the task's "let the user accept
  // it, drag it, or place it themselves" requirement.
  map.on("click", (e) => {
    // A long-press that just fired can still produce a trailing synthetic
    // "click" once the finger lifts -- addMode is already true and the pin
    // already placed by then, so without this guard the same gesture would
    // immediately re-place its own pin a second time at the same spot.
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    if (relocateCustomerId) {
      placeLocationPin(e.latlng, { source: "dragged_pin", onConfirm: openRelocateConfirmDetails });
      return;
    }
    if (!addMode) return;
    placeLocationPin(e.latlng, { source: "dragged_pin", onConfirm: handoffToCustomerForm });
  });

  function openRelocateConfirmDetails(...args) { return mapAddCustomer.openRelocateConfirmDetails(ctx, ...args); }

  if (addMode) startAddCustomerFlow();

  function openNewCustomerForm(...args) { return mapAddCustomer.openNewCustomerForm(ctx, ...args); }

  map.whenReady(loadCustomersCached);

  const cleanupMapInner = () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    if (headingEventName) window.removeEventListener(headingEventName, onHeading);
    if (teamPollId) clearInterval(teamPollId);
    clearTimeout(teamEmptyHintTimer);
    clearTimeout(tileHealthTimer);
    clearTimeout(warmTilesTimer);
    clearTimeout(warmTimer);
    mapEl.removeEventListener("touchend", onMapTouchEnd);
    document.removeEventListener("visibilitychange", refreshTileStyle);
    document.removeEventListener("visibilitychange", redrawOnResume);
    window.removeEventListener("pageshow", redrawOnResume);
    window.removeEventListener("orientationchange", redrawOnResume);
    resizeObserver?.disconnect();
    clearTimeout(blankTimer);
    lastCustomers = [];
    factsCache.clear();
    document.removeEventListener("click", dismissAddressResultsOutside);
    window.removeEventListener("online", retryTiles);
    appMain.classList.remove("app-main-locked");
    document.body.classList.remove("map-active");
    if (plainBrowse) saveMapView(map);
    map.remove();
  };
  // app.js's back-cache reattaches this exact same DOM/Leaflet instance on
  // a "back" to #/map instead of calling this module again from scratch
  // (see its own comment on backCache -- keeps the user's pan/zoom and any
  // open popup exactly as they left them, far cheaper than rebuilding the
  // whole map). That's the right call for a plain hop away and back, but
  // it means nothing here ever re-fetches: editing a customer's name,
  // location, or category on their detail page and tapping back to Map
  // left the old values on screen until a full app reload (reported
  // live). app.js calls this hook (if present) right after reattaching,
  // so the marker set -- not the map's own pan/zoom, which Leaflet itself
  // never lost -- gets refreshed with whatever changed while the rep was
  // away. A popup that was open before leaving closes in the repaint
  // rather than being reopened with stale content; reasonably rare (it
  // only matters if the rep left it open, which the "Details" tap that
  // sent them to the one screen that could invalidate it already implies
  // they were done with for now) and far better than silently stale data.
  // Parked while another tab is open (app.js keeps the Map alive): stop what drains battery or data, and take it up again on return.
  let resumeWatch = false;
  let resumeTeamPoll = false;
  let parkedAt = 0;
  cleanupMapInner.onPark = () => {
    parkedAt = Date.now();
    resumeWatch = watchId != null;
    resumeTeamPoll = teamPollId != null;
    stopWatch();
    if (teamPollId) {
      clearInterval(teamPollId);
      teamPollId = null;
    }
  };
  cleanupMapInner.onRestore = () => {
    if (resumeWatch) startWatch();
    if (resumeTeamPoll && !teamPollId) teamPollId = setInterval(refreshTeamLocations, 15000);
    resumeWatch = false;
    resumeTeamPoll = false;
    // The container was detached while parked: measure it again now that it
    // is back, then redraw the tiles (see trackResize above).
    requestAnimationFrame(() => {
      try {
        map.invalidateSize({ animate: false });
        tileLayer?.redraw?.();
      } catch {
        // map already torn down
      }
      checkMapNotBlank();
    });
    // Back from a customer card: keep the exact pan/zoom (refreshing the
    // markers must not re-fit to every customer) and reopen the pin the
    // user tapped More on.
    // A quick hop to another tab and back changed nothing: no refetch, no repaint (the pins and any open popup just stay). After a
    // longer stay away, or a return from a customer card (never parked), the pins are refreshed as before.
    const justLooked = parkedAt && Date.now() - parkedAt < 45000;
    parkedAt = 0;
    if (justLooked) return;
    holdView();
    reopenCustomerId = lastPopupCustomerId;
    // A task completed on the customer card must leave its pin: refresh the flags BEFORE the pins are rebuilt, in the same
    // pass (a repaint afterwards would rebuild the markers again and close the reopened popup).
    Promise.all([api.listCustomers(), loadTaskFlags({ repaint: false }), loadDebtFlags({ repaint: false })]).then(([customers]) => paintCustomers(customers)).catch(() => {});
  };
  return cleanupMapInner;
}
