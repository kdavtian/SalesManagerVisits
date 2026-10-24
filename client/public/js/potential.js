// Potential Customer classification (owner, 2026-10-24): level 1-4 + reasons, the counterfeit-products restriction, history.
// One form (levels, reasons, "Other" text, counterfeit warning) is shared by the editor sheet and the New customer form.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { t } from "./i18n.js";
import { state } from "./state.js";
import { activateDialog, escapeHtml, showToast, openInfoPopup, formatDateTime, formatDateDMY, labelColon } from "./util.js";

export const POTENTIAL_LEVELS = [1, 2, 3, 4];
// A new classification starts on "Real potential": most prospects are, so the common case needs one tap less (owner, 2026-10-24).
export const DEFAULT_POTENTIAL_LEVEL = 3;
const NEGATIVE = ["counterfeit", "own_import", "competitor_loyal", "price_mismatch", "small_volume", "not_interested", "no_decision_maker", "payment_issue", "no_demand_now"];
const POSITIVE = ["high_potential", "active_interest", "negotiating", "ready_first_order"];
const MANAGEMENT = ["admin", "ceo", "operations_director", "sales_director"];

// Mirrors canManagePotentialAll / the assigned-rep rule in the server's customers.js -- UI gate only.
export function canManagePotential(customer) {
  const role = state.user?.role;
  if (MANAGEMENT.includes(role)) return true;
  return role === "sales_manager" && customer.assigned_manager_id === state.user.id;
}
export const canResolveCounterfeit = () => MANAGEMENT.includes(state.user?.role);

// Reasons of the level just picked: the ones that usually explain a low level first for levels 1-2, the positive ones first for 3-4.
const reasonOrder = (level) => (level && level <= 2 ? [...NEGATIVE, ...POSITIVE, "other"] : [...POSITIVE, ...NEGATIVE, "other"]);

export function potentialChipHtml(level) {
  const l = Number(level) || 0;
  return `<span class="pl-chip pl-${l}"><i class="pl-dot"></i>${escapeHtml(t(`pl_level_${l}`))}</span>`;
}

// The customer card header, for a customer of the Potential tier: how likely the sale is (owner, 2026-10-24), instead of the plain tier name.
export function potentialBadgeHtml(level) {
  const l = Number(level) || 0;
  return POTENTIAL_LEVELS.includes(l) ? `<span class="badge tier-badge pl-badge pl-${l}">${escapeHtml(t(`pl_badge_${l}`))}</span>` : "";
}

export function reasonsText(c) {
  return (c.potential_reasons ?? [])
    .map((r) => (r === "other" && c.potential_reason_other ? `${t("pl_reason_other")}${labelColon()}${c.potential_reason_other}` : t(`pl_reason_${r}`)))
    .join(", ");
}

// The reasons last used for each level, per signed-in user and device (owner idea, 2026-10-24): picking a level pre-ticks them, so the usual
// case is "level, Save". "Other" (needs a typed explanation) and "counterfeit" (starts a restriction) are never remembered.
const memoryKey = () => `fieldvisits_potential_reasons:${state.user?.id ?? 0}`;
const REMEMBERABLE = (r) => r !== "other" && r !== "counterfeit";
function readReasonMemory() {
  try {
    return JSON.parse(localStorage.getItem(memoryKey())) ?? {};
  } catch {
    return {};
  }
}
function rememberedReasons(level) {
  const list = readReasonMemory()[level];
  return Array.isArray(list) ? list.filter((r) => typeof r === "string" && REMEMBERABLE(r) && reasonOrder(level).includes(r)) : [];
}
function rememberReasons(level, reasons) {
  try {
    const memory = readReasonMemory();
    memory[level] = reasons.filter(REMEMBERABLE);
    localStorage.setItem(memoryKey(), JSON.stringify(memory));
  } catch {
    // private mode: nothing remembered
  }
}

