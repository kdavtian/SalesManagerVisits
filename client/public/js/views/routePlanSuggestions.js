// Vaghinak's route-plan suggestions (owner, 2026-11-03): the CEO / admin accepts them one by one or all at once. Nothing in a plan changes before
// an accept; every decision stays in the list below as the log. Data: GET /api/route-plan-suggestions (field/routePlanAnalysis.js).
import { api } from "../api.js";
import { t, getLang } from "../i18n.js";
import { escapeHtml, formatDateTime, customerNameLinkHtml, activateCustomerNameLinks } from "../util.js";

const DAY_KEYS = ["weekday_sun", "weekday_mon", "weekday_tue", "weekday_wed", "weekday_thu", "weekday_fri", "weekday_sat"];
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const km = (m) => (Number(m) / 1000).toFixed(1);
const day = (n) => t(DAY_KEYS[n]);

function reasonText(s) {
  const r = s.reason ?? {};
  if (s.kind === "add") return fill("rps_reason_add", { day: day(s.to_dow), km: km(r.target_m), load: r.to_load });
  return fill("rps_reason_move", { from: day(s.from_dow), to: day(s.to_dow), own: km(r.own_m), usual: km(r.usual_m), target: km(r.target_m) });
}

export async function renderRoutePlanSuggestions(root, navigate) {
  root.innerHTML = `
    <div class="detail-view rps-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("rps_sugg_title")}</h1></div>
      </div>
      <p class="muted">${t("rps_intro")}</p>
      <div class="rps-actions"><button type="button" class="btn" id="rps-analyze">${t("rps_analyze")}</button></div>
      <p class="form-error" id="rps-error" hidden></p>
      <div id="rps-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/route-plans"));
  const body = root.querySelector("#rps-body");
  const errorEl = root.querySelector("#rps-error");
  const analyzeBtn = root.querySelector("#rps-analyze");
  let armed = false;

  const showError = (text) => {
    errorEl.textContent = text || "";
    errorEl.hidden = !text;
  };

  async function load() {
    try {
      paint(await api.listRoutePlanSuggestions());
    } catch (err) {
      body.innerHTML = "";
      showError(err.message);
    }
  }

  function paint({ pending, decided }) {
    armed = false;
    const byRep = new Map();
    for (const s of pending) byRep.set(s.rep_id, [...(byRep.get(s.rep_id) ?? []), s]);
    body.innerHTML = `
      ${
        pending.length
          ? `<button type="button" class="btn btn-primary btn-block" id="rps-accept-all">${fill("rps_accept_all", { n: pending.length })}</button>
             ${[...byRep.values()]
               .map(
                 (list) => `<h2 class="section-title">${escapeHtml((getLang() === "hy" && list[0].rep_name_hy) || list[0].rep_name)} · ${list.length}</h2>
                 <div class="card-list">${list
                   .map(
                     (s) => `<div class="card rps-card" data-id="${s.id}">
                       <div class="rps-head"><strong>${customerNameLinkHtml(s.customer_name, s.customer_id)}</strong><span class="badge">${s.kind === "add" ? `+ ${day(s.to_dow)}` : `${day(s.from_dow)} → ${day(s.to_dow)}`}</span></div>
                       <p class="muted">${escapeHtml(reasonText(s))}</p>
                       <div class="rps-buttons"><button type="button" class="btn" data-dismiss="${s.id}">${t("rps_dismiss")}</button><button type="button" class="btn btn-primary" data-accept="${s.id}">${t("rps_accept")}</button></div>
                     </div>`
                   )
                   .join("")}</div>`
               )
               .join("")}`
          : `<p class="empty-state">${t("rps_none")}</p>`
      }
      ${
        decided.length
          ? `<h2 class="section-title">${t("rps_log")}</h2><div class="card-list">${decided
              .map((s) => `<div class="card rps-log"><span><strong>${escapeHtml(s.customer_name)}</strong> · ${escapeHtml((getLang() === "hy" && s.rep_name_hy) || s.rep_name)} · ${s.kind === "add" ? `+ ${day(s.to_dow)}` : `${day(s.from_dow)} → ${day(s.to_dow)}`}</span><span class="muted">${t(s.status === "accepted" ? "rps_accepted" : "rps_dismissed")} · ${escapeHtml(s.decided_by_name || "")} · ${formatDateTime(s.decided_at)}</span></div>`)
              .join("")}</div>`
          : ""
      }`;
    activateCustomerNameLinks(body, (hash) => navigate(hash));
    body.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", () => act(b, () => api.acceptRoutePlanSuggestion(Number(b.dataset.accept)))));
    body.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => act(b, () => api.dismissRoutePlanSuggestion(Number(b.dataset.dismiss)))));
    const all = body.querySelector("#rps-accept-all");
    all?.addEventListener("click", async () => {
      // two taps, no dialog: the first says what happens, the second does it
      if (!armed) {
        armed = true;
        all.textContent = fill("rps_accept_all_confirm", { n: pending.length });
        return;
      }
      all.disabled = true;
      try {
        const r = await api.acceptAllRoutePlanSuggestions();
        showError(r.skipped ? fill("rps_skipped", { n: r.skipped }) : "");
        await load();
      } catch (err) {
        showError(err.message);
        all.disabled = false;
      }
    });
  }

  async function act(button, call) {
    button.disabled = true;
    try {
      await call();
      showError("");
    } catch (err) {
      showError(err.body?.error === "plan_changed" ? t("rps_changed") : err.message);
    }
    await load();
  }

  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    try {
      await api.analyzeRoutePlans();
      showError("");
      await load();
    } catch (err) {
      showError(err.message);
    } finally {
      analyzeBtn.disabled = false;
    }
  });
  await load();
}
