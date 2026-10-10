import { api } from "../api.js";
import { escapeHtml, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, canPlanForOthers, canViewAllRoutePlans } from "../state.js";
import { buildCustomerTree, renderTriStateTree } from "../regionTree.js";
import { icons } from "../icons.js";

const WEEKDAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];
// Display order only -- day_of_week values stay 0=Sun..6=Sat (JS Date#getDay()),
// but the week is shown Monday-first everywhere in the UI.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
// A region/subregion group header shows at most this many real day badges
// before collapsing the rest into a "+N" overflow badge -- past 3, a
// region covered every day of the week would otherwise print 6-7 pills
// across the header and defeat the point of a quick glance.
const MAX_GROUP_DAY_BADGES = 3;

// Route Plans is the recurring weekday cycle -- "every Monday, Rita visits
// these 6 customers". It's the same visit_plan_rules data the Map page's
// quick planner writes, just with its own dedicated overview (all reps x
// all weekdays at a glance) and a guided create flow (rep -> day(s) ->
// pick straight from that rep's assigned customers) for a
// director/ceo/admin planning on someone else's behalf.
export async function renderRoutePlans(root, navigate) {
  const canManage = canPlanForOthers();
  // The accountant sees every rep's plan but cannot change it.
  const canViewAll = canViewAllRoutePlans();

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("route_plans")}</h1></div>
      </div>
      ${canManage ? `<button type="button" class="btn btn-primary btn-block" id="new-route-plan-btn">+ ${t("new_route_plan")}</button>` : ""}
      ${canManage ? `<button type="button" class="btn btn-block" id="route-distribution-btn" style="margin-top:8px;">${t("route_distribution_title")}</button>` : ""}
      <p class="form-error" id="route-plans-error" hidden></p>
      <div id="route-plans-body" style="margin-top:12px;"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const bodyEl = container.querySelector("#route-plans-body");
  const errorEl = container.querySelector("#route-plans-error");

  async function load() {
    bodyEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (canViewAll) {
        const overview = await api.getRoutePlansOverview();
        paintOverview(overview);
      } else {
        await paintOwnWeek();
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  function paintOverview(overview) {
    if (!overview.length) {
      bodyEl.innerHTML = `<p class="empty-state">${t("no_sales_reps_yet")}</p>`;
      return;
    }
    bodyEl.innerHTML = overview
      .map((rep) => {
        const byDay = new Map(rep.days.map((d) => [d.day_of_week, d]));
        return `
      <div class="card route-plan-rep-card">
        <div class="route-plan-rep-header">
          <strong>${escapeHtml(rep.user_name)}</strong>
          ${rep.position ? `<span class="muted">${escapeHtml(rep.position)}</span>` : ""}
        </div>
        <div class="route-plan-week-row">
          ${WEEKDAY_ORDER.map((i) => {
            const day = byDay.get(i);
            const count = day?.customer_count ?? 0;
            return `<button type="button" class="route-plan-day-chip ${count ? "route-plan-day-chip-active" : ""}" data-user-id="${rep.user_id}" data-user-name="${escapeHtml(rep.user_name)}" data-day="${i}">
              <span class="route-plan-day-label">${t(WEEKDAY_KEYS[i])}</span>
              <span class="route-plan-day-count">${count || "–"}</span>
            </button>`;
          }).join("")}
        </div>
        <button type="button" class="btn route-plan-view-customers-btn" data-user-id="${rep.user_id}" data-user-name="${escapeHtml(rep.user_name)}">${t("view_customers")}</button>
      </div>`;
      })
      .join("");

    bodyEl.querySelectorAll(".route-plan-day-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!canManage) {
          openCustomersByDaySheet(Number(btn.dataset.userId), btn.dataset.userName);
          return;
        }
        openEditSheet(Number(btn.dataset.userId), btn.dataset.userName, Number(btn.dataset.day), load);
      });
    });
    bodyEl.querySelectorAll(".route-plan-view-customers-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        openCustomersByDaySheet(Number(btn.dataset.userId), btn.dataset.userName);
      });
    });
  }

  async function paintOwnWeek() {
    const rules = await api.getVisitPlanRules();
    const byDay = new Map(rules.map((r) => [r.day_of_week, r]));
    bodyEl.innerHTML = `
      <p class="muted" style="margin: 0 4px 10px;">${t("route_plan_own_hint")}</p>
      <div class="route-plan-week-row route-plan-week-row-standalone">
        ${WEEKDAY_ORDER.map((i) => {
          const rule = byDay.get(i);
          const count = rule ? new Set([...(rule.customer_ids || [])]).size : 0;
          return `<button type="button" class="route-plan-day-chip ${count ? "route-plan-day-chip-active" : ""}" data-day="${i}">
            <span class="route-plan-day-label">${t(WEEKDAY_KEYS[i])}</span>
            <span class="route-plan-day-count">${count || "–"}</span>
          </button>`;
        }).join("")}
      </div>
      <button type="button" class="btn route-plan-view-customers-btn" id="own-view-customers-btn">${t("view_customers")}</button>
    `;
    bodyEl.querySelectorAll(".route-plan-day-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        openEditSheet(state.user.id, state.user.name, Number(btn.dataset.day), load);
      });
    });
    bodyEl.querySelector("#own-view-customers-btn").addEventListener("click", () => {
      openCustomersByDaySheet(state.user.id, state.user.name);
    });
  }

  container.querySelector("#route-distribution-btn")?.addEventListener("click", () => navigate("#/route-distribution"));
  container.querySelector("#new-route-plan-btn")?.addEventListener("click", () => {
    openNewRoutePlanFlow(load);
  });

  await load();
}

