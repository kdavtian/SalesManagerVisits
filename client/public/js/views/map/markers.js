// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { createMapSideTable } from "../../mapSideTable.js";
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { TASK_PIN_SVG } from "../map.js";
import { categoryIconSlug, channelDisplayLabel, escapeHtml, getCurrentPosition, isNeverVisited } from "../../util.js";
import { getPerfMode } from "../../perfMode.js";
import { reorderChipHtml } from "../../reorder.js";
import { icons } from "../../icons.js";
import { loadWithCache } from "../../listCache.js";

export function renderSideList(ctx, entries) {
  if (!ctx.sideListHost) return;
  if (!ctx.sideTable) {
    ctx.sideTable = createMapSideTable({
      host: ctx.sideListHost,
      badgeOf: (status) => ctx.customerStatusBadge(status),
      inView: (c) => ctx.map.getBounds().contains([c.lat, c.lng]),
      onPick: (id) => ctx.focusCustomerPin(id),
    });
    ctx.loadSideDebt();
    // after this screen's setup has run (the cached customer list can paint before the planned-visit code below is set up)
    setTimeout(ctx.syncSidePlanned, 0);
  }
  ctx.sideTable.setEntries(entries);
}

// The debt column: the same light, RBAC'd list as the pin coin (ids + amounts), fetched once for the table.
export async function loadSideDebt(ctx) {
  try {
    const rows = await api.getCustomerDebtFlags();
    ctx.sideTable?.setDebt(new Map(rows.map((r) => [r.customer_id, Number(r.debt_amd)])));
  } catch {
    /* the column just stays empty */
  }
}

export function focusCustomerPin(ctx, id) {
  const entry = ctx.lastCustomers.find(({ c }) => c.id === id);
  if (!entry) return;
  const { c, marker } = entry;
  // centre the pin, then open its popup (a grouped pin first zooms until it stands alone)
  const open = () => {
    ctx.map.panTo([c.lat, c.lng], { animate: false });
    marker.openPopup();
  };
  if (typeof ctx.customerMarkerLayer.zoomToShowLayer === "function" && ctx.customerMarkerLayer.hasLayer(marker)) {
    ctx.customerMarkerLayer.zoomToShowLayer(marker, open);
  } else {
    ctx.map.setView([c.lat, c.lng], Math.max(ctx.map.getZoom(), 16));
    open();
  }
}

export function setClusteringPreference(ctx, enabled) {
  const target = enabled ? ctx.customerClusterGroup : ctx.plainCustomerLayer;
  if (ctx.customerMarkerLayer === target) return;
  ctx.map.removeLayer(ctx.customerMarkerLayer);
  ctx.customerMarkerLayer.clearLayers();
  ctx.customerMarkerLayer = target;
  ctx.customerMarkerLayer.addTo(ctx.map);
  ctx.applyFilter({ refit: false });
}

export function customerStatus(ctx, c) {
  if (c.visited_today) return "today";
  if (c.overdue) return "overdue";
  if (c.visited_this_week) return "week";
  return "pending";
}

// Shared by the nearby-customers list and the desktop side list -- same
// status, same badge, one place to keep them in sync.
export function customerStatusBadge(ctx, status) {
  return {
    cls: status === "today" ? "badge-success" : status === "overdue" ? "badge-danger" : status === "week" ? "badge-info" : "badge-neutral",
    text: status === "today" ? t("visited_today") : status === "overdue" ? t("filter_overdue") : status === "week" ? t("visited_this_week") : t("not_visited"),
  };
}

// The map doesn't show a customer's tier: every active customer (bronze,
// silver or gold) is the same green pin, potential customers the red
// crosshair, competitors the grey square. The tier still lives on the
// customer record and in the customer screens -- it just isn't a map
// concept. "customer" is the marker kind for the green pin set.
export function markerKind(ctx, tier) {
  if (tier === "bronze" || tier === "silver" || tier === "gold") return "customer";
  if (tier === "competitor") return "competitor";
  return "potential";
}

export function taskMarkerHtml(ctx, c) {
  if (!ctx.taskFlags.has(c.id)) return "";
  return `<span class="pin-task ${ctx.taskFlags.get(c.id) ? "pin-task-due" : "pin-task-soon"}" aria-hidden="true">${TASK_PIN_SVG}</span>`;
}