// ---- the form (levels -> reasons) ---------------------------------------------------------------------------------------------------
export function potentialFormHtml(initial = {}) {
  const level = initial.level ?? DEFAULT_POTENTIAL_LEVEL;
  return `
    <div class="pl-form">
      <div class="pl-section-title">${escapeHtml(t("pl_level_label"))} <span role="button" tabindex="0" class="settings-inline-hint-icon" data-pl-info aria-label="${escapeHtml(t("more_info"))}">!</span></div>
      <div class="pl-levels" role="radiogroup" aria-label="${escapeHtml(t("pl_level_label"))}">
        ${POTENTIAL_LEVELS.map((l) => `<button type="button" class="pl-level-chip pl-${l} ${level === l ? "pl-level-active" : ""}" role="radio" aria-checked="${level === l}" aria-label="${escapeHtml(t(`pl_level_${l}`))}" data-level="${l}"><i class="pl-dot"></i><span>${escapeHtml(t(`pl_level_short_${l}`))}</span></button>`).join("")}
      </div>
      <div class="pl-reasons-wrap">
        <div class="pl-section-title">${escapeHtml(t("pl_reason"))}</div>
        <p class="pl-prefill-note muted" hidden>${escapeHtml(t("pl_prefilled"))}</p>
        <div class="pl-reasons pl-reasons-list" role="group" aria-label="${escapeHtml(t("pl_reason"))}"></div>
        <input class="pl-other" maxlength="300" placeholder="${escapeHtml(t("pl_reason_other_ph"))}" value="${escapeHtml(initial.other ?? "")}" hidden />
        <p class="pl-warn-banner" role="alert" hidden>${escapeHtml(t("pl_counterfeit_warning"))}</p>
      </div>
    </div>`;
}

// Wires a potentialFormHtml() block; returns { value(), validate() -> error text or "" }.
export function wirePotentialForm(root, initial = {}) {
  let level = initial.level ?? DEFAULT_POTENTIAL_LEVEL;
  let reasons = new Set(initial.reasons ?? []);
  // Reasons per level while the form is open: what the customer already has for its own level, then what was ticked on each level this session.
  const byLevel = new Map();
  if (reasons.size) byLevel.set(level, [...reasons]);
  const prefillNote = root.querySelector(".pl-prefill-note");
  let prefilled = false;
  const loadLevel = () => {
    const mine = byLevel.get(level);
    const remembered = mine ? [] : rememberedReasons(level);
    reasons = new Set(mine ?? remembered);
    prefilled = !mine && remembered.length > 0;
  };
  if (!reasons.size) loadLevel();
  const reasonsEl = root.querySelector(".pl-reasons");
  const otherEl = root.querySelector(".pl-other");
  const warnEl = root.querySelector(".pl-warn-banner");
  let showAll = false;
  // The four reasons that usually fit the level + "Other" are shown; the rest sit behind "More reasons" (a reason already picked is never hidden).
  const paintReasons = () => {
    const order = reasonOrder(level);
    const common = new Set([...order.filter((r) => r !== "other").slice(0, 4), "other"]);
    const visible = showAll ? order : order.filter((r) => common.has(r) || reasons.has(r));
    // A tidy checklist (one reason per line, a check box on the left) instead of a wall of chips of every width (owner, 2026-10-24).
    const row = (r) => `<button type="button" class="pl-reason-chip pl-reason-row ${reasons.has(r) ? "pl-reason-on" : ""}" data-reason="${r}" aria-pressed="${reasons.has(r)}"><span class="pl-reason-box" aria-hidden="true"></span><span class="pl-reason-text">${escapeHtml(t(`pl_reason_${r}`))}</span></button>`;
    reasonsEl.innerHTML = visible.map(row).join("") + (visible.length < order.length ? `<button type="button" class="pl-reason-chip pl-reason-row pl-reason-more" data-more><span class="pl-reason-text">${escapeHtml(t("pl_more_reasons"))}</span><span class="pl-reason-chev" aria-hidden="true"></span></button>` : "");
    otherEl.hidden = !reasons.has("other");
    warnEl.hidden = !reasons.has("counterfeit");
    prefillNote.hidden = !prefilled;
  };
  paintReasons();
  root.querySelector("[data-pl-info]")?.addEventListener("click", () => openInfoPopup(t("pl_levels_info")));
  root.querySelector(".pl-levels").addEventListener("click", (e) => {
    const b = e.target.closest("[data-level]");
    if (!b) return;
    if (Number(b.dataset.level) !== level) {
      byLevel.set(level, [...reasons]);
      level = Number(b.dataset.level);
      showAll = false;
      loadLevel();
    }
    root.querySelectorAll(".pl-level-chip").forEach((x) => {
      x.classList.toggle("pl-level-active", x === b);
      x.setAttribute("aria-checked", String(x === b));
    });
    paintReasons();
  });
  reasonsEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) {
      showAll = true;
      paintReasons();
      return;
    }
    const b = e.target.closest("[data-reason]");
    if (!b) return;
    const r = b.dataset.reason;
    if (reasons.has(r)) reasons.delete(r);
    else reasons.add(r);
    prefilled = false;
    prefillNote.hidden = true;
    b.classList.toggle("pl-reason-on", reasons.has(r));
    b.setAttribute("aria-pressed", String(reasons.has(r)));
    otherEl.hidden = !reasons.has("other");
    warnEl.hidden = !reasons.has("counterfeit");
    if (r === "other" && reasons.has("other")) otherEl.focus();
  });
  return {
    value: () => ({ level, reasons: [...reasons], reason_other: reasons.has("other") ? otherEl.value.trim() : "" }),
    validate: () => {
      if (!reasons.size) return t("pl_choose_reason");
      if (reasons.has("other") && !otherEl.value.trim()) return t("pl_explain_other");
      rememberReasons(level, [...reasons]); // valid and about to be saved
      return "";
    },
  };
}

