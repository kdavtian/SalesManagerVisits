// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { categoryLabel, cssColor, escapeHtml, formatDistance, formatRelative, getCurrentPosition, getLastKnownPosition, haversineMeters, rememberPosition } from "../../util.js";
import { t } from "../../i18n.js";
import { NEARBY_RADIUS_METERS } from "../map.js";
import { api } from "../../api.js";

// Bottom-left "nearest customer" widget — an icon-only check-in shortcut
// plus a glance at who's closest, without opening a panel or a popup.
// Recomputed whenever the customer list or the user's own location
// changes (see the calls to this after each of those below); nothing to
// do here at all in relocate mode, where the widget isn't rendered.
export function refreshNearestCustomerBar(ctx) {
  if (!ctx.nearestBar) return;
  if (!ctx.myLocation || !ctx.lastCustomers.length) {
    ctx.nearestBar.hidden = true;
    ctx.nearestCustomer = null;
    return;
  }
  let nearest = null;
  let nearestDist = Infinity;
  for (const { c } of ctx.lastCustomers) {
    const d = haversineMeters(ctx.myLocation.lat, ctx.myLocation.lng, c.lat, c.lng);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = c;
    }
  }
  if (!nearest) {
    ctx.nearestBar.hidden = true;
    ctx.nearestCustomer = null;
    return;
  }
  ctx.nearestCustomer = nearest;
  ctx.nearestInfo.innerHTML = `<strong>${escapeHtml(nearest.name)}</strong><span class="muted">${formatDistance(nearestDist)}</span>`;
  ctx.nearestBar.hidden = false;
}

export async function openNearbyPanel(ctx) {
  ctx.nearbyPanel.hidden = false;
  ctx.nearbyPanelTitle.textContent = t("nearby_loading");
  ctx.nearbyList.innerHTML = "";

  if (!ctx.myLocation) {
    try {
      const pos = await getCurrentPosition();
      ctx.myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      ctx.refreshNearestCustomerBar();
    } catch {
      ctx.nearbyPanelTitle.textContent = t("nearby_location_error");
      ctx.applyFilter();
      return;
    }
  }

  ctx.applyFilter();
  ctx.renderNearbyList();
}

export function renderNearbyList(ctx) {
  if (!ctx.myLocation) return;
  const nearby = ctx.lastCustomers
    .map(({ c }) => ({ c, distance: haversineMeters(ctx.myLocation.lat, ctx.myLocation.lng, c.lat, c.lng) }))
    .filter((entry) => entry.distance <= NEARBY_RADIUS_METERS)
    .sort((a, b) => a.distance - b.distance);

  ctx.nearbyPanelTitle.textContent = `${t("nearby_customers")} · ${t("nearby_within")} · ${nearby.length}`;

  if (!nearby.length) {
    ctx.nearbyList.innerHTML = `<p class="muted">${t("nearby_empty")}</p>`;
    return;
  }

  ctx.nearbyList.innerHTML = nearby
    .map(({ c, distance }) => {
      const badge = ctx.customerStatusBadge(ctx.customerStatus(c));
      return `
      <button class="card customer-card" data-id="${c.id}">
        <div class="customer-card-main">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.category ? `<span class="muted">${escapeHtml(categoryLabel(c.category))}</span>` : ""}
          <span class="muted">${formatDistance(distance)}</span>
        </div>
        <span class="card-trailing">
          <span class="badge ${badge.cls}">${badge.text}</span>
          <span class="chevron">&#8250;</span>
        </span>
      </button>`;
    })
    .join("");

  ctx.nearbyList.querySelectorAll(".customer-card").forEach((el) => {
    el.addEventListener("click", () => ctx.navigate(`#/customers/${el.dataset.id}`));
  });
}

