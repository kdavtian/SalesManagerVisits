import { api } from "../api.js";
import { escapeHtml, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state, canPlanForOthers } from "../state.js";

const WEEKDAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];

// Route Plans is the recurring weekday cycle -- "every Monday, Rita visits
// these 6 customers". It's the same visit_plan_rules data the Map page's
// quick planner writes, just with its own dedicated overview (all reps x
// all weekdays at a glance) and a guided create flow (rep -> day(s) ->
// pick straight from that rep's assigned customers) for a
// director/ceo/admin planning on someone else's behalf.
export async function renderRoutePlans(root, navigate) {
  const canManage = canPlanForOthers();

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("route_plans")}</h1></div>
      </div>
      ${canManage ? `<button type="button" class="btn btn-primary btn-block" id="new-route-plan-btn">+ ${t("new_route_plan")}</button>` : ""}
      <p class="form-error" id="route-plans-error" hidden></p>
      <div id="route-plans-body" style="margin-top:12px;"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
  const bodyEl = container.querySelector("#route-plans-body");
  const errorEl = container.querySelector("#route-plans-error");

  async function load() {
    bodyEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (canManage) {
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
          ${WEEKDAY_KEYS.map((key, i) => {
            const day = byDay.get(i);
            const count = day?.customer_count ?? 0;
            return `<button type="button" class="route-plan-day-chip ${count ? "route-plan-day-chip-active" : ""}" data-user-id="${rep.user_id}" data-user-name="${escapeHtml(rep.user_name)}" data-day="${i}">
              <span class="route-plan-day-label">${t(key)}</span>
              <span class="route-plan-day-count">${count || "–"}</span>
            </button>`;
          }).join("")}
        </div>
      </div>`;
      })
      .join("");

    bodyEl.querySelectorAll(".route-plan-day-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        openEditSheet(Number(btn.dataset.userId), btn.dataset.userName, Number(btn.dataset.day), load);
      });
    });
  }

  async function paintOwnWeek() {
    const rules = await api.getVisitPlanRules();
    const byDay = new Map(rules.map((r) => [r.day_of_week, r]));
    bodyEl.innerHTML = `
      <p class="muted" style="margin: 0 4px 10px;">${t("route_plan_own_hint")}</p>
      <div class="route-plan-week-row route-plan-week-row-standalone">
        ${WEEKDAY_KEYS.map((key, i) => {
          const rule = byDay.get(i);
          const count = rule ? new Set([...(rule.customer_ids || [])]).size : 0;
          return `<button type="button" class="route-plan-day-chip ${count ? "route-plan-day-chip-active" : ""}" data-day="${i}">
            <span class="route-plan-day-label">${t(key)}</span>
            <span class="route-plan-day-count">${count || "–"}</span>
          </button>`;
        }).join("")}
      </div>
    `;
    bodyEl.querySelectorAll(".route-plan-day-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        openEditSheet(state.user.id, state.user.name, Number(btn.dataset.day), load);
      });
    });
  }

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
async function openCustomerPickSheet({ userId, userName, days, existingCustomerIds = [], onSaved }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(userName)}</h2>
      <p class="muted">${days.map((d) => t(WEEKDAY_KEYS[d])).join(", ")}</p>
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

  try {
    const customers = await api.listCustomers({ assigned_manager_id: userId });
    const selectedIds = new Set(existingCustomerIds);
    if (!customers.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_assigned_customers")}</p>`;
      saveBtn.disabled = true;
    } else {
      listEl.innerHTML = customers
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (c) => `
        <label class="plan-day-row">
          <input type="checkbox" value="${c.id}" ${selectedIds.has(c.id) ? "checked" : ""} />
          <span>${escapeHtml(c.name)}</span>
        </label>`
        )
        .join("");
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const ids = [...listEl.querySelectorAll("input:checked")].map((el) => Number(el.value));
    try {
      for (const day of days) {
        await api.saveVisitPlanRule(day, [], userId, ids);
      }
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
  let existingCustomerIds = [];
  try {
    const rules = await api.getVisitPlanRules(userId);
    existingCustomerIds = rules.find((r) => r.day_of_week === dayOfWeek)?.customer_ids ?? [];
  } catch {
    existingCustomerIds = [];
  }
  await openCustomerPickSheet({ userId, userName, days: [dayOfWeek], existingCustomerIds, onSaved });
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
        ${WEEKDAY_KEYS.map(
          (key, i) => `<button type="button" class="weekday-btn ${selectedDays.includes(i) ? "weekday-btn-active" : ""}" data-day="${i}">${t(key)}</button>`
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
