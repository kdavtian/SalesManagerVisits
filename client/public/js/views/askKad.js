// Ask KAD (admin): ask a question about the company's own data in plain Armenian or English and get an answer built from
// the ERP sales, debt, customers, visits and plan. The facts come from fixed read-only queries on the server; the AI only
// picks which to run, adds them up and explains. Customer and staff names are replaced by codes before anything leaves the
// server and put back in the answer (server/src/askKad). The chat lives in memory while the app is open.
import { api } from "../api.js";
import { icons } from "../icons.js";
import { t } from "../i18n.js";
import { escapeHtml, openInfoPopup } from "../util.js";

const SUGGESTIONS = ["ak_s_sales", "ak_s_debt", "ak_s_lapsed", "ak_s_reps", "ak_s_plan"];
const TOOL_KEY = { sales: "ak_tool_sales", debt: "ak_tool_debt", lapsed_customers: "ak_tool_lapsed", visits: "ak_tool_visits", plan_vs_actual: "ak_tool_plan" };

// The thread survives leaving the screen (a tap on a customer name and back), not an app restart.
let thread = []; // { role: "user" | "assistant", text, meta?, error? }

const answerHtml = (text) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

function bubbleHtml(m, i) {
  if (m.role === "user") return `<div class="ak-row ak-row-user"><div class="ak-bubble ak-user">${escapeHtml(m.text)}</div></div>`;
  const info = m.meta
    ? `<button type="button" class="ak-info" data-info="${i}" aria-label="${t("ak_info_label")}">${icons.info}</button>`
    : "";
  return `<div class="ak-row"><div class="ak-bubble ak-assistant${m.error ? " ak-error" : ""}">${answerHtml(m.text)}${info}</div></div>`;
}

export async function renderAskKad(root, navigate) {
  root.innerHTML = `
    <div class="detail-view ak-view">
      <div class="detail-header oc-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title oc-title"><h1>${t("ak_title")}</h1><span class="oc-customer">${t("ak_subtitle")}</span></div>
        <button type="button" class="icon-btn" id="ak-new" aria-label="${t("ak_new")}" hidden>${icons.plus}</button>
        <button type="button" class="icon-btn" id="ak-about" aria-label="${t("ak_info_label")}">${icons.info}</button>
      </div>
      <div id="ak-banner"></div>
      <div class="ak-thread" id="ak-thread" aria-live="polite"></div>
      <form class="ak-composer" id="ak-form">
        <textarea id="ak-input" rows="1" maxlength="2000" placeholder="${t("ak_placeholder")}" aria-label="${t("ak_placeholder")}" enterkeyhint="send"></textarea>
        <button type="submit" class="ak-send" id="ak-send" aria-label="${t("ak_send")}">${icons.chevronUp}</button>
      </form>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => history.back());

  const threadEl = root.querySelector("#ak-thread");
  const input = root.querySelector("#ak-input");
  const sendBtn = root.querySelector("#ak-send");
  const newBtn = root.querySelector("#ak-new");
  const banner = root.querySelector("#ak-banner");
  let status = null;
  let busy = false;

  const blocked = () => status && (!status.configured || !status.enabled || status.spent_usd >= status.cap_usd);

  function paintBanner() {
    if (!status) return;
    const key = !status.configured ? "ak_err_not_configured" : !status.enabled ? "ak_err_disabled" : status.spent_usd >= status.cap_usd ? "ak_err_cap_reached" : "";
    banner.innerHTML = key ? `<p class="ak-banner" role="status">${t(key)}</p>` : "";
    input.disabled = Boolean(key);
    sendBtn.disabled = Boolean(key) || busy;
  }

  function paintThread() {
    newBtn.hidden = !thread.length;
    if (!thread.length) {
      threadEl.innerHTML = `<div class="ak-empty"><p class="ak-empty-title">${t("ak_try")}</p>${SUGGESTIONS.map((k) => `<button type="button" class="ak-suggest" data-q="${k}">${t(k)}</button>`).join("")}</div>`;
      return;
    }
    threadEl.innerHTML = thread.map(bubbleHtml).join("") + (busy ? `<div class="ak-row"><div class="ak-bubble ak-assistant ak-thinking" role="status"><span></span><span></span><span></span><em>${t("ak_thinking")}</em></div></div>` : "");
    // Keep the newest message in view, just above the input bar.
    const last = threadEl.lastElementChild;
    if (last) last.scrollIntoView({ block: "end", behavior: "smooth" });
  }

  async function send(question) {
    const text = question.trim();
    if (!text || busy || blocked()) return;
    const history = thread.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
    thread.push({ role: "user", text });
    input.value = "";
    autoGrow();
    busy = true;
    sendBtn.disabled = true;
    paintThread();
    try {
      const out = await api.askKad(text, history);
      thread.push({ role: "assistant", text: out.answer, meta: { tools: out.tools, masked: out.maskedNames, cost: out.costUsd } });
      if (status) status.spent_usd += out.costUsd;
    } catch (err) {
      const known = ["not_configured", "disabled", "cap_reached", "refused", "too_many_steps", "busy"];
      thread.push({ role: "assistant", text: t(known.includes(err.message) ? `ak_err_${err.message}` : "ak_err_generic"), error: true });
      // The state may have changed (key removed, cap reached): refresh it so the banner says why.
      api.askKadStatus().then((s) => { status = s; paintBanner(); }).catch(() => {});
    } finally {
      busy = false;
      paintBanner();
      paintThread();
    }
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  root.querySelector("#ak-form").addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });
  input.addEventListener("input", autoGrow);
  // A computer: Enter sends, Shift+Enter is a new line. A phone keeps Enter as a new line and the round button sends.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      e.preventDefault();
      send(input.value);
    }
  });
  threadEl.addEventListener("click", (e) => {
    const suggest = e.target.closest("[data-q]");
    if (suggest) return send(t(suggest.dataset.q));
    const info = e.target.closest("[data-info]");
    if (info) {
      const m = thread[Number(info.dataset.info)];
      const tools = (m.meta.tools || []).map((k) => t(TOOL_KEY[k] || k)).join(", ") || "—";
      openInfoPopup(
        `<ul class="ak-meta"><li>${t("ak_meta_data")}${tools}</li><li>${t("ak_meta_masked")}${m.meta.masked}</li><li>${t("ak_meta_cost")}$${m.meta.cost.toFixed(2)}</li></ul>`
      );
    }
  });
  newBtn.addEventListener("click", () => {
    thread = [];
    paintThread();
    input.focus();
  });
  root.querySelector("#ak-about").addEventListener("click", () => {
    const spend = status ? `<li>${t("ak_about_cap")}$${status.spent_usd.toFixed(2)} / $${status.cap_usd.toFixed(0)}</li>` : "";
    openInfoPopup(`<ul class="ak-meta"><li>${t("ak_about_1")}</li><li>${t("ak_about_2")}</li><li>${t("ak_about_3")}</li>${spend}</ul>`);
  });

  paintThread();
  try {
    status = await api.askKadStatus();
  } catch {
    status = null;
  }
  paintBanner();
}
