// Route plan SETS: several whole route plans that can be generated automatically ("Auto route plan"), rearranged,
// saved as new plans and switched; one is active (server/src/field/routePlanSets.js). Three entry points:
//   openAutoPlanSheet()          - frequency + working days -> creates a plan and opens it
//   renderPlanSetsCard()         - the "Route plans" list on the Route Plans page
//   renderRoutePlanSet()         - the editor (#/route-plan-sets/:id): week per rep, move customers between days, activate
import { api } from "../api.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { escapeHtml, activateDialog, openInfoPopup, formatDateDMY, planTitle } from "../util.js";
import { canPlanForOthers } from "../state.js";
import { routePlansPage } from "./routePlans.js";

const WEEKDAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DEFAULT_DAYS = { 1: "full", 2: "full", 3: "full", 4: "full", 5: "full", 6: "half", 0: "off" };
const FREQUENCIES = [7, 14, 21, 28];

const dayName = (dow) => t(WEEKDAY_KEYS[dow]);
const kindLabel = (kind) => t(`rps_kind_${kind}`);

function openSheet(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay sheet-overlay-light";
  overlay.innerHTML = `<div class="sheet rps-sheet">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  return { overlay, close };
}

// "Every 7 / 14 / 21 / 28 days" chips + an "other" number field. Returns { html, read() }.
function frequencyPicker(initial) {
  const custom = !FREQUENCIES.includes(initial);
  const html = `
    <div class="rps-chips" id="rps-freq-chips">
      ${FREQUENCIES.map((d) => `<button type="button" class="map-filter-chip ${d === initial ? "chip-active" : ""}" data-freq="${d}">${d}</button>`).join("")}
      <button type="button" class="map-filter-chip ${custom ? "chip-active" : ""}" data-freq="other">${t("rps_freq_other")}</button>
      <input type="number" id="rps-freq-other" min="1" max="365" inputmode="numeric" value="${custom ? initial : ""}" ${custom ? "" : "hidden"} aria-label="${t("rps_freq_other")}" />
      <span class="muted">${t("rps_days_unit")}</span>
    </div>`;
  return {
    html,
    bind(root) {
      const chips = root.querySelector("#rps-freq-chips");
      const other = root.querySelector("#rps-freq-other");
      chips.querySelectorAll("[data-freq]").forEach((b) =>
        b.addEventListener("click", () => {
          chips.querySelectorAll("[data-freq]").forEach((x) => x.classList.toggle("chip-active", x === b));
          other.hidden = b.dataset.freq !== "other";
          if (!other.hidden) other.focus();
        })
      );
      return () => {
        const active = chips.querySelector(".chip-active")?.dataset.freq;
        const n = Number(active === "other" ? other.value : active);
        return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
      };
    },
  };
}

// ---- Auto route plan -----------------------------------------------------------------------------------------------
export function openAutoPlanSheet(navigate) {
  const days = { ...DEFAULT_DAYS };
  const freq = frequencyPicker(7);
  const { overlay, close } = openSheet(`
    <div class="rps-sheet-head"><h2>${t("rps_auto_title")}</h2><button type="button" class="settings-hint-icon" id="rps-auto-info" aria-label="${t("more_info")}">!</button></div>
    <p class="rps-label">${t("rps_auto_freq")}</p>
    ${freq.html}
    <p class="muted rps-note">${t("rps_freq_all_note")}</p>
    <p class="rps-label">${t("rps_working_days")}</p>
    <div class="rps-days" id="rps-days">
      ${WEEK_ORDER.map(
        (dow) => `<div class="rps-day-row" data-dow="${dow}"><span class="rps-day-name">${dayName(dow)}</span>
          <div class="rps-seg">${["full", "half", "off"].map((k) => `<button type="button" data-kind="${k}" class="${days[dow] === k ? "seg-active" : ""}">${t(`rps_day_${k}`)}</button>`).join("")}</div></div>`
      ).join("")}
    </div>
    <label class="rps-label" for="rps-name">${t("rps_plan_name")}</label>
    <input type="text" id="rps-name" maxlength="80" placeholder="${t("rps_plan_name_ph")}" />
    <p class="form-error" id="rps-auto-error" hidden></p>
    <div class="sheet-actions">
      <button type="button" class="btn" id="rps-auto-cancel">${t("cancel")}</button>
      <button type="button" class="btn btn-primary" id="rps-auto-create">${t("rps_create")}</button>
    </div>`);
  const readFreq = freq.bind(overlay);
  overlay.querySelector("#rps-auto-info").addEventListener("click", () => openInfoPopup(`<p>${t("rps_info_auto_1")}</p><p>${t("rps_info_auto_2")}</p><p>${t("rps_info_auto_3")}</p>`));
  overlay.querySelectorAll(".rps-day-row").forEach((row) =>
    row.querySelectorAll("[data-kind]").forEach((b) =>
      b.addEventListener("click", () => {
        days[row.dataset.dow] = b.dataset.kind;
        row.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("seg-active", x === b));
      })
    )
  );
  overlay.querySelector("#rps-auto-cancel").addEventListener("click", close);
  const errorEl = overlay.querySelector("#rps-auto-error");
  const createBtn = overlay.querySelector("#rps-auto-create");
  createBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    const frequency = readFreq();
    if (!frequency) {
      errorEl.textContent = t("rps_freq_invalid");
      errorEl.hidden = false;
      return;
    }
    if (!Object.values(days).some((k) => k !== "off")) {
      errorEl.textContent = t("rps_days_required");
      errorEl.hidden = false;
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = t("rps_creating");
    try {
      const plan = await api.autoRoutePlanSet({ frequency_days: frequency, days, name: overlay.querySelector("#rps-name").value.trim() || `${t("rps_auto_short")} · ${frequency} ${t("rps_days_unit")} · ${formatDateDMY(new Date().toISOString().slice(0, 10))}` });
      close();
      routePlansPage.refresh?.();
      navigate(`#/route-plan-sets/${plan.id}`);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      createBtn.disabled = false;
      createBtn.textContent = t("rps_create");
    }
  });
}