// The heading arrow is drawn "north-up" (0deg = pointing up) inside the
// marker's own icon. Leaflet.Rotate rotates the whole map pane -- markers
// included -- by -bearing (see the #compass-btn needle above, which has
// to counter-rotate by the same -bearing to keep pointing at true north).
// Track mode sets the map bearing to the live heading, so pre-rotating the
// arrow by +heading cancels that pane rotation and keeps it pointing
// straight up on screen, i.e. "forward" -- exactly like a Google Maps-style
// compass-mode blue dot.
export function meIcon(ctx, heading) {
  const arrow =
    heading != null
      ? `<div class="me-heading-arrow" style="transform: rotate(${heading}deg)"></div>`
      : "";
  return L.divIcon({ className: "", html: `<div class="me-dot">${arrow}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

export function updateLocateButtonState(ctx) {
  ctx.locateBtn.classList.toggle("map-control-active", ctx.locationMode === "on");
  ctx.locateBtn.classList.toggle("map-control-tracking", ctx.locationMode === "track");
  ctx.locateBtn.setAttribute(
    "aria-label",
    t(ctx.locationMode === "track" ? "location_mode_track" : ctx.locationMode === "on" ? "location_mode_on" : "locate_me")
  );
}

export function stopWatch(ctx) {
  if (ctx.watchId != null) {
    navigator.geolocation.clearWatch(ctx.watchId);
    ctx.watchId = null;
  }
}

export function onHeading(ctx, e) {
  // iOS Safari exposes a ready-to-use compass heading; everything else
  // gives raw device-orientation alpha, which runs counter-clockwise from
  // the device's start orientation and needs flipping to a clockwise
  // compass bearing.
  let heading = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : null;
  if (heading == null && typeof e.alpha === "number") heading = (360 - e.alpha) % 360;
  if (heading == null || Number.isNaN(heading)) return;
  ctx.map.setBearing(heading);
  if (ctx.meMarker) ctx.meMarker.setIcon(ctx.meIcon(heading));
}

export function stopHeading(ctx) {
  if (ctx.headingEventName) {
    window.removeEventListener(ctx.headingEventName, ctx.onHeading);
    ctx.headingEventName = null;
  }
  ctx.map.setBearing(0);
  if (ctx.meMarker) ctx.meMarker.setIcon(ctx.meIcon(null));
}

export async function startHeading(ctx) {
  if (ctx.headingEventName) return;
  // iOS 13+ only grants device-orientation data after an explicit
  // user-gesture-triggered prompt -- this function only ever runs from
  // inside the button's click handler, never on load, so the gesture
  // requirement is satisfied.
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== "granted") return;
    } catch {
      return;
    }
  }
  ctx.headingEventName = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  window.addEventListener(ctx.headingEventName, ctx.onHeading);
}

export function startWatch(ctx) {
  if (ctx.watchId != null) return;
  ctx.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      rememberPosition(pos);
      const { latitude, longitude, accuracy } = pos.coords;
      const latlng = [latitude, longitude];
      ctx.myLocation = { lat: latitude, lng: longitude };
      if (!ctx.meMarker) {
        ctx.meMarker = L.marker(latlng, { icon: ctx.meIcon(null), pane: "mePane", interactive: false, keyboard: false }).addTo(ctx.map);
        ctx.meAccuracyCircle = L.circle(latlng, {
          radius: accuracy,
          color: cssColor("--accent", "#0969da"),
          weight: 1,
          fillColor: cssColor("--accent", "#0969da"),
          fillOpacity: 0.12,
        }).addTo(ctx.map);
        ctx.map.setView(latlng, Math.max(ctx.map.getZoom(), 15));
      } else {
        ctx.meMarker.setLatLng(latlng);
        ctx.meAccuracyCircle.setLatLng(latlng).setRadius(accuracy);
        if (ctx.locationMode === "track") ctx.map.panTo(latlng, { animate: true });
      }
      ctx.refreshNearestCustomerBar();
    },
    (err) => {
      // Only a denied permission ends tracking. A TIMEOUT / POSITION_UNAVAILABLE
      // is normal while the GPS warms up or the rep walks past a building;
      // the watch keeps running and the next fix lands by itself (it used to
      // switch the button off on the first timeout, which looked like "the
      // app can't find me").
      if (err && err.code !== 1) return;
      ctx.locationMode = "off";
      ctx.updateLocateButtonState();
      ctx.stopWatch();
      ctx.stopHeading();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
  );
  // Show the last known position straight away while the fresh fix arrives.
  const known = getLastKnownPosition(120000);
  if (known && !ctx.meMarker) {
    const { latitude, longitude, accuracy } = known.coords;
    ctx.myLocation = { lat: latitude, lng: longitude };
    ctx.meMarker = L.marker([latitude, longitude], { icon: ctx.meIcon(null), pane: "mePane", interactive: false, keyboard: false }).addTo(ctx.map);
    ctx.meAccuracyCircle = L.circle([latitude, longitude], {
      radius: accuracy,
      color: cssColor("--accent", "#0969da"),
      weight: 1,
      fillColor: cssColor("--accent", "#0969da"),
      fillOpacity: 0.12,
    }).addTo(ctx.map);
    ctx.map.setView([latitude, longitude], Math.max(ctx.map.getZoom(), 15));
  }
}

export function teamAvatarColor(ctx, userId) {
  return ctx.TEAM_AVATAR_COLORS[Math.abs(Number(userId) || 0) % ctx.TEAM_AVATAR_COLORS.length];
}

export function teamMemberIcon(ctx, loc, bounce = false) {
  const letter = escapeHtml((loc.name || "?").trim().charAt(0).toUpperCase() || "?");
  const color = ctx.teamAvatarColor(loc.user_id);
  return L.divIcon({
    className: "",
    // bounce: a short hop when the team is switched on, so the eye finds them at once (owner, 2026-10-27)
    html: `<div class="team-avatar ${bounce ? "team-avatar-bounce" : ""}" style="--team-color:${color}">${letter}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export async function refreshTeamLocations(ctx, { fitBounds = false } = {}) {
  let locations;
  try {
    locations = await api.getTeamLocations();
  } catch {
    return;
  }
  ctx.teamLayer.clearLayers();
  for (const loc of locations) {
    L.marker([loc.lat, loc.lng], { icon: ctx.teamMemberIcon(loc, fitBounds), pane: "teamPane" })
      .bindPopup(
        `<div class="map-popup"><strong>${escapeHtml(loc.name)}</strong><div class="popup-category">${escapeHtml(t(`role_${loc.role}`))} · ${formatRelative(loc.updated_at)}</div></div>`
      )
      .addTo(ctx.teamLayer);
  }
  // Only zoom to fit on the toggle-on load, not on every 15s poll refresh
  // -- otherwise the map would yank the viewport out from under someone
  // who's since panned/zoomed to look at a specific area.
  if (fitBounds && locations.length) {
    try {
      ctx.map.fitBounds(
        locations.map((loc) => [loc.lat, loc.lng]),
        { padding: [50, 50], maxZoom: 15 }
      );
    } catch {
      // See the rotate-plugin pane-timing note elsewhere in this file.
    }
  }
  clearTimeout(ctx.teamEmptyHintTimer);
  if (ctx.teamBtn.classList.contains("map-control-active") && locations.length === 0) {
    ctx.teamEmptyHint.hidden = false;
    // Toast-style: shows briefly then dismisses itself, instead of
    // sitting on the map indefinitely while the toggle stays on.
    ctx.teamEmptyHintTimer = setTimeout(() => {
      ctx.teamEmptyHint.hidden = true;
    }, 2000);
  } else {
    ctx.teamEmptyHint.hidden = true;
  }
}
