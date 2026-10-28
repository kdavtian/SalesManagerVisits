// Parts of renderMapInner (map.js), moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each
// function takes the screen's state as `ctx` (see the ctx object at the top of renderMapInner).
import { NO_GROUP_KEY, buildCustomerTree, renderTriStateTree } from "../../regionTree.js";
import { routeLegs } from "../../routeNavigation.js";
import { activateDialog, escapeHtml, formatDistance, haversineMeters, showToast } from "../../util.js";
import { t } from "../../i18n.js";
import { api } from "../../api.js";
import { canPlanForOthers, canViewTeamLocations, state } from "../../state.js";
import { icons } from "../../icons.js";
import { repColor } from "../../repColors.js";
import { setPlannedMode } from "../../mapPrefs.js";

// The rep whose plan "Planned" should show: a sales manager's own id, else the single rep
// the user picked in the assignment filter (several reps or none = everyone's plans).
export function selectedPlanManagerId(ctx) {
  if (ctx.managerFilter) return ctx.managerFilter;
  if (ctx.assignmentKeys === null || !ctx.assignmentKeys.size) return "";
  const ids = new Set([...ctx.assignmentKeys].map((k) => k.split("::")[1]));
  return ids.size === 1 && !ids.has(NO_GROUP_KEY) ? [...ids][0] : "";
}

// Pulled out of renderStopListPanel so applyFilter's own "no longer on
// the planned filter" branch can call just the cleanup half -- it used
// to only hide the stop-list panel there, never touching the numbered
// stop markers or the dashed route polyline renderStopListPanel had
// drawn, so switching off "Planned" left that route line stuck on the
// map until the filter was tapped back on (which redraws over it, but
// never happening again left it there for good).
export function clearRouteAndStops(ctx) {
  ctx.stopMarkers.forEach((m) => ctx.markerLayer.removeLayer(m));
  ctx.stopMarkers.length = 0;
  if (ctx.routeLine) {
    ctx.map.removeLayer(ctx.routeLine);
    ctx.routeLine = null;
  }
}

export function renderStopListPanel(ctx) {
  ctx.clearRouteAndStops();

  if (ctx.activeFilter !== "planned" || !ctx.plannedCustomerIds?.length) {
    ctx.plannedStopsPanel.hidden = true;
    ctx.stopListEl.innerHTML = "";
    return;
  }

  const stops = ctx.plannedCustomerIds.map((id) => ctx.lastCustomers.find((entry) => entry.c.id === id)).filter(Boolean);
  if (!stops.length) {
    ctx.plannedStopsPanel.hidden = true;
    return;
  }

  const latlngs = [];
  stops.forEach(({ c }, i) => {
    const visited = ctx.customerStatus(c) === "today";
    const marker = L.marker([c.lat, c.lng], { icon: ctx.numberedIcon(i + 1, visited) }).addTo(ctx.markerLayer);
    marker.on("click", () => ctx.navigate(`#/customers/${c.id}`));
    ctx.stopMarkers.push(marker);
    latlngs.push([c.lat, c.lng]);
  });
  // Leaflet's SVG renderer sets stroke via setAttribute, which doesn't
  // resolve CSS custom properties -- read the theme's actual color value.
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0969da";
  ctx.routeLine = L.polyline(latlngs, { color: accentColor, weight: 3, opacity: 0.8, dashArray: "6 6" }).addTo(ctx.map);

  ctx.plannedStopsPanel.hidden = false;
  // About-km per leg (straight line x 1.3) and for the whole route, from the rep's position when known.
  const { legs, total } = routeLegs(stops.map(({ c }) => c), ctx.myLocation);
  ctx.plannedStopsPanel.querySelector("#planned-stops-summary").textContent = `${stops.length}${total ? ` · ≈ ${formatDistance(total)}` : ""}`;
  ctx.stopListEl.innerHTML = stops
    .map(({ c }, i) => {
      const visited = ctx.customerStatus(c) === "today";
      return `
      <div class="stop-row" data-index="${i}">
        <span class="stop-number ${visited ? "stop-number-done" : ""}">${visited ? "&#10003;" : i + 1}</span>
        <span class="stop-name">${escapeHtml(c.name)}${legs[i] != null ? `<span class="stop-leg">≈ ${formatDistance(legs[i])}</span>` : ""}</span>
        <span class="stop-reorder">
          <button type="button" class="icon-btn" data-move="up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="${t("move_up")}">&uarr;</button>
          <button type="button" class="icon-btn" data-move="down" data-index="${i}" ${i === stops.length - 1 ? "disabled" : ""} aria-label="${t("move_down")}">&darr;</button>
        </span>
      </div>`;
    })
    .join("");

  ctx.stopListEl.querySelectorAll("[data-move]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.index);
      const j = btn.dataset.move === "up" ? i - 1 : i + 1;
      [ctx.plannedCustomerIds[i], ctx.plannedCustomerIds[j]] = [ctx.plannedCustomerIds[j], ctx.plannedCustomerIds[i]];
      ctx.renderStopListPanel();
      try {
        await api.saveVisitPlan(undefined, ctx.plannedCustomerIds);
      } catch {
        // Order is still reflected locally; the next plan load will
        // reconcile if the save genuinely failed.
      }
    });
  });

  ctx.stopListEl.querySelectorAll(".stop-name").forEach((el, i) => {
    el.addEventListener("click", () => ctx.navigate(`#/customers/${stops[i].c.id}`));
  });
}