// ---- The list on the Route Plans page ----------------------------------------------------------------------------------
const metaLine = (s) => {
  const f = s.frequencies?.length === 1 ? t("rps_every_days").replace("{n}", String(s.frequencies[0])) : s.frequencies?.length > 1 ? t("rps_mixed_freq") : "";
  return [kindLabel(s.kind), f, t("rps_customers_n").replace("{n}", String(s.customer_count)), formatDateDMY(String(s.updated_at).slice(0, 10))].filter(Boolean).join(" · ");
};

export async function renderPlanSetsCard(el, navigate) {
  const canManage = canPlanForOthers();
  let sets;
  try {
    sets = await api.listRoutePlanSets();
  } catch {
    el.innerHTML = "";
    return;
  }
  if (!sets.length && !canManage) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="card rps-card">
      <div class="rps-card-head"><h3 class="health-title">${t("rps_title")}</h3>
        ${canManage ? `<button type="button" class="rps-link" id="rps-snapshot">${t("rps_snapshot_btn")}</button>` : ""}</div>
      ${
        sets.length
          ? sets
              .map(
                (s) => `<button type="button" class="rps-row" data-id="${s.id}">
                  <span class="rps-row-main"><strong>${escapeHtml(s.name)}</strong><span class="muted">${escapeHtml(metaLine(s))}</span></span>
                  ${s.is_active ? `<span class="rps-badge">${t("rps_active")}</span>` : ""}
                </button>`
              )
              .join("")
          : `<p class="muted">${t("rps_no_sets")}</p>`
      }
    </div>`;
  el.querySelectorAll(".rps-row").forEach((b) => b.addEventListener("click", () => navigate(`#/route-plan-sets/${b.dataset.id}`)));
  el.querySelector("#rps-snapshot")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const snap = await api.snapshotRoutePlanSet(`${t("rps_current_plan")} ${new Date().toISOString().slice(0, 10)}`);
      routePlansPage.refresh?.();
      navigate(`#/route-plan-sets/${snap.id}`);
    } catch (err) {
      alert(err.message);
      e.currentTarget.disabled = false;
    }
  });
}