// repaint:false = the caller repaints the pins right after (back from a customer card), so only the flags are refreshed here.
export async function loadTaskFlags(ctx, { repaint = true } = {}) {
  try {
    const rows = await api.getTaskCustomerFlags();
    const next = new Map(rows.map((r) => [r.customer_id, Boolean(r.due)]));
    const changed = next.size !== ctx.taskFlags.size || [...next].some(([id, due]) => ctx.taskFlags.get(id) !== due);
    ctx.taskFlags = next;
    // Also when the LAST open task was just completed (next.size is 0): its icon has to leave the pin.
    if (repaint && changed) ctx.applyFilter({ refit: false });
  } catch {
    /* optional overlay */
  }
}

export async function loadDebtFlags(ctx, { repaint = true } = {}) {
  if (!ctx.debtCoinOn) {
    ctx.debtors = new Map();
    return;
  }
  try {
    const rows = await api.getCustomerDebtFlags();
    const next = new Map(rows.map((r) => [r.customer_id, Number(r.debt_amd)]));
    const changed = next.size !== ctx.debtors.size || [...next].some(([id, amd]) => !ctx.debtors.has(id) || ctx.debtCoinSize(ctx.debtors.get(id)) !== ctx.debtCoinSize(amd));
    ctx.debtors = next;
    if (repaint && changed) ctx.applyFilter({ refit: false });
  } catch {
    /* optional overlay */
  }
}

export function pinArtHtml(ctx, c, tier) {
  // The potential customer's crosshair is the original raster art (PNG); the other kinds are SVG (see scripts/make-pin-art.mjs).
  const src = `/icons/markers/${tier}-${categoryIconSlug(c.category)}.${tier === "potential" ? "png" : "svg"}`;
  const img = `<img class="pin-img-asset" src="${src}" alt="" width="${ctx.pinSize(tier)}" height="${ctx.pinSize(tier)}" draggable="false" />`;
  if (ctx.colorBy === "rep" && c.assigned_manager_id && tier !== "competitor") {
    return `<span class="pin-colour-ring" style="--rep-color:${ctx.repColorOf(c)};--pin-ring:url('/icons/markers/ring-${tier}.svg')" aria-hidden="true"></span>${img}`;
  }
  return img;
}

export function customerIcon(ctx, c, status) {
  const tier = ctx.markerKind(c.customer_tier);
  const check = status === "today" ? '<span class="pin-check">&#10003;</span>' : "";
  // Overdue pins already carry the red "!" badge (map-marker-system.css ::after); a never-visited pin shows the yellow "!!" instead of it.
  const neverVisited = isNeverVisited(c);
  const overdueClass = status === "overdue" ? "pin-status-overdue" : "";
  const never = neverVisited ? '<span class="pin-never" aria-hidden="true">!!</span>' : "";
  const isPinShaped = ctx.PIN_SHAPED_KINDS.has(tier);
  const size = ctx.pinSize(tier);
  const anchorY = isPinShaped ? Math.round(size * ctx.PIN_TIP_RATIO) : size / 2;
  // Shape family also decides where the status badge hangs, since the two
  // families fill their square canvas differently (see the CSS).
  const shapeClass = isPinShaped ? "pin-img-teardrop" : "pin-img-round";
  return L.divIcon({
    className: "",
    // .pin stays on the wrapper: marker selection (mapMarkerEnhancements)
    // and the competitor-visibility toggle (map-safe-enhancements) both
    // key off .pin / .pin-tier-* selectors.
    html: `<div class="pin pin-img ${shapeClass} pin-tier-${tier} ${overdueClass} ${neverVisited ? "pin-is-never" : ""}">${ctx.pinArtHtml(c, tier)}${ctx.plannedRingHtml(c)}${check}${ctx.taskMarkerHtml(c)}${ctx.debtCoinHtml(c)}${never}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, anchorY],
    popupAnchor: [0, -anchorY],
  });
}

export function numberedIcon(ctx, n, visited) {
  return L.divIcon({
    className: "",
    html: `<div class="pin pin-stop ${visited ? "pin-stop-visited" : ""}">${visited ? "&#10003;" : n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -26],
  });
}

