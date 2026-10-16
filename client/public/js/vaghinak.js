// Vaghinak (Վաղինակ) on the client: the Home tile badge and the BLOCKING question. A mandatory question covers the
// whole app until it is answered (no close button, no Escape, no backdrop tap): that is the point of "mandatory".
// Polled every minute and whenever the app comes back to the foreground; a push notification opens the app anyway.
import { api } from "./api.js";
import { state } from "./state.js";
import { t } from "./i18n.js";
import { escapeHtml, showToast } from "./util.js";

let badgeCount = 0;

export function applyVaghinakBadge() {
  const el = document.getElementById("qa-vaghinak-badge");
  if (!el) return;
  el.textContent = badgeCount > 99 ? "99+" : String(badgeCount);
  el.hidden = badgeCount <= 0;
}

export function setVaghinakBadge(count) {
  badgeCount = Number(count) || 0;
  applyVaghinakBadge();
}

// The answer form (chips + a few words + Send), used by the blocking sheet and inline on his page.
// onDone(count) runs after the answer was saved.
export function answerFormHtml(message, idPrefix) {
  const choices = (message.choices ?? [])
    .map((c) => `<button type="button" class="map-filter-chip vg-choice" data-choice="${escapeHtml(c.key)}" aria-pressed="false">${escapeHtml(c.label)}</button>`)
    .join("");
  return `
    <div class="vg-answer" id="${idPrefix}-answer">
      <div class="vg-choices">${choices}</div>
      <textarea class="vg-text" rows="2" maxlength="500" placeholder="${t("vg_answer_placeholder")}" aria-label="${t("vg_answer_placeholder")}"></textarea>
      <p class="form-error vg-error" hidden></p>
      <button type="button" class="btn btn-primary btn-block vg-send">${t("vg_send")}</button>
    </div>`;
}

export function wireAnswerForm(scope, message, onDone) {
  let choice = null;
  const textEl = scope.querySelector(".vg-text");
  const errorEl = scope.querySelector(".vg-error");
  const sendBtn = scope.querySelector(".vg-send");
  scope.querySelectorAll(".vg-choice").forEach((btn) =>
    btn.addEventListener("click", () => {
      choice = choice === btn.dataset.choice ? null : btn.dataset.choice;
      scope.querySelectorAll(".vg-choice").forEach((b) => {
        const on = b.dataset.choice === choice;
        b.classList.toggle("chip-active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    })
  );
  sendBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    errorEl.hidden = true;
    if (!choice && !text) {
      errorEl.textContent = t("vg_pick_answer");
      errorEl.hidden = false;
      return;
    }
    if (choice === "other" && !text) {
      errorEl.textContent = t("vg_write_few_words");
      errorEl.hidden = false;
      return;
    }
    sendBtn.disabled = true;
    try {
      const { count } = await api.vaghinakAnswer(message.id, { choice, text });
      setVaghinakBadge(count);
      showToast(t("vg_thanks"));
      onDone?.(count);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      sendBtn.disabled = false;
    }
  });
}

function showBlockingQuestion(message) {
  if (document.getElementById("vg-block")) return;
  const overlay = document.createElement("div");
  overlay.id = "vg-block";
  overlay.className = "vg-block";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", t("vg_must_answer"));
  overlay.innerHTML = `
    <div class="vg-block-card">
      <div class="vg-avatar" aria-hidden="true">Վ</div>
      <h2>${t("vg_must_answer")}</h2>
      <p class="vg-block-body">${escapeHtml(message.body)}</p>
      ${answerFormHtml(message, "vg-block")}
      <p class="muted vg-block-hint">${t("vg_block_hint")}</p>
    </div>`;
  document.body.appendChild(overlay);
  // keep focus inside: Escape and outside taps do nothing
  overlay.addEventListener("keydown", (e) => e.key === "Escape" && e.preventDefault());
  wireAnswerForm(overlay, message, () => overlay.remove());
  overlay.querySelector(".vg-choice, .vg-text")?.focus();
}

export async function refreshVaghinak() {
  if (!state.user) return;
  try {
    const [{ count }, pending] = await Promise.all([api.vaghinakBadge(), api.vaghinakPending()]);
    setVaghinakBadge(count);
    if (pending) showBlockingQuestion(pending);
  } catch {
    /* offline or logged out: nothing to show */
  }
}

let watching = false;
export function startVaghinakWatch() {
  refreshVaghinak();
  if (watching) return;
  watching = true;
  setInterval(() => document.visibilityState !== "hidden" && refreshVaghinak(), 60000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshVaghinak());
  window.addEventListener("vaghinak-changed", refreshVaghinak);
}