// Greedy nearest-neighbor ordering -- not a true shortest-route solver,
// but for the handful of stops a single rep plans in a day it gets close
// enough while staying instant and dependency-free. Starts from the
// rep's live location when available (locate button already tapped),
// otherwise from whichever stop is currently first.
export function nearestNeighborOrder(ctx, ids) {
  const remaining = ids.map((id) => ctx.lastCustomers.find((entry) => entry.c.id === id)).filter(Boolean);
  if (!remaining.length) return ids;
  const ordered = [];
  let current = ctx.myLocation ?? { lat: remaining[0].c.lat, lng: remaining[0].c.lng };
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((entry, i) => {
      const distance = haversineMeters(current.lat, current.lng, entry.c.lat, entry.c.lng);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    });
    const [chosen] = remaining.splice(bestIndex, 1);
    ordered.push(chosen.c.id);
    current = { lat: chosen.c.lat, lng: chosen.c.lng };
  }
  return ordered;
}

// Shared by the "Planned" chip (route-stops view below) and the
// "Planned today" icon toggle (an independent AND-with-everything-else
// filter, see plannedTodayOnly) -- both need the same "who's today's
// plan for, given the current manager filter" resolution, just rendered
// differently.
export async function fetchTodayPlannedIds(ctx) {
  let ids = [];
  try {
    const planManager = ctx.selectedPlanManagerId();
    if (planManager || !canViewTeamLocations()) {
      // canViewTeamLocations roles (admin/director/ceo) can pick a specific
      // manager from the map's own manager filter -- the Planned filter
      // needs to follow that same selection instead of always asking for
      // the viewer's own plan (which is empty for these roles, since they
      // don't have field-visit route plans of their own). This was the map
      // "Planned" filter's actual disconnect from Route Plans: a
      // director/admin choosing a manager and tapping Planned always saw
      // nothing, because it silently kept querying their own account's
      // plan regardless of who was selected.
      const plan = await api.getMyVisitPlan(undefined, planManager || undefined);
      ids = plan?.status === "approved" ? plan.customer_ids : [];
    } else {
      // Still true even with the fix above: a director/admin/CEO who
      // hasn't picked anyone in the manager filter has no personal route
      // of their own either, so this branch was ALSO always empty for
      // them -- the actual most-reported case, since nobody manages by
      // hand-picking one rep every time before checking the map. Show the
      // union of every rep's approved plan for today instead, so
      // "Planned" is useful the moment the tab opens.
      const reps = await api.listPlannableUsers();
      const plans = await Promise.all(reps.map((u) => api.getMyVisitPlan(undefined, u.id).catch(() => null)));
      const idSet = new Set();
      plans.forEach((plan) => {
        if (plan?.status === "approved") plan.customer_ids.forEach((id) => idSet.add(id));
      });
      ids = [...idSet];
    }
  } catch {
    ids = [];
  }
  return ids;
}

export async function loadPlannedFilter(ctx) {
  const ids = await ctx.fetchTodayPlannedIds();
  await ctx.customersReady;
  ctx.plannedCustomerIds = ids;
  ctx.applyFilter();
}