// Shared "focus the map on one customer" mechanism -- used both by the
// #/map?customer=<id> deep link (customer detail's "Show on map") and,
// right after creating a new customer, to land on that customer's own
// pin instead of the fitBounds-to-everyone zoom-out applyFilter would
// otherwise apply while add-mode is active.
// keepView: only reopen the popup where the camera already is (coming back from a customer card).
export function focusOnCustomerMarker(ctx, id, { keepView = false } = {}) {
  const entry = ctx.lastCustomers.find((item) => String(item.c.id) === String(id));
  if (entry) {
    if (!keepView) // Zoom 17 and closer draws every pin on its own (disableClusteringAtZoom): at 15 the new customer could sit inside
    // a cluster bubble next to a neighbour, i.e. "the new pin is not on the map".
      ctx.map.setView([entry.c.lat, entry.c.lng], Math.max(ctx.map.getZoom(), 17), { animate: false });
    // The cluster layer adds markers in chunks over the next frames, so the marker is not on the map yet: open its
    // popup as soon as it is (openPopup on a marker without a map does nothing).
    let tries = 0;
    const openWhenShown = () => {
      if (entry.marker._map) entry.marker.openPopup();
      else if (++tries < 40) setTimeout(openWhenShown, 75);
    };
    openWhenShown();
  }
  return entry;
}

