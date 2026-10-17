// Call tasks (owner, 2026-10-18): the rep opens a Call task, taps the green Call button (the phone dials the customer),
// and when back in the app records how the call went. A "pending call" is remembered across the app being sent to the
// background (or even killed by the phone while the call runs): the result sheet opens when the app is shown again.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { COLLECTION_OUTCOMES } from "./collectionOutcomeSheet.js";
import { activateDialog, escapeHtml, formatPhoneDisplay, formatDateDMY, showToast, formatRelative } from "./util.js";

const PENDING_KEY = "fv_pending_call";
const PENDING_MAX_AGE_MS = 6 * 3600 * 1000;
const RESULTS = ["spoke", "no_answer", "call_back", "wrong_number"];
const DEBT_OUTCOMES = COLLECTION_OUTCOMES.filter((o) => o !== "no_answer");

export const isCallTask = (task) => task?.task_kind === "call_customer";
const isDebtTask = (task) => task?.auto_kind === "debt_collection" || task?.task_kind === "collect_debt";

export function rememberCall(task) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ taskId: task.id, at: Date.now() }));
  } catch {
    /* private mode: the "Record the result" button still works */
  }
}
const forgetCall = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
};

// The green Call button of a call task (a real tel: link: one tap dials). Without a number: a disabled button + a hint.
export function callButtonHtml(task) {
  if (!task.customer_phone) {
    return `<button type="button" class="btn btn-call" disabled>${icons.phone}<span>${escapeHtml(t("call_btn"))}</span></button><p class="muted task-hint">${escapeHtml(t("call_no_phone"))}</p>`;
  }
  return `<a class="btn btn-call" data-action="call" href="tel:${escapeHtml(task.customer_phone)}">${icons.phone}<span>${escapeHtml(t("call_btn"))} · ${escapeHtml(formatPhoneDisplay(task.customer_phone))}</span></a>`;
}

export function callHistoryHtml(calls) {
  if (!calls?.length) return "";
  return `<h3 class="list-group-heading">${escapeHtml(t("call_history"))}</h3>
    <div class="call-history">${calls
      .map(
        (c) => `<div class="call-history-row"><span class="badge ${c.result === "spoke" ? "badge-success" : "badge-neutral"}">${escapeHtml(t(`call_res_${c.result}`))}</span>
          <span class="muted">${escapeHtml(formatRelative(c.created_at))}${c.user_name ? ` · ${escapeHtml(c.user_name)}` : ""}${c.callback_date ? ` · ${escapeHtml(formatDateDMY(c.callback_date))}` : ""}${c.note ? ` · ${escapeHtml(c.note)}` : ""}</span></div>`
      )
      .join("")}</div>`;
}

let resultOpen = false;

// The result sheet. onSaved(updatedTask) after a successful save. Cancelling just closes it.
export function openCallResultSheet(task, { onSaved } = {}) {
  if (resultOpen) return;
  resultOpen = true;
  forgetCall();
  let result = null;
  let outcome = null;
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 4 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);
  const maxPromise = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay call-result-overlay";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${escapeHtml(t("close"))}">${icons.close}</button>
      <h2>${escapeHtml(t("call_result_title"))}</h2>
      ${task.customer_name ? `<p class="muted">${escapeHtml(task.customer_name)}</p>` : ""}
      <div class="call-results" role="group">
        ${RESULTS.map((r) => `<button type="button" class="btn call-result-btn" data-result="${r}" aria-pressed="false">${escapeHtml(t(`call_res_${r}`))}</button>`).join("")}
      </div>
      <div id="call-debt" hidden>
        <span class="task-label">${escapeHtml(t("collect_outcome_title"))}</span>
        <div class="call-results">${DEBT_OUTCOMES.map((o) => `<button type="button" class="btn call-result-btn" data-outcome="${o}" aria-pressed="false">${escapeHtml(t(`collect_outcome_${o}`))}</button>`).join("")}</div>
        <label id="call-promise-wrap" class="call-field" hidden>${escapeHtml(t("collect_promise_date"))}<input type="date" id="call-promise" min="${tomorrow}" max="${maxPromise}" value="${tomorrow}" /></label>
      </div>
      <label id="call-back-wrap" class="call-field" hidden>${escapeHtml(t("call_back_date"))}<input type="date" id="call-back" min="${today}" value="${tomorrow}" /></label>
      <label class="call-field">${escapeHtml(t("task_complete_note_prompt"))}<input type="text" id="call-note" maxlength="300" /></label>
      <p class="form-error" id="call-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>${escapeHtml(t("cancel"))}</button>
        <button type="button" class="btn btn-primary" id="call-save">${escapeHtml(t("save"))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => {
    overlay.remove();
    resultOpen = false;
  };
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  const errorEl = overlay.querySelector("#call-error");
  const fail = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  };
  const press = (selector, key, value) =>
    overlay.querySelectorAll(selector).forEach((b) => {
      const on = b.dataset[key] === value;
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("btn-primary", on);
    });
  const paint = () => {
    overlay.querySelector("#call-debt").hidden = !(result === "spoke" && isDebtTask(task));
    overlay.querySelector("#call-promise-wrap").hidden = outcome !== "promised";
    overlay.querySelector("#call-back-wrap").hidden = result !== "call_back";
    errorEl.hidden = true;
  };
  overlay.querySelectorAll("[data-result]").forEach((b) =>
    b.addEventListener("click", () => {
      result = b.dataset.result;
      press("[data-result]", "result", result);
      paint();
    })
  );
  overlay.querySelectorAll("[data-outcome]").forEach((b) =>
    b.addEventListener("click", () => {
      outcome = b.dataset.outcome;
      press("[data-outcome]", "outcome", outcome);
      paint();
    })
  );
  overlay.querySelector("#call-save").addEventListener("click", async () => {
    if (!result) return fail(t("call_choose_result"));
    const body = { result, note: overlay.querySelector("#call-note").value.trim() };
    if (result === "call_back") body.callback_date = overlay.querySelector("#call-back").value;
    if (result === "spoke" && isDebtTask(task)) {
      if (!outcome) return fail(t("collect_choose_outcome"));
      body.outcome = outcome;
      if (outcome === "promised") body.promise_date = overlay.querySelector("#call-promise").value;
    }
    const btn = overlay.querySelector("#call-save");
    btn.disabled = true;
    try {
      const updated = await api.taskCallResult(task.id, body);
      close();
      showToast(t(result === "spoke" ? "call_saved_done" : "call_saved"));
      window.dispatchEvent(new Event("tasks-changed"));
      onSaved?.(updated);
    } catch (err) {
      btn.disabled = false;
      fail(err.message);
    }
  });
}

// The app came back to the front after a Call tap: ask how it went (once). The task sheet that was open behind is
// closed first so the list shows the new state.
export async function resumePendingCall() {
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
  } catch {
    pending = null;
  }
  if (!pending?.taskId || resultOpen) return;
  if (Date.now() - pending.at > PENDING_MAX_AGE_MS) return forgetCall();
  if (Date.now() - pending.at < 2500) return; // the dialer has not even opened yet
  let task;
  try {
    task = await api.getTask(pending.taskId);
  } catch {
    return forgetCall();
  }
  if (task.status !== "open") return forgetCall();
  document.querySelectorAll(".sheet-overlay:not(.call-result-overlay)").forEach((o) => o.querySelector("#task-sheet-actions") && o.remove());
  openCallResultSheet(task);
}