// ---- the editor sheet: Level -> Reason -> Save ---------------------------------------------------------------------------------------
export function openPotentialSheet(customer, onSaved) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet pl-sheet">
      <h2>${escapeHtml(t("pl_title"))}</h2>
      <form id="pl-form">
        ${potentialFormHtml({ level: customer.potential_level, reasons: customer.potential_reasons, other: customer.potential_reason_other })}
        <details class="pl-more">
          <summary>${escapeHtml(t("pl_more"))}</summary>
          <label>${escapeHtml(t("pl_note"))}<input name="note" maxlength="500" /></label>
          <label>${escapeHtml(t("pl_followup"))}<input name="next_followup_date" type="date" value="${escapeHtml(String(customer.next_followup_date ?? "").slice(0, 10))}" /></label>
          <label>${escapeHtml(t("pl_volume"))}<input name="expected_volume_l" inputmode="decimal" value="${customer.expected_volume_l ?? ""}" /></label>
        </details>
        <p class="form-error" id="pl-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pl-cancel">${escapeHtml(t("cancel"))}</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(t("pl_save"))}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector("#pl-cancel").addEventListener("click", () => overlay.remove());
  const form = overlay.querySelector("#pl-form");
  const picker = wirePotentialForm(form, { level: customer.potential_level, reasons: customer.potential_reasons, other: customer.potential_reason_other });
  const errorEl = overlay.querySelector("#pl-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = picker.validate();
    errorEl.hidden = !problem;
    errorEl.textContent = problem;
    if (problem) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const f = new FormData(form);
    try {
      await api.setCustomerPotential(customer.id, {
        ...picker.value(),
        note: f.get("note") || null,
        next_followup_date: f.get("next_followup_date") || null,
        expected_volume_l: f.get("expected_volume_l") === "" ? null : Number(f.get("expected_volume_l")),
      });
      overlay.remove();
      showToast(t("pl_saved"));
      onSaved?.();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}

export async function openPotentialHistory(customerId) {
  const overlay = openInfoPopup(`<h2>${escapeHtml(t("pl_history"))}</h2><p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`);
  const body = overlay.querySelector(".info-popup-body");
  try {
    const rows = await api.getPotentialHistory(customerId);
    body.innerHTML = `<h2>${escapeHtml(t("pl_history"))}</h2>${
      rows.length
        ? rows
            .map((h) => {
              const head =
                h.kind === "counterfeit_set" ? t("pl_history_flag_set") : h.kind === "counterfeit_resolved" ? t("pl_history_flag_resolved") : `${h.old_level ? t(`pl_level_${h.old_level}`) : t("pl_level_0")} → ${t(`pl_level_${h.new_level}`)}`;
              const why = (h.reasons ?? []).map((r) => (r === "other" && h.reason_other ? `${t("pl_reason_other")}${labelColon()}${h.reason_other}` : t(`pl_reason_${r}`))).join(", ");
              return `<div class="pl-hist"><div class="pl-hist-date">${escapeHtml(formatDateTime(h.changed_at))}${h.changed_by_name ? ` · ${escapeHtml(h.changed_by_name)}` : ""}</div><strong>${escapeHtml(head)}</strong>${why ? `<div class="muted">${escapeHtml(t("pl_reason_line"))}${labelColon()}${escapeHtml(why)}</div>` : ""}${h.note ? `<div class="muted">${escapeHtml(h.note)}</div>` : ""}</div>`;
            })
            .join("")
        : `<p class="muted">${escapeHtml(t("pl_history_empty"))}</p>`
    }`;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

// ---- the card on the customer page ------------------------------------------------------------------------------------------------------
export function renderPotentialCard(slot, customer, { reload } = {}) {
  const isPotential = customer.customer_tier === "potential";
  const flagged = Boolean(customer.counterfeit_flag);
  if (!slot || (!isPotential && !flagged)) {
    if (slot) slot.innerHTML = "";
    return;
  }
  const canEdit = canManagePotential(customer);
  const lines = [];
  if (customer.potential_reasons?.length) lines.push(`${escapeHtml(t("pl_reason_line"))}${labelColon()}${escapeHtml(reasonsText(customer))}`);
  if (customer.next_followup_date) lines.push(`${escapeHtml(t("pl_followup"))}${labelColon()}${escapeHtml(formatDateDMY(String(customer.next_followup_date).slice(0, 10)))}`);
  if (customer.expected_volume_l) lines.push(`${escapeHtml(t("pl_volume"))}${labelColon()}${escapeHtml(Number(customer.expected_volume_l).toLocaleString("en-US"))}`);
  slot.innerHTML = `
    <div class="card pl-card">
      ${
        isPotential
          ? `<div class="pl-card-head"><span class="progress-label">${escapeHtml(t("pl_title"))}</span>${potentialChipHtml(customer.potential_level)}
              ${canEdit ? `<button type="button" class="icon-btn pl-edit-btn" data-pl-edit aria-label="${escapeHtml(t("pl_change"))}" title="${escapeHtml(t("pl_change"))}">${icons.pencil}</button>` : ""}</div>
            ${lines.map((l) => `<div class="pl-line">${l}</div>`).join("")}
            <button type="button" class="pl-link" data-pl-history>${escapeHtml(t("pl_history"))}</button>`
          : ""
      }
      ${
        flagged
          ? `<p class="pl-warn-banner" role="alert">${escapeHtml(t("pl_counterfeit_warning"))}</p>
             ${canResolveCounterfeit() ? `<button type="button" class="btn btn-block" data-pl-resolve>${escapeHtml(t("pl_counterfeit_resolve"))}</button>` : ""}`
          : customer.counterfeit_resolved_at
            ? `<p class="muted pl-resolved">${escapeHtml(t("pl_counterfeit_resolved_on").replace("{date}", formatDateTime(customer.counterfeit_resolved_at)))}</p>`
            : ""
      }
    </div>`;
  slot.querySelector("[data-pl-edit]")?.addEventListener("click", () => openPotentialSheet(customer, reload));
  slot.querySelector("[data-pl-history]")?.addEventListener("click", () => openPotentialHistory(customer.id));
  slot.querySelector("[data-pl-resolve]")?.addEventListener("click", () => openResolveSheet(customer, reload));
}

function openResolveSheet(customer, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(t("pl_counterfeit_resolve"))}</h2>
      <p class="muted">${escapeHtml(customer.name)}</p>
      <form id="pl-resolve-form">
        <label>${escapeHtml(t("pl_counterfeit_comment"))}<input name="comment" maxlength="500" /></label>
        <p class="form-error" id="pl-resolve-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pl-resolve-cancel">${escapeHtml(t("cancel"))}</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(t("pl_counterfeit_resolve"))}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector("#pl-resolve-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#pl-resolve-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.resolveCounterfeit(customer.id, { comment: new FormData(e.target).get("comment") || null });
      overlay.remove();
      showToast(t("pl_saved"));
      onDone?.();
    } catch (err) {
      const el = overlay.querySelector("#pl-resolve-error");
      el.textContent = err.message;
      el.hidden = false;
      btn.disabled = false;
    }
  });
}