// Step 3 of the flow, also reused as the direct edit sheet when tapping an
// existing day chip: a plain multi-day-aware customer picker for one rep,
// scoped to that rep's assigned customers (assigned_manager_id) -- not the
// whole customer book, since a route plan is about who this rep already
// owns, not a general-purpose customer browser.
async function openCustomerPickSheet({ userId, userName, days, existingCustomerIds = [], existingIdsPromise = null, onSaved }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(userName)}</h2>
      <p class="muted">${[...days].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b)).map((d) => t(WEEKDAY_KEYS[d])).join(", ")}</p>
      <div id="route-plan-customer-list" class="plan-day-list"><p class="loading-state" role="status">${t("loading")}</p></div>
      <p class="form-error" id="route-plan-picker-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="cancel-route-plan-picker">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="save-route-plan-picker">${t("save_plan")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-route-plan-picker").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const listEl = overlay.querySelector("#route-plan-customer-list");
  const errorEl = overlay.querySelector("#route-plan-picker-error");
  const saveBtn = overlay.querySelector("#save-route-plan-picker");

  let selectedIds = new Set(existingCustomerIds);

  try {
    // The sheet is already on screen; its two reads run in parallel. The
    // light route-plan customer list (id, name, region, subregion) replaces
    // the full customer list, which carried ~700 bytes and several computed
    // visit-status columns per customer that this picker never shows.
    const [existing, { customers }] = await Promise.all([existingIdsPromise ?? existingCustomerIds, api.getRoutePlanCustomers(userId)]);
    selectedIds = new Set(existing);
    if (!customers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_assigned_customers")}</p>`;
      saveBtn.disabled = true;
    } else {
      selectedIds = renderTriStateTree(listEl, {
        tree: buildCustomerTree(customers),
        initialSelectedIds: selectedIds,
        countUnitLabel: t("perf_dq_customers_unit"),
        totalLabel: (n) => t("customers_selected_count").replace("{n}", n),
      });
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    // renderTriStateTree's selectedIds Set is normalized to strings
    // (see regionTree.js) -- back to numbers for the customer-id API.
    const ids = [...selectedIds].map(Number);
    try {
      // Each day is its own row (UNIQUE on user_id + day_of_week, see the
      // ON CONFLICT upsert in visitPlans.js), so there's no shared state
      // for concurrent writes to race on -- safe to fire all of them at
      // once instead of waiting on each day's round trip before starting
      // the next, which serialized up to 7 sequential requests on what's
      // often a slow field connection.
      await Promise.all(days.map((day) => api.saveVisitPlanRule(day, [], userId, ids)));
      close();
      onSaved();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      saveBtn.disabled = false;
    }
  });
}


async function openEditSheet(userId, userName, dayOfWeek, onSaved) {
  // Open the sheet at once (with its loading state) and fetch inside it, so a
  // tap always gives immediate feedback instead of waiting on a request first.
  const existingIdsPromise = api
    .getVisitPlanRules(userId)
    .then((rules) => rules.find((r) => r.day_of_week === dayOfWeek)?.customer_ids ?? [])
    .catch(() => []);
  await openCustomerPickSheet({ userId, userName, days: [dayOfWeek], existingIdsPromise, onSaved });
}