export async function openPlanDaySheet(ctx) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("plan_day")}</h2>
      ${
        canPlanForOthers()
          ? `<label>${t("planning_for")}
              <select id="plan-target-select">
                <option value="">${t("myself")}</option>
              </select>
            </label>`
          : ""
      }
      <div class="plan-mode-tabs" role="tablist">
        <button type="button" class="plan-mode-tab plan-mode-tab-active" data-mode="today" role="tab" aria-selected="true" aria-controls="plan-body" tabindex="0">${t("plan_mode_today")}</button>
        <button type="button" class="plan-mode-tab" data-mode="recurring" role="tab" aria-selected="false" aria-controls="plan-body" tabindex="-1">${t("plan_mode_recurring")}</button>
      </div>
      <div id="plan-body" role="tabpanel"><p class="loading-state" role="status">${t("loading")}</p></div>
      <p class="form-error" id="plan-day-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="cancel-plan-day">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="save-plan-day">${t("save_plan")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-plan-day").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  // The customer checklist below reads lastCustomers, which is still
  // empty for a beat after the map view mounts -- wait for it so the
  // list isn't rendered permanently blank.
  await ctx.customersReady;

  const bodyEl = overlay.querySelector("#plan-body");
  const errorEl = overlay.querySelector("#plan-day-error");
  const targetSelect = overlay.querySelector("#plan-target-select");
  const saveBtn = overlay.querySelector("#save-plan-day");

  let targetUserId = null;
  let mode = "today";
  let selectedWeekday = new Date().getDay();

  if (targetSelect) {
    try {
      const plannable = await api.listPlannableUsers();
      targetSelect.insertAdjacentHTML(
        "beforeend",
        plannable.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}${u.position ? ` (${escapeHtml(u.position)})` : ""}</option>`).join("")
      );
    } catch {
      // Leave just "Myself" if this fails -- not fatal.
    }
    targetSelect.addEventListener("change", () => {
      targetUserId = targetSelect.value || null;
      renderBody();
    });
  }

  const planModeTabs = [...overlay.querySelectorAll(".plan-mode-tab")];
  function selectPlanMode(tab) {
      planModeTabs.forEach((t2) => {
        t2.classList.remove("plan-mode-tab-active");
        t2.setAttribute("aria-selected", "false");
        t2.tabIndex = -1;
      });
      tab.classList.add("plan-mode-tab-active");
      tab.setAttribute("aria-selected", "true");
      tab.tabIndex = 0;
      mode = tab.dataset.mode;
      renderBody();
  }
  planModeTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPlanMode(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const nextIndex = (index + (event.key === "ArrowRight" ? 1 : -1) + planModeTabs.length) % planModeTabs.length;
      planModeTabs[nextIndex].focus();
      selectPlanMode(planModeTabs[nextIndex]);
    });
  });

  async function renderBody() {
    errorEl.hidden = true;
    bodyEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    if (mode === "today") {
      await renderTodayMode();
    } else {
      await renderRecurringMode();
    }
  }

  async function renderTodayMode() {
    let existingPlan;
    try {
      existingPlan = await api.getMyVisitPlan(undefined, targetUserId);
    } catch {
      existingPlan = null;
    }
    const selectedIds = new Set(existingPlan?.customer_ids ?? []);
    const statusClass =
      existingPlan?.status === "approved" ? "badge-success" : existingPlan?.status === "rejected" ? "badge-danger" : "badge-neutral";
    const statusLabel = existingPlan
      ? existingPlan.source === "rule"
        ? t("plan_status_from_rule")
        : t(ctx.PLAN_STATUS_KEY[existingPlan.status])
      : t("plan_status_none");

    // Scope the checklist to whoever the plan is actually for -- the
    // customers assigned to that rep, not the entire map. Without this a
    // director planning for one SM would be picking from every other
    // rep's customers too.
    const effectiveTargetId = targetUserId ? Number(targetUserId) : state.user.id;
    const sortedCustomers = ctx.lastCustomers
      .filter(({ c }) => Number(c.assigned_manager_id) === effectiveTargetId)
      .sort((a, b) => a.c.name.localeCompare(b.c.name));

    bodyEl.innerHTML = `
      <p class="badge ${statusClass}" id="plan-status-badge">${statusLabel}</p>
      <p class="muted">${t("plan_day_hint")}</p>
      <div class="plan-day-list" id="plan-day-list"></div>
    `;
    const listEl = bodyEl.querySelector("#plan-day-list");

    // Same Region -> Subregion -> Customer tri-state accordion Route
    // Plans' own customer-pick sheet uses (regionTree.js), rather than
    // this sheet growing its own separate filter UI.
    let checkedIds;
    if (!sortedCustomers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_assigned_customers")}</p>`;
      checkedIds = new Set();
    } else {
      checkedIds = renderTriStateTree(listEl, {
        tree: buildCustomerTree(sortedCustomers.map(({ c }) => c)),
        initialSelectedIds: selectedIds,
        countUnitLabel: t("perf_dq_customers_unit"),
        totalLabel: (n) => t("customers_selected_count").replace("{n}", n),
      });
    }

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      // renderTriStateTree's selectedIds Set is normalized to strings
      // (see regionTree.js) -- back to numbers for the visit-plan API.
      const ids = [...checkedIds].map(Number);
      try {
        await api.saveVisitPlan(undefined, ids, targetUserId);
        close();
        if (ctx.activeFilter === "planned") ctx.loadPlannedFilter();
        if (ctx.plannedMode !== "off") ctx.refreshPlannedToday();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        saveBtn.disabled = false;
      }
    };
  }

  async function renderRecurringMode() {
    let regions = [];
    let rules = [];
    try {
      [regions, rules] = await Promise.all([api.getCustomerRegions(), api.getVisitPlanRules(targetUserId)]);
    } catch {
      regions = [];
      rules = [];
    }
    const regionNames = [...new Set(regions.map((r) => r.region))];
    const currentRule = rules.find((r) => r.day_of_week === selectedWeekday);
    const areas = currentRule?.areas ?? [];

    bodyEl.innerHTML = `
      <p class="muted">${t("plan_recurring_hint").replace("[weekday]", t(ctx.WEEKDAY_KEYS[selectedWeekday]))}</p>
      <div class="weekday-picker" id="weekday-picker">
        ${ctx.WEEKDAY_ORDER.map(
          (i) => `<button type="button" class="weekday-btn ${i === selectedWeekday ? "weekday-btn-active" : ""}" data-day="${i}">${t(ctx.WEEKDAY_KEYS[i])}</button>`
        ).join("")}
      </div>
      <div class="plan-area-list" id="plan-area-list">
        ${
          areas.length
            ? areas
                .map(
                  (a, i) => `
            <div class="plan-area-row" data-index="${i}">
              <span>${escapeHtml(a.region)}${a.subregion ? ` · ${escapeHtml(a.subregion)}` : ""}</span>
              <button type="button" class="icon-btn plan-area-remove" data-index="${i}" aria-label="${t("cancel")}">${icons.close}</button>
            </div>`
                )
                .join("")
            : `<p class="muted">${t("no_areas_yet")}</p>`
        }
      </div>
      <div class="plan-area-add-row">
        <select id="plan-add-region">
          <option value="">${t("region")}</option>
          ${regionNames.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
        </select>
        <select id="plan-add-subregion">
          <option value="">${t("all_subregions")}</option>
        </select>
        <button type="button" class="btn btn-sm plan-add-area-btn" id="plan-add-area-btn" aria-label="${t("add_area")}">${icons.plus}</button>
      </div>
    `;

    let workingAreas = areas.map((a) => ({ ...a }));
    const regionSelect = bodyEl.querySelector("#plan-add-region");
    const subregionSelect = bodyEl.querySelector("#plan-add-subregion");

    regionSelect.addEventListener("change", () => {
      const subregions = regions.filter((r) => r.region === regionSelect.value && r.subregion).map((r) => r.subregion);
      subregionSelect.innerHTML = `<option value="">${t("all_subregions")}</option>${subregions
        .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
        .join("")}`;
    });

    function paintAreaList() {
      const listEl = bodyEl.querySelector("#plan-area-list");
      listEl.innerHTML = workingAreas.length
        ? workingAreas
            .map(
              (a, i) => `
        <div class="plan-area-row" data-index="${i}">
          <span>${escapeHtml(a.region)}${a.subregion ? ` · ${escapeHtml(a.subregion)}` : ""}</span>
          <button type="button" class="icon-btn plan-area-remove" data-index="${i}" aria-label="${t("cancel")}">${icons.close}</button>
        </div>`
            )
            .join("")
        : `<p class="muted">${t("no_areas_yet")}</p>`;
      listEl.querySelectorAll(".plan-area-remove").forEach((btn) => {
        btn.addEventListener("click", () => {
          workingAreas.splice(Number(btn.dataset.index), 1);
          paintAreaList();
        });
      });
    }
    paintAreaList();

    bodyEl.querySelector("#plan-add-area-btn").addEventListener("click", () => {
      if (!regionSelect.value) return;
      workingAreas.push({ region: regionSelect.value, subregion: subregionSelect.value || null });
      paintAreaList();
    });

    bodyEl.querySelectorAll(".weekday-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // Persist whatever was staged for the day being left before switching.
        try {
          await api.saveVisitPlanRule(selectedWeekday, workingAreas, targetUserId);
        } catch {
          // Non-fatal -- the explicit Save button below is the primary save path.
        }
        selectedWeekday = Number(btn.dataset.day);
        renderRecurringMode();
      });
    });

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        await api.saveVisitPlanRule(selectedWeekday, workingAreas, targetUserId);
        close();
        if (ctx.activeFilter === "planned") ctx.loadPlannedFilter();
        if (ctx.plannedMode !== "off") ctx.refreshPlannedToday();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        saveBtn.disabled = false;
      }
    };
  }

  await renderBody();
}