// ---- Editor -------------------------------------------------------------------------------------------------------
export async function renderRoutePlanSet(root, navigate, id) {
  const canManage = canPlanForOthers();
  root.innerHTML = `
    <div class="detail-view rps-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1 id="rps-title">${t("rps_title")}</h1></div>
      </div>
      <p class="form-error" id="rps-error" hidden></p>
      <div id="rps-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  // Back restores the Route Plans screen as it was left, so tell it to refresh whenever something changed here.
  const changed = () => routePlansPage.refresh?.();
  $("#back-btn").addEventListener("click", () => navigate.goBack("#/route-plans"));
  const errorEl = $("#rps-error");
  const showError = (err) => {
    errorEl.textContent = err.message || String(err);
    errorEl.hidden = false;
  };
  let set = null;
  const openDay = new Map(); // user id -> weekday whose list is open

  async function load() {
    try {
      set = await api.getRoutePlanSet(id);
      paint();
    } catch (err) {
      $("#rps-body").innerHTML = "";
      showError(err);
    }
  }

  const repDays = (rep) => Object.fromEntries(rep.days.map((d) => [d.day_of_week, d.customers.map((c) => c.id)]));
  async function saveRep(rep, days) {
    errorEl.hidden = true;
    try {
      set = await api.setRoutePlanSetRep(set.id, rep.user_id, days, rep.scope ?? "");
      changed();
      paint();
    } catch (err) {
      showError(err);
    }
  }

  function summary() {
    const customers = set.reps.reduce((n, r) => n + r.days.reduce((m, d) => m + d.customers.length, 0), 0);
    const km = set.reps.reduce((n, r) => n + r.days.reduce((m, d) => m + d.km, 0), 0);
    const unplanned = set.reps.reduce((n, r) => n + r.unplanned.length, 0);
    return { customers, km: Math.round(km), unplanned };
  }
  const freqText = () => {
    const f = set.params?.frequency_days;
    return f ? t("rps_every_days").replace("{n}", String(f)) : t("rps_mixed_freq");
  };

  function repHtml(rep) {
    const open = openDay.get(rep.key);
    const planned = rep.days.reduce((n, d) => n + d.customers.length, 0);
    const day = open !== undefined ? rep.days.find((d) => d.day_of_week === open) : null;
    return `<div class="card rps-rep" data-key="${escapeHtml(rep.key)}">
      <div class="rps-rep-head"><strong>${escapeHtml(planTitle(rep.user_name, rep.scope))}</strong><span class="muted">${t("rps_customers_n").replace("{n}", String(planned))}</span></div>
      <div class="route-plan-week-row">
        ${rep.days
          .map(
            (d) => `<button type="button" class="route-plan-day-chip ${open === d.day_of_week ? "route-plan-day-chip-active" : ""}" data-day="${d.day_of_week}">
              <span class="route-plan-day-label">${dayName(d.day_of_week)}</span><span class="route-plan-day-count">${d.customers.length}</span></button>`
          )
          .join("")}
      </div>
      ${rep.unplanned.length ? `<button type="button" class="rps-unplanned" data-unplanned>${t("rps_unplanned_n").replace("{n}", String(rep.unplanned.length))} ›</button>` : ""}
      ${
        day
          ? `<div class="rps-daylist">
              <div class="rps-daylist-head"><strong>${dayName(day.day_of_week)}</strong><span class="muted">${t("rps_customers_n").replace("{n}", String(day.customers.length))}${day.km ? ` · ${t("rps_km").replace("{n}", String(day.km))}` : ""}</span>
                ${canManage && day.customers.length ? `<button type="button" class="rps-link" data-swap>${t("rps_swap_day")}</button>` : ""}</div>
              ${day.customers.length ? day.customers
                .map(
                  (c, i) => `<button type="button" class="rps-cust" data-cid="${c.id}" ${canManage ? "" : "disabled"}><span class="rps-cust-n">${i + 1}</span><span class="rps-cust-main"><strong>${escapeHtml(c.name)}</strong><span class="muted">${escapeHtml([c.region, c.subregion].filter(Boolean).join(" · "))}</span></span>${canManage ? `<span class="rps-chev" aria-hidden="true">›</span>` : ""}</button>`
                )
                .join("") : `<p class="muted">${t("rps_day_empty")}</p>`}
            </div>`
          : ""
      }
    </div>`;
  }

  function paint() {
    $("#rps-title").textContent = set.name;
    const sum = summary();
    $("#rps-body").innerHTML = `
      <div class="card rps-head">
        <div class="rps-head-top">
          ${set.is_active ? `<span class="rps-badge">${t("rps_active")}</span>` : `<span class="rps-badge rps-badge-off">${t("rps_not_active")}</span>`}
          <span class="muted">${kindLabel(set.kind)}</span>
          <button type="button" class="settings-hint-icon" id="rps-info" aria-label="${t("more_info")}">!</button>
        </div>
        <div class="rps-head-stats">
          <span><strong>${sum.customers}</strong><span class="muted">${t("rps_customers_label")}</span></span>
          <span><strong>${new Set(set.reps.map((r) => r.user_id)).size}</strong><span class="muted">${t("rps_reps_label")}</span></span>
          <span><strong>≈ ${sum.km}</strong><span class="muted">${t("rps_km_week")}</span></span>
        </div>
        ${sum.unplanned ? `<p class="rps-warn">${t("rps_unplanned_total").replace("{n}", String(sum.unplanned))}</p>` : ""}
        <div class="rps-freq-row"><span>${t("rps_freq_label")}</span>${canManage ? `<button type="button" class="rps-link" id="rps-freq">${escapeHtml(freqText())} ›</button>` : `<strong>${escapeHtml(freqText())}</strong>`}</div>
        ${canManage ? `<div class="rps-actions">
          ${set.is_active ? "" : `<button type="button" class="btn btn-primary btn-block" id="rps-activate">${t("rps_activate")}</button>`}
          <div class="rps-actions-row"><button type="button" class="btn" id="rps-rename">${t("rps_rename")}</button><button type="button" class="btn" id="rps-dup">${t("rps_save_as_new")}</button></div>
          ${set.is_active ? "" : `<button type="button" class="rps-link rps-delete btn-has-icon" id="rps-delete">${icons.trash}${t("delete")}</button>`}
        </div>` : ""}
        <p class="form-success" id="rps-ok" role="status" hidden></p>
      </div>
      ${set.reps.map(repHtml).join("")}`;
    bind();
  }

  function bind() {
    const body = $("#rps-body");
    $("#rps-info").addEventListener("click", () => openInfoPopup(`<p>${t("rps_info_edit_1")}</p><p>${t("rps_info_edit_2")}</p><p>${t("rps_info_edit_3")}</p>`));
    body.querySelectorAll(".rps-rep").forEach((card) => {
      const rep = set.reps.find((r) => r.key === card.dataset.key);
      card.querySelectorAll(".route-plan-day-chip").forEach((b) =>
        b.addEventListener("click", () => {
          const dow = Number(b.dataset.day);
          if (openDay.get(rep.key) === dow) openDay.delete(rep.key);
          else openDay.set(rep.key, dow);
          paint();
        })
      );
      card.querySelector("[data-unplanned]")?.addEventListener("click", () => openUnplannedSheet(rep));
      card.querySelector("[data-swap]")?.addEventListener("click", () => openSwapSheet(rep, openDay.get(rep.key)));
      card.querySelectorAll(".rps-cust").forEach((b) => b.addEventListener("click", () => canManage && openMoveSheet(rep, Number(b.dataset.cid))));
    });
    if (!canManage) return;
    $("#rps-activate")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.activateRoutePlanSet(set.id, `${t("rps_previous_plan")} ${new Date().toISOString().slice(0, 10)}`);
        changed();
        set = await api.getRoutePlanSet(set.id);
        paint();
        const ok = $("#rps-ok");
        ok.textContent = t("rps_activated");
        ok.hidden = false;
      } catch (err) {
        showError(err);
        e.currentTarget.disabled = false;
      }
    });
    $("#rps-rename").addEventListener("click", openRenameSheet);
    $("#rps-dup").addEventListener("click", openDuplicateSheet);
    $("#rps-freq").addEventListener("click", openFrequencySheet);
    $("#rps-delete")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.deleteRoutePlanSet(set.id);
        changed();
        navigate.goBack("#/route-plans");
      } catch (err) {
        showError(err);
        e.currentTarget.disabled = false;
      }
    });
  }

  // Day buttons with how many customers each already has; `current` is marked, `extra` adds "not on any day".
  const dayButtons = (rep, current, { includeNone = false } = {}) =>
    `<div class="rps-day-grid">${rep.days
      .map((d) => `<button type="button" class="rps-day-pick ${d.day_of_week === current ? "is-current" : ""}" data-pick="${d.day_of_week}" ${d.day_of_week === current ? "disabled" : ""}><strong>${dayName(d.day_of_week)}</strong><span class="muted">${d.customers.length}</span></button>`)
      .join("")}</div>${includeNone ? `<button type="button" class="btn btn-block" data-pick="none">${t("rps_not_on_day")}</button>` : ""}`;

  function openMoveSheet(rep, customerId) {
    const day = rep.days.find((d) => d.customers.some((c) => c.id === customerId));
    const cust = day.customers.find((c) => c.id === customerId);
    const { overlay, close } = openSheet(`<h2>${escapeHtml(cust.name)}</h2><p class="muted">${t("rps_move_to")}</p>${dayButtons(rep, day.day_of_week, { includeNone: true })}`);
    overlay.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        close();
        const days = repDays(rep);
        days[day.day_of_week] = days[day.day_of_week].filter((x) => x !== customerId);
        if (b.dataset.pick !== "none") {
          days[b.dataset.pick].push(customerId);
          openDay.set(rep.key, Number(b.dataset.pick));
        }
        saveRep(rep, days);
      })
    );
  }

  function openUnplannedSheet(rep) {
    const { overlay, close } = openSheet(`<h2>${escapeHtml(planTitle(rep.user_name, rep.scope))}</h2><p class="muted">${t("rps_unplanned_title")}</p>
      <div class="rps-unplanned-list">${rep.unplanned.map((c) => `<div class="rps-unplanned-item"><strong>${escapeHtml(c.name)}</strong><span class="muted">${escapeHtml([c.region, c.subregion].filter(Boolean).join(" · "))}</span>${canManage ? `<div class="rps-chips">${rep.days.filter((d) => d.day_of_week !== 0 || d.customers.length).map((d) => `<button type="button" class="map-filter-chip" data-add="${c.id}" data-dow="${d.day_of_week}">${dayName(d.day_of_week)}</button>`).join("")}</div>` : ""}</div>`).join("")}</div>`);
    overlay.querySelectorAll("[data-add]").forEach((b) =>
      b.addEventListener("click", () => {
        close();
        const days = repDays(rep);
        days[b.dataset.dow].push(Number(b.dataset.add));
        openDay.set(rep.key, Number(b.dataset.dow));
        saveRep(rep, days);
      })
    );
  }

  function openSwapSheet(rep, from) {
    const { overlay, close } = openSheet(`<h2>${t("rps_swap_with").replace("{a}", dayName(from))}</h2>${dayButtons(rep, from)}`);
    overlay.querySelectorAll("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        close();
        const days = repDays(rep);
        const to = Number(b.dataset.pick);
        [days[from], days[to]] = [days[to], days[from]];
        openDay.set(rep.key, to);
        saveRep(rep, days);
      })
    );
  }

  function openRenameSheet() {
    const { overlay, close } = openSheet(`<h2>${t("rps_rename")}</h2><input type="text" id="rps-new-name" maxlength="80" value="${escapeHtml(set.name)}" />
      <div class="sheet-actions"><button type="button" class="btn" data-cancel>${t("cancel")}</button><button type="button" class="btn btn-primary" data-save>${t("save")}</button></div>`);
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.querySelector("[data-save]").addEventListener("click", async () => {
      const name = overlay.querySelector("#rps-new-name").value.trim();
      if (!name) return;
      close();
      try {
        set = await api.updateRoutePlanSet(set.id, { name });
        changed();
        paint();
      } catch (err) {
        showError(err);
      }
    });
  }

  function openDuplicateSheet() {
    const { overlay, close } = openSheet(`<h2>${t("rps_save_as_new")}</h2><p class="muted">${t("rps_save_as_new_hint")}</p><input type="text" id="rps-copy-name" maxlength="80" value="${escapeHtml(`${set.name} ${t("rps_copy_suffix")}`)}" />
      <div class="sheet-actions"><button type="button" class="btn" data-cancel>${t("cancel")}</button><button type="button" class="btn btn-primary" data-save>${t("save")}</button></div>`);
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.querySelector("[data-save]").addEventListener("click", async () => {
      const name = overlay.querySelector("#rps-copy-name").value.trim();
      if (!name) return;
      close();
      try {
        const copy = await api.duplicateRoutePlanSet(set.id, name);
        changed();
        navigate(`#/route-plan-sets/${copy.id}`);
      } catch (err) {
        showError(err);
      }
    });
  }

  function openFrequencySheet() {
    const freq = frequencyPicker(set.params?.frequency_days || 7);
    const { overlay, close } = openSheet(`<h2>${t("rps_freq_change_title")}</h2>${freq.html}<p class="muted rps-note">${t("rps_freq_all_note")}</p>
      <p class="form-error" id="rps-freq-error" hidden></p>
      <div class="sheet-actions"><button type="button" class="btn" data-cancel>${t("cancel")}</button><button type="button" class="btn btn-primary" data-save>${t("save")}</button></div>`);
    const read = freq.bind(overlay);
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.querySelector("[data-save]").addEventListener("click", async () => {
      const days = read();
      if (!days) {
        const e = overlay.querySelector("#rps-freq-error");
        e.textContent = t("rps_freq_invalid");
        e.hidden = false;
        return;
      }
      close();
      try {
        set = await api.updateRoutePlanSet(set.id, { frequency_days: days });
        changed();
        paint();
      } catch (err) {
        showError(err);
      }
    });
  }

  await load();
}