// Read-only Region -> Subregion -> Customer accordion for the "View
// customers" sheet -- same shape as regionTree.js's tri-state tree, but
// each leaf row shows day badges instead of a checkbox, so it can't just
// reuse renderTriStateTree. Kept local to this file rather than added to
// the shared component, since nothing else needs a read-only badge variant.
function sortLeavesUnplannedFirst(nodes, daysById) {
  for (const node of nodes) {
    if (node.leaves) {
      node.leaves.sort((a, b) => {
        const aPlanned = (daysById.get(a.id) || []).length > 0;
        const bPlanned = (daysById.get(b.id) || []).length > 0;
        if (aPlanned !== bPlanned) return aPlanned ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    }
    if (node.children) sortLeavesUnplannedFirst(node.children, daysById);
  }
}

function customerRowHtml(leaf, daysById) {
  const days = daysById.get(leaf.id) || [];
  const badges = days.length
    ? [...days]
        .sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b))
        .map((d) => `<span class="route-plan-day-badge">${t(WEEKDAY_KEYS[d])}</span>`)
        .join("")
    : `<span class="route-plan-day-badge route-plan-day-badge-unplanned">${t("route_plan_unplanned")}</span>`;
  return `
    <div class="route-plan-customer-row">
      <span class="route-plan-customer-name">${escapeHtml(leaf.name)}</span>
      <span class="route-plan-customer-badges">${badges}</span>
    </div>`;
}

// Union of every day covered by any customer under this group (region-level
// node.allIds spans all its subregions, subregion-level is just its own --
// see regionTree.js), capped at MAX_GROUP_DAY_BADGES real badges plus a
// "+N" overflow badge (its title lists the rest) so a region covering every
// day of the week doesn't print 6-7 pills across the header.
function groupDayBadgesHtml(node, daysById) {
  const daySet = new Set();
  for (const id of node.allIds) {
    for (const d of daysById.get(id) || []) daySet.add(d);
  }
  if (!daySet.size) return "";
  const sortedDays = [...daySet].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
  const shown = sortedDays.slice(0, MAX_GROUP_DAY_BADGES);
  const overflowDays = sortedDays.slice(MAX_GROUP_DAY_BADGES);
  const badges = shown.map((d) => `<span class="route-plan-day-badge route-plan-day-badge-sm">${t(WEEKDAY_KEYS[d])}</span>`).join("");
  const overflowBadge = overflowDays.length
    ? `<span class="route-plan-day-badge route-plan-day-badge-sm route-plan-day-badge-overflow" title="${escapeHtml(overflowDays.map((d) => t(WEEKDAY_KEYS[d])).join(", "))}">+${overflowDays.length}</span>`
    : "";
  return badges + overflowBadge;
}

function customerGroupNodeHtml(node, daysById, nested) {
  const childrenHtml = node.children
    ? node.children.map((c) => customerGroupNodeHtml(c, daysById, true)).join("")
    : node.leaves.map((leaf) => customerRowHtml(leaf, daysById)).join("");
  const groupBadges = groupDayBadgesHtml(node, daysById);
  return `
    <div class="route-plan-tree-node ${nested ? "route-plan-tree-node-nested" : ""}">
      <div class="route-plan-tree-row" data-toggle="${escapeHtml(node.key)}" role="button" tabindex="0" aria-expanded="false">
        <span class="route-plan-tree-name">${escapeHtml(node.name)}</span>
        <span class="route-plan-tree-count">${node.customerCount} ${t("perf_dq_customers_unit")}</span>
        <span class="route-plan-tree-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </div>
      ${groupBadges ? `<div class="route-plan-tree-group-badges">${groupBadges}</div>` : ""}
      <div class="route-plan-tree-children" data-children-for="${escapeHtml(node.key)}">
        <div class="route-plan-tree-children-inner">${childrenHtml}</div>
      </div>
    </div>`;
}

function renderCustomersByDayTree(listEl, tree, daysById) {
  listEl.innerHTML = `<div class="route-plan-tree">${tree.map((n) => customerGroupNodeHtml(n, daysById, false)).join("")}</div>`;
  function toggleExpand(row) {
    const key = row.dataset.toggle;
    const childrenEl = listEl.querySelector(`.route-plan-tree-children[data-children-for="${key}"]`);
    const expanded = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", String(!expanded));
    childrenEl?.classList.toggle("expanded", !expanded);
  }
  listEl.querySelectorAll(".route-plan-tree-row[data-toggle]").forEach((row) => {
    row.addEventListener("click", () => toggleExpand(row));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpand(row);
      }
    });
  });
}