export async function loadPlannedTodayByRep(ctx) {
  ctx.plannedTodayByRep = new Map();
  if (ctx.plannedMode === "off") return;
  ctx.plannedTodayByRep = await ctx.fetchPlannedToday();
}

// customer id -> { userId, color, order } of today's approved plans (the viewer's own, the picked rep's, or every rep's)
export async function fetchPlannedToday(ctx) {
  const out = new Map();
  const colorOfUser = (userId, chosen) => {
    const known = ctx.lastCustomers.find(({ c }) => Number(c.assigned_manager_id) === Number(userId) && c.assigned_manager_color);
    return repColor(userId, chosen || known?.c.assigned_manager_color);
  };
  const add = (plan, userId, chosen) => {
    if (plan?.status !== "approved") return;
    const color = colorOfUser(userId, chosen);
    (plan.customer_ids ?? []).forEach((id, i) => {
      if (!out.has(id)) out.set(id, { userId, color, order: i + 1 });
    });
  };
  try {
    const picked = ctx.selectedPlanManagerId();
    if (picked || !canViewTeamLocations()) {
      const userId = picked ? Number(picked) : state.user.id;
      add(await api.getMyVisitPlan(undefined, picked || undefined), userId);
    } else {
      const reps = await api.listPlannableUsers();
      const plans = await Promise.all(reps.map((u) => api.getMyVisitPlan(undefined, u.id).catch(() => null)));
      plans.forEach((plan, i) => add(plan, reps[i].id, reps[i].map_color));
    }
  } catch {
    return new Map();
  }
  return out;
}