// Split from the actual fetch (see loadCustomers/loadCustomersCached
// below) so the initial mount can paint a cached list instantly and
// repaint once the live fetch lands, without duplicating this whole
// marker-build/applyFilter/nearest-bar pipeline at each call site.
export function paintCustomers(ctx, customers) {
  ctx.markerLayer.clearLayers();
  ctx.customerMarkerLayer.clearLayers();
  ctx.lastCustomers = [];

  // Efficiency mode's fast path for "Add new customer": building a
  // Leaflet marker + bound popup (with its own async popupopen listener)
  // for every existing customer is the single most expensive thing this
  // view does -- hundreds of marker objects and clustering work -- and
  // none of it is needed just to drop one new pin. Skipped only while
  // addMode is actually active; the moment the new customer is saved,
  // addMode is cleared and this same function runs again (see the
  // form-submit handler below), building the full marker set normally
  // from then on. startAddCustomerFlow() below has its own GPS/address-
  // search positioning, independent of the customer bounds this loop
  // would otherwise compute, so skipping it doesn't leave the map
  // uncentered.
  const skipMarkers = ctx.addMode && getPerfMode() === "efficiency";
  const bounds = [];
  if (!skipMarkers) {
    for (const c of customers) {
      const status = ctx.customerStatus(c);
      const marker = L.marker([c.lat, c.lng], { icon: ctx.customerIcon(c, status) });
      marker.bindPopup(`
        <div class="map-popup">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.sales_channel || reorderChipHtml(c) ? `<div class="popup-category">${c.sales_channel ? escapeHtml(channelDisplayLabel(c.sales_channel)) : ""} ${reorderChipHtml(c)}</div>` : ""}
          <div class="popup-brand-chips" id="popup-brands-${c.id}">${ctx.popupBrandChipsHtml(c.id)}</div>
          <div class="popup-facts" id="popup-facts-${c.id}">${ctx.popupFactsHtml(ctx.factsCache.get(c.id)?.data)}</div>
          <div class="popup-actions">
            <button data-action="checkin" data-id="${c.id}" class="btn-accent"><span>${icons.mapPinCheck}</span><span class="popup-action-label">${t("check_in")}</span></button>
            <button data-action="details" data-id="${c.id}"><span class="popup-action-label">${t("more")}</span></button>
          </div>
        </div>
      `, { maxWidth: 340 });
      marker.on("popupopen", async (e) => {
        // The selected halo also follows a popup that is reopened by code (back from the customer card), not only a tap.
        const icon = marker.getElement?.();
        if (icon?.querySelector(".pin:not(.pin-stop):not(.pin-new)")) {
          document.querySelectorAll("#leaflet-map .leaflet-marker-icon.kad-marker-selected").forEach((el) => { if (el !== icon) el.classList.remove("kad-marker-selected"); });
          icon.classList.add("kad-marker-selected");
        }
        const popupEl = e.popup.getElement();
        popupEl.querySelector('[data-action="details"]').addEventListener("click", () => {
          ctx.lastPopupCustomerId = c.id;
          ctx.navigate(`#/customers/${c.id}`);
        });
        popupEl.querySelector('[data-action="checkin"]').addEventListener("click", () => {
          ctx.lastPopupCustomerId = c.id;
          ctx.navigate(`#/checkin/${c.id}`);
        });

        // The chips may have arrived after this popup's HTML was built.
        const brandsEl = popupEl.querySelector(`#popup-brands-${c.id}`);
        if (brandsEl) brandsEl.innerHTML = ctx.popupBrandChipsHtml(c.id);
        const factsEl = popupEl.querySelector(`#popup-facts-${c.id}`);
        // Facts come from one small request, shown instantly from the
        // session cache when we have it (refreshed in the background) and
        // as a same-height skeleton otherwise, so the popup never jumps.
        const render = (data) => {
          factsEl.innerHTML = ctx.popupFactsHtml(data);
          ctx.nudgePopupIntoView(popupEl);
        };
        try {
          const cached = ctx.factsCache.get(c.id);
          if (cached) render(cached.data);
          if (!cached || Date.now() - cached.at > 20000) render(await ctx.fetchFacts(c.id));
        } catch {
          if (!ctx.factsCache.get(c.id)) factsEl.innerHTML = "";
        }
      });
      marker.on("mousedown touchstart", () => {
        if (!ctx.factsCache.has(c.id)) ctx.fetchFacts(c.id).catch(() => {});
      });
      ctx.lastCustomers.push({ c, marker });
      bounds.push([c.lat, c.lng]);
    }
  }

  ctx.resolveCustomersReady();
  ctx.renderIconFilterRow();
  ctx.applyFilter({ refit: false });
  ctx.refreshNearestCustomerBar();
  ctx.warmVisiblePopups();

  // Item 7 -- customer detail's Navigate button offers "Show on map" as an
  // in-app alternative to leaving for an external navigation app; this is
  // the mechanism it (and any future "open map centered on customer X"
  // caller) relies on. A customer not in the (filtered) list just silently
  // has nothing to focus, same as the relocate flow above handling a
  // missing id.
  if (ctx.focusCustomerId != null) {
    // Counts as the map's "first settle" too (see the geolocation-based
    // centering this guards against in applyFilter above) -- otherwise
    // that block keeps re-running on every later filter change (nothing
    // else ever flips initialViewApplied while focusCustomerId stays
    // set) and yanks the map back to the user's own location the next
    // time they tap a filter chip.
    ctx.initialViewApplied = true;
    // Deliberately re-run on every paintCustomers() call (not just the
    // first), unlike the geolocation block above -- loadCustomersCached()
    // can paint twice (a cached list, then the live fetch), and each pass
    // clearLayers()s and rebuilds every marker from scratch. Skipping the
    // second call here would leave the popup open on a marker that pass
    // just destroyed, i.e. no popup at all once the live data lands
    // (reported as "Show on map" doing nothing after the Map tab had
    // already been visited once this session, since only then is there a
    // cached list to paint first).
    ctx.focusOnCustomerMarker(ctx.focusCustomerId);
  }
  if (ctx.reopenCustomerId != null && ctx.focusOnCustomerMarker(ctx.reopenCustomerId, { keepView: true })) ctx.reopenCustomerId = null;

  // Skipped alongside the marker loop above -- startAddCustomerFlow()
  // already runs its own getCurrentPosition() to center the map, so this
  // would otherwise race it with a second, redundant recenter. Also
  // one-time-guarded (see emptyBoundsRecenterAttempted above).
  if (!skipMarkers && !bounds.length && navigator.geolocation && !ctx.emptyBoundsRecenterAttempted) {
    ctx.emptyBoundsRecenterAttempted = true;
    getCurrentPosition({ timeout: 10000, goodAccuracy: 500 })
      .then((pos) => !ctx.userTouchedMap && ctx.map.setView([pos.coords.latitude, pos.coords.longitude], 13))
      .catch(() => {});
  }
}

// Always-fresh fetch + paint -- used after an action that changed the
// customer list itself (adding a new customer below) and must show up
// immediately, never behind a stale cached paint.
export async function loadCustomers(ctx) {
  const customers = await api.listCustomers();
  ctx.paintCustomers(customers);
}

// Cached stale-while-revalidate variant, used only for the view's
// initial mount (see map.whenReady below) -- paints whatever customer
// list was cached from the last visit instantly, then repaints with the
// live fetch once it lands. Never used for the post-add-customer reload
// above: that one needs the just-added customer to appear right away,
// not possibly flash the old (cached, pre-add) list first.
export async function loadCustomersCached(ctx) {
  await loadWithCache("map-customers", () => api.listCustomers(), ctx.paintCustomers);
  ctx.loadBrandSummary();
  ctx.loadTaskFlags();
  ctx.loadDebtFlags();
}