// One rep's full assigned-customer list, grouped by region/subregion, each
// row tagged with the weekday(s) an active rule covers it on -- or a red
// "Unplanned" badge if it's on none, sorted first within its group so the
// gaps in the week are the first thing a manager sees, not something they
// have to hunt for by checking each day's chip one at a time.
async function openCustomersByDaySheet(userId, userName) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(userName)}</h2>
      <p class="route-plan-tree-total" id="route-plan-customers-summary"></p>
      <div id="route-plan-customers-tree"><p class="loading-state" role="status">${t("loading")}</p></div>
      <p class="form-error" id="route-plan-customers-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-primary" id="close-route-plan-customers">${t("done")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#close-route-plan-customers").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const treeEl = overlay.querySelector("#route-plan-customers-tree");
  const summaryEl = overlay.querySelector("#route-plan-customers-summary");
  const errorEl = overlay.querySelector("#route-plan-customers-error");

  try {
    const { customers } = await api.getRoutePlanCustomers(userId);
    if (!customers.length) {
      treeEl.innerHTML = `<p class="empty-state">${t("no_assigned_customers")}</p>`;
      return;
    }
    const daysById = new Map(customers.map((c) => [c.id, c.days]));
    const unplannedCount = customers.filter((c) => !c.days.length).length;
    summaryEl.textContent = unplannedCount ? t("route_plan_unplanned_count").replace("{n}", unplannedCount) : "";

    const tree = buildCustomerTree(customers);
    sortLeavesUnplannedFirst(tree, daysById);
    renderCustomersByDayTree(treeEl, tree, daysById);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

// The guided "New route plan" creation flow: pick the sales rep, then pick
// one or more weekdays to apply the same customer set to, then pick the
// customers. Each step replaces the sheet body so it reads as a wizard
// rather than one long form.
async function openNewRoutePlanFlow(onSaved) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("new_route_plan")}</h2>
      <div id="new-plan-step-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <p class="form-error" id="new-plan-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="cancel-new-plan">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="next-new-plan">${t("next")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-new-plan").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const stepBody = overlay.querySelector("#new-plan-step-body");
  const errorEl = overlay.querySelector("#new-plan-error");
  const nextBtn = overlay.querySelector("#next-new-plan");

  let step = 1;
  let selectedUserId = null;
  let selectedUserName = "";
  let selectedDays = [];

  async function renderStep1() {
    nextBtn.textContent = t("next");
    errorEl.hidden = true;
    stepBody.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    let reps = [];
    try {
      reps = await api.listPlannableUsers();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
    stepBody.innerHTML = `
      <p class="muted">${t("choose_sales_rep_hint")}</p>
      <div class="plan-day-list" id="rep-pick-list">
        ${
          reps.length
            ? reps
                .map(
                  (u) => `
          <label class="plan-day-row plan-day-row-radio">
            <input type="radio" name="rep-pick" value="${u.id}" data-name="${escapeHtml(u.name)}" />
            <span>${escapeHtml(u.name)}${u.position ? ` <span class="muted">(${escapeHtml(u.position)})</span>` : ""}</span>
          </label>`
                )
                .join("")
            : `<p class="empty-state">${t("no_sales_reps_yet")}</p>`
        }
      </div>
    `;
  }

  function renderStep2() {
    nextBtn.textContent = t("next");
    errorEl.hidden = true;
    stepBody.innerHTML = `
      <p class="muted">${t("choose_days_hint").replace("[name]", escapeHtml(selectedUserName))}</p>
      <div class="weekday-picker" id="new-plan-weekday-picker">
        ${WEEKDAY_ORDER.map(
          (i) => `<button type="button" class="weekday-btn ${selectedDays.includes(i) ? "weekday-btn-active" : ""}" data-day="${i}">${t(WEEKDAY_KEYS[i])}</button>`
        ).join("")}
      </div>
    `;
    stepBody.querySelectorAll(".weekday-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const day = Number(btn.dataset.day);
        if (selectedDays.includes(day)) {
          selectedDays = selectedDays.filter((d) => d !== day);
        } else {
          selectedDays.push(day);
        }
        btn.classList.toggle("weekday-btn-active");
      });
    });
  }

  // openCustomerPickSheet is event-driven (it returns once its own UI is
  // painted, not once the user finishes with it) -- so the wizard overlay
  // must close *before* handing off, not after awaiting this call.
  function renderStep3() {
    close();
    openCustomerPickSheet({
      userId: selectedUserId,
      userName: selectedUserName,
      days: selectedDays,
      existingCustomerIds: [],
      onSaved,
    });
  }

  nextBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    if (step === 1) {
      const picked = stepBody.querySelector('input[name="rep-pick"]:checked');
      if (!picked) {
        errorEl.textContent = t("select_sales_rep_required");
        errorEl.hidden = false;
        return;
      }
      selectedUserId = Number(picked.value);
      selectedUserName = picked.dataset.name;
      step = 2;
      renderStep2();
    } else if (step === 2) {
      if (!selectedDays.length) {
        errorEl.textContent = t("select_day_required");
        errorEl.hidden = false;
        return;
      }
      step = 3;
      renderStep3();
    }
  });

  await renderStep1();
}