export async function syncSidePlanned(ctx) {
  if (!ctx.sideTable) return;
  await ctx.customersReady;
  if (ctx.plannedMode !== "off") return ctx.sideTable.setPlanned(ctx.plannedTodayByRep);
  ctx.sidePlannedOff ??= await ctx.fetchPlannedToday();
  ctx.sideTable?.setPlanned(ctx.sidePlannedOff);
}

export async function refreshPlannedToday(ctx, { refit = false } = {}) {
  await ctx.customersReady;
  await ctx.loadPlannedTodayByRep();
  ctx.plannedTodayIdSet = new Set(ctx.plannedTodayByRep.keys());
  ctx.applyFilter({ refit });
  ctx.syncSidePlanned();
  if (ctx.plannedMode === "only" && !ctx.plannedTodayIdSet.size) showToast(t("planned_empty"));
}

export function paintPlannedControls(ctx) {
  if (ctx.plannedBtn) {
    ctx.plannedBtn.dataset.mode = ctx.plannedMode;
    ctx.plannedBtn.classList.toggle("map-control-active", ctx.plannedMode !== "off");
    ctx.plannedBtn.setAttribute("aria-pressed", String(ctx.plannedMode !== "off"));
    const text = `${t("filter_planned_today")}: ${ctx.plannedLabel[ctx.plannedMode]}`;
    ctx.plannedBtn.setAttribute("aria-label", text);
    ctx.plannedBtn.title = text;
  }
  ctx.root.querySelectorAll("[data-planned-mode]").forEach((b) => {
    const on = b.dataset.plannedMode === ctx.plannedMode;
    b.classList.toggle("chip-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

export function setPlannedModeTo(ctx, mode) {
  if (mode === ctx.plannedMode) return;
  ctx.plannedMode = mode;
  setPlannedMode(state.user?.id, mode);
  ctx.paintPlannedControls();
  if (mode === "off") {
    ctx.plannedTodayByRep = new Map();
    ctx.plannedTodayIdSet = null;
    ctx.applyFilter({ refit: false });
    ctx.syncSidePlanned();
  } else {
    ctx.refreshPlannedToday({ refit: mode === "only" });
  }
}
