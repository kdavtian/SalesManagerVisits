// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { FILTER_ICONS } from "../../filterIcons.js";
import { canViewTeamLocations, state } from "../../state.js";
import { getClusterPins, getColorBy, getCompassMode, getDebtCoin } from "../../mapPrefs.js";
import { TASK_PIN_SVG } from "../map.js";

// The map screen's markup: side list, map canvas, filter chips, legend and the bottom panels.
export function mapViewHtml(ctx) {
  return `
    <div class="map-view">
      ${
        ctx.relocateCustomerId
          ? ""
          : `<div class="map-side-list" id="map-side-list"></div>`
      }
      <div class="map-canvas" id="map-canvas">
      <div id="leaflet-map"></div>
      ${
        ctx.relocateCustomerId
          ? `<div class="relocate-banner" id="relocate-banner">
              <span>${t("relocate_hint")}</span>
              <button type="button" id="cancel-relocate">${t("cancel")}</button>
            </div>`
          : ""
      }

      ${
        ctx.relocateCustomerId
          ? ""
          : `<div class="map-top-controls">
              <div class="map-search-row">
                <div class="map-search-input-wrap">
                  <span class="map-search-input-icon" aria-hidden="true">${icons.search}</span>
                  <input type="search" id="map-customer-search" placeholder="${t("map_search_placeholder")}" aria-label="${t("map_search_placeholder")}" />
                </div>
                <div class="map-address-results map-search-panel" id="map-address-results" hidden></div>
              </div>
              <p class="map-search-no-results" id="map-search-no-results" hidden>${t("map_search_no_results")}</p>
              <div class="customer-filter-row" id="map-icon-filter-row"></div>
              <div class="map-filter-row">
                <button class="map-filter-chip chip-active" data-filter="" aria-pressed="true"><span class="map-filter-chip-icon">${icons.filter}</span>${t("filter_all")}</button>
                <button class="map-filter-chip" data-filter="overdue" aria-pressed="false"><span class="map-filter-chip-icon">${icons.mapWarning}</span>${t("filter_overdue")}</button>
                <button class="map-filter-chip" data-filter="visited-today" aria-pressed="false"><span class="map-filter-chip-icon">${icons.checkCircle}</span>${t("filter_visited_today")}</button>
                <button class="map-filter-chip" data-filter="visited-7days" aria-pressed="false"><span class="map-filter-chip-icon">${icons.clock}</span>${t("filter_visited_7days")}</button>
                <button class="map-filter-chip" data-filter="planned" aria-pressed="false"><span class="map-filter-chip-icon">${icons.send}</span>${t("filter_planned")}</button>
                <button class="map-filter-chip" data-filter="nearby" aria-pressed="false"><span class="map-filter-chip-icon">${icons.locate}</span>${t("filter_nearby")}</button>
                <button class="map-filter-chip" data-filter="brands" aria-pressed="false"><span class="map-filter-chip-icon">${FILTER_ICONS.brands}</span>${t("filter_brands")}</button>
              </div>
              <div class="map-filter-row" id="brand-picker-row" hidden></div>
              <div class="map-brand-legend" id="brand-legend" hidden>
                <span><span class="brand-legend-dot brand-legend-available"></span>${t("brand_legend_available")}</span>
                <span><span class="brand-legend-dot brand-legend-unavailable"></span>${t("brand_legend_unavailable")}</span>
                <span><span class="brand-legend-dot brand-legend-unknown"></span>${t("brand_legend_unknown")}</span>
              </div>
            </div>`
      }

      <div class="nearby-panel" id="nearby-panel" hidden>
        <div class="nearby-panel-header">
          <span id="nearby-panel-title">${t("nearby_loading")}</span>
          <button type="button" class="icon-btn" id="nearby-panel-close" aria-label="${t("cancel")}">${icons.close}</button>
        </div>
        <div class="nearby-list card-list" id="nearby-list"></div>
        <button type="button" class="nearby-view-all" id="nearby-view-all">${t("view_all_customers")}</button>
      </div>

      <!-- Bottom-docked (not a full-screen modal) so the map and its
           draggable pin stay interactive while this is showing -- a modal
           .sheet-overlay sits above everything and would swallow every tap
           and drag on the map underneath it. -->
      <div class="location-picker-panel" id="location-picker-panel" hidden></div>

      <div class="nearby-panel" id="planned-stops-panel" hidden>
        <div class="nearby-panel-header">
          <span class="planned-stops-title"><span>${t("route_stops")}</span><small id="planned-stops-summary"></small></span>
          <span class="nearby-panel-header-actions">
            <button type="button" class="icon-btn" id="open-route-btn" aria-label="${t("route_open_title")}" title="${t("route_open_title")}">${icons.navigation}</button>
            <button type="button" class="icon-btn" id="share-route-btn" aria-label="${t("route_share")}" title="${t("route_share")}">${icons.share}</button>
            <button type="button" class="btn btn-sm" id="optimize-route-btn">${t("optimize_route")}</button>
            <button type="button" class="icon-btn" id="planned-stops-close" aria-label="${t("cancel")}">${icons.close}</button>
          </span>
        </div>
        <div class="stop-list" id="stop-list"></div>
      </div>

      <div class="map-controls">
        <div class="map-control-cluster">
          <button class="map-control-btn" id="zoom-in-btn" aria-label="${t("zoom_in")}">
            ${icons.plus}
          </button>
          <div class="map-control-divider"></div>
          <button class="map-control-btn" id="zoom-out-btn" aria-label="${t("zoom_out")}">
            ${icons.minus}
          </button>
        </div>
        <button class="map-control-btn map-control-standalone" id="locate-btn" aria-label="${t("locate_me")}">
          ${icons.locate}
        </button>
        <button class="map-control-btn map-control-standalone" id="compass-btn" aria-label="${t("reset_north")}" hidden>
          ${icons.compass}
        </button>
        ${
          canViewTeamLocations()
            ? `<button class="map-control-btn map-control-standalone" id="team-locations-btn" aria-label="${t("team_locations")}">${icons.team}</button>`
            : ""
        }
        <button class="map-control-btn map-control-standalone" id="plan-day-btn" aria-label="${t("plan_day")}">
          ${icons.planDay}
        </button>
        <button class="map-control-btn map-control-standalone" id="planned-today-filter-btn" aria-label="${t("filter_planned_today")}" title="${t("filter_planned_today")}" aria-pressed="false">
          ${icons.target}
        </button>
        <button class="map-control-btn map-control-standalone map-control-legend-btn" id="map-legend-btn" aria-label="${t("map_legend")}" aria-expanded="false" aria-haspopup="dialog">
          ${icons.info}
        </button>
      </div>

      <div class="map-legend-panel" id="map-legend-panel" role="dialog" aria-label="${t("map_legend_title")}" hidden>
        <div class="map-sheet-grab" id="map-legend-grab" aria-hidden="true"><span></span></div>
        <div class="map-legend-header">
          <span>${t("map_legend_title")}</span>
          <button type="button" class="icon-btn" id="map-legend-close" aria-label="${t("close")}">${icons.close}</button>
        </div>
        <div class="map-legend-body">
          <div class="map-legend-prefs">
            <div class="map-legend-pref-row">
              <span>${t("map_cluster_pins")}</span>
              <button type="button" class="toggle-switch" id="map-legend-toggle-cluster" role="switch" aria-checked="${getClusterPins()}" aria-label="${t("map_cluster_pins")}">
                <span class="toggle-thumb"></span>
              </button>
            </div>
            <div class="map-legend-pref-row map-legend-pref-stack">
              <span>${t("map_color_by")}</span>
              <div class="segmented map-color-by" role="group" aria-label="${t("map_color_by")}">
                <button type="button" class="chip ${getColorBy(state.user?.id) === "tier" ? "chip-active" : ""}" data-color-by="tier" aria-pressed="${getColorBy(state.user?.id) === "tier"}">${t("map_color_tier")}</button>
                <button type="button" class="chip ${getColorBy(state.user?.id) === "rep" ? "chip-active" : ""}" data-color-by="rep" aria-pressed="${getColorBy(state.user?.id) === "rep"}">${t("map_color_rep")}</button>
              </div>
            </div>
            <ul class="map-rep-legend" id="map-rep-legend" hidden></ul>
            <div class="map-legend-pref-row map-legend-pref-stack">
              <span>${t("map_planned_rings")}<span role="button" tabindex="0" class="settings-inline-hint-icon" id="map-planned-rings-info" aria-label="${t("more_info")}">!</span></span>
              <div class="segmented map-planned-mode" role="group" aria-label="${t("map_planned_rings")}">
                ${["off", "highlight", "only"].map((m) => `<button type="button" class="chip" data-planned-mode="${m}" aria-pressed="false">${t(`map_planned_${m}`)}</button>`).join("")}
              </div>
            </div>
            <div class="map-legend-pref-row">
              <span>${t("map_debt_coin")}</span>
              <button type="button" class="toggle-switch" id="map-legend-toggle-debt" role="switch" aria-checked="${getDebtCoin(state.user?.id)}" aria-label="${t("map_debt_coin")}">
                <span class="toggle-thumb"></span>
              </button>
            </div>
            <div class="map-legend-pref-row">
              <span>${t("map_compass_mode")}</span>
              <button type="button" class="toggle-switch" id="map-legend-toggle-compass" role="switch" aria-checked="${getCompassMode()}" aria-label="${t("map_compass_mode")}">
                <span class="toggle-thumb"></span>
              </button>
            </div>
          </div>
          <p class="map-legend-note">${t("map_legend_shape_note")}</p>
          <ul class="map-legend-list">
            <li><img class="map-legend-swatch map-legend-swatch-img" src="/icons/markers/customer-other.svg" alt="" width="20" height="20" />${t("map_legend_customer")}</li>
            <li><img class="map-legend-swatch map-legend-swatch-img" src="/icons/markers/potential-other.png" alt="" width="20" height="20" />${t("map_legend_potential")}</li>
            <li><img class="map-legend-swatch map-legend-swatch-img" src="/icons/markers/competitor-other.svg" alt="" width="20" height="20" />${t("map_legend_competitor")}</li>
          </ul>
          <div class="map-legend-divider"></div>
          <ul class="map-legend-list">
            <li><span class="map-legend-swatch map-legend-swatch-badge map-legend-swatch-visited">&#10003;</span>${t("map_legend_visited")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-badge map-legend-swatch-overdue">!</span>${t("map_legend_overdue")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-badge map-legend-swatch-never">!!</span>${t("never_visited")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-selected"></span>${t("map_legend_selected")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-debt map-legend-swatch-debt-s" aria-hidden="true"></span>${t("map_legend_debt_s")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-debt map-legend-swatch-debt-m" aria-hidden="true"></span>${t("map_legend_debt_m")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-debt map-legend-swatch-debt-l" aria-hidden="true"></span>${t("map_legend_debt_l")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-cluster">9</span>${t("map_legend_cluster")}</li>
          </ul>
          <p class="map-legend-note">${t("map_legend_glyph_note")}</p>
          <div class="map-legend-divider"></div>
          <ul class="map-legend-list">
            <li><span class="map-legend-swatch map-legend-swatch-task map-legend-swatch-task-soon" aria-hidden="true">${TASK_PIN_SVG}</span>${t("map_legend_task_soon")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-task map-legend-swatch-task-due" aria-hidden="true">${TASK_PIN_SVG}</span>${t("map_legend_task_due")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-planned" aria-hidden="true"><b>2</b></span>${t("map_legend_planned")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-repring" aria-hidden="true"></span>${t("map_legend_rep_ring")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-stop" aria-hidden="true">1</span>${t("map_legend_route_stop")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-stop map-legend-swatch-stop-done" aria-hidden="true">&#10003;</span>${t("map_legend_route_stop_done")}</li>
          </ul>
          <div class="map-legend-divider"></div>
          <ul class="map-legend-list">
            <li><span class="map-legend-swatch map-legend-swatch-dot map-legend-swatch-dot-available" aria-hidden="true"></span>${t("map_legend_brand_available")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-dot map-legend-swatch-dot-unavailable" aria-hidden="true"></span>${t("map_legend_brand_unavailable")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-dot map-legend-swatch-dot-unknown" aria-hidden="true"></span>${t("map_legend_brand_unknown")}</li>
          </ul>
          <div class="map-legend-divider"></div>
          <ul class="map-legend-list">
            <li><span class="map-legend-swatch map-legend-swatch-me" aria-hidden="true"></span>${t("map_legend_me")}</li>
            <li><span class="map-legend-swatch map-legend-swatch-team" aria-hidden="true">A</span>${t("map_legend_team")}</li>
          </ul>
        </div>
      </div>

      <button class="fab" id="add-customer-fab" title="${t("new_customer")}" aria-label="${t("new_customer")}" aria-pressed="false">${icons.mapPinPlus}</button>
      ${
        ctx.relocateCustomerId
          ? ""
          : `<div class="nearest-customer-bar" id="nearest-customer-bar" hidden>
              <button type="button" class="nearest-checkin-btn" id="nearest-checkin-btn" aria-label="${t("check_in")}">${icons.mapPinCheck}</button>
              <div class="nearest-customer-info" id="nearest-customer-info"></div>
            </div>`
      }
      <div class="map-hint" id="map-hint" role="status" ${ctx.startInAddMode ? "" : "hidden"}>${t("tap_map_hint")}</div>
      <div class="map-hint" id="map-retry-hint" role="status" hidden>${t("loading")}</div>
      <div class="map-error-overlay" id="map-error-overlay" role="alert" hidden>
        <div class="map-error-card">
          <p>${t("map_load_failed")}</p>
          <button type="button" class="btn btn-primary" id="map-error-retry">${t("try_again")}</button>
        </div>
      </div>
      <div class="map-hint" id="team-empty-hint" hidden>${t("team_locations_empty")}</div>
      <div class="map-hint" id="planned-empty-hint" hidden>${t("planned_empty")}</div>
      </div>
    </div>
  `;
}
