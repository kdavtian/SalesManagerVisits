// Vaghinak's page (Home -> Vaghinak). Everybody: his messages and the questions waiting for an answer.
// Management: Team today (the live pulse of every rep), Questions (what he asked and what was answered), Everything he
// said (also what he WOULD say in test mode) and Settings (mode, thresholds, how he addresses people).
import { api } from "../api.js";
import { state } from "../state.js";
import { icons } from "../icons.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateTime, formatDuration, formatRelative, openInfoPopup, showToast } from "../util.js";
import { answerFormHtml, wireAnswerForm, setVaghinakBadge } from "../vaghinak.js";

const MANAGEMENT = new Set(["admin", "ceo", "operations_director", "sales_director", "accountant"]);
const SETTINGS_ROLES = new Set(["admin", "ceo", "operations_director"]);

const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// [key, i18n label key, "time" (minutes of day shown as HH:MM) | "min" (minutes, also shown as hours + minutes) | "plain" (a plain number)]
const SETTING_FIELDS = [
  ["workStartMin", "vg_set_workStartMin", "time"],
  ["workEndMin", "vg_set_workEndMin", "time"],
  ["lateGraceMin", "vg_set_lateGraceMin", "min"],
  ["notStartedAskMin", "vg_set_notStartedAskMin", "min"],
  ["notStartedMandatoryMin", "vg_set_notStartedMandatoryMin", "min"],
  ["officeWarnMin", "vg_set_officeWarnMin", "min"],
  ["officeAskMin", "vg_set_officeAskMin", "min"],
  ["idleWarnMin", "vg_set_idleWarnMin", "min"],
  ["idleAskMin", "vg_set_idleAskMin", "min"],
  ["clusterRadiusM", "vg_set_clusterRadiusM", "plain"],
  ["clusterFarM", "vg_set_clusterFarM", "plain"],
  ["dailyCap", "vg_set_dailyCap", "plain"],
  ["slaConfirmH", "vg_set_slaConfirmH", "plain"],
  ["slaPackH", "vg_set_slaPackH", "plain"],
  ["slaDeliverH", "vg_set_slaDeliverH", "plain"],
];

// Operations control (cash, margin, stock, customers, order flow, data): the roles that had its Home tile.
const OPS_ROLES = new Set(["admin", "ceo", "operations_director", "sales_director", "accountant"]);
const TAB_ICON = { messages: "vaghinak", pulse: "team", qa: "info", feed: "history", autotasks: "tasks", settings: "settings" };
const OPS_QUICK = [["cash", "wallet"], ["margin", "trendUp"], ["stock", "box"], ["customers", "customers"], ["flow", "clock"], ["data", "dashboard"]];

export async function renderVaghinak(root, navigate) {
  const isManagement = MANAGEMENT.has(state.user.role);
  const canSettings = SETTINGS_ROLES.has(state.user.role);
  const tabs = [["messages", "vg_tab_messages"], ...(isManagement ? [["pulse", "vg_tab_pulse"], ["qa", "vg_tab_qa"], ["feed", "vg_tab_feed"], ["autotasks", "vg_tab_autotasks"]] : []), ...(canSettings ? [["settings", "vg_tab_settings"]] : [])];
  let tab = "messages";

  root.innerHTML = `
    <div class="detail-view vg-view">
      <div class="detail-header oc-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="vg-avatar vg-avatar-sm" aria-hidden="true">Վ</div>
        <div class="detail-header-title oc-title"><h1>${t("vg_title")}</h1><span class="oc-customer">${t("vg_subtitle")}</span></div>
      </div>
      ${isManagement ? `<div id="vg-summary"></div>` : ""}
      ${
        // His sections (they switch the tab below) as one slim swipeable row, then the Operations control quick actions
        // (each opens that tab of the Operations page) as a second row. A rep only has Messages, so no rows.
        tabs.length > 1 || OPS_ROLES.has(state.user.role)
          ? `<div class="vg-chips" id="vg-tiles" role="tablist">${tabs
              .map(([k, label]) => `<button type="button" class="vg-chip${k === tab ? " vg-chip-active" : ""}" data-tab="${k}" role="tab" aria-selected="${k === tab}"><span class="vg-chip-icon">${icons[TAB_ICON[k]]}</span>${t(label)}</button>`)
              .join("")}</div>${
              OPS_ROLES.has(state.user.role)
                ? `<div class="vg-chips vg-chips-ops"><span class="vg-chips-label">${t("vg_ops_label")}</span>${OPS_QUICK.map(([k, icon]) => `<button type="button" class="vg-chip vg-chip-ops" data-ops-tab="${k}"><span class="vg-chip-icon">${icons[icon]}</span>${t("ops_tab_" + k)}</button>`).join("")}</div>`
                : ""
            }`
          : ""
      }
      <div id="vg-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => history.back());
  const body = root.querySelector("#vg-body");
  // Operations control lives here: one quick action per Operations tab.
  root.querySelectorAll("[data-ops-tab]").forEach((btn) => btn.addEventListener("click", () => navigate(`#/ops-control?tab=${btn.dataset.opsTab}`)));
  function selectTab(k) {
    tab = k;
    root.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === k;
      b.classList.toggle("vg-chip-active", on);
      b.setAttribute("aria-selected", String(on));
      // The chip row scrolls sideways: bring the chosen section's chip into view (it used to stay off-screen when
      // the section was opened from the "Today" card).
      if (on) {
        const bar = b.parentElement;
        const bb = bar.getBoundingClientRect();
        const cb = b.getBoundingClientRect();
        bar.scrollTo({ left: bar.scrollLeft + (cb.left - bb.left) - (bb.width - cb.width) / 2, behavior: "smooth" });
      }
    });
    load();
  }
  root.querySelectorAll("[data-tab]").forEach((btn) => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));

  // The "Today" card (management): team plan, people needing attention, open questions -- each tap opens its tab.
  async function paintSummary() {
    const slot = root.querySelector("#vg-summary");
    if (!slot) return;
    try {
      const data = await api.vaghinakPulse();
      const reps = data.reps.filter((r) => !r.muted);
      const planned = reps.reduce((n, r) => n + r.plannedCount, 0);
      const done = reps.reduce((n, r) => n + r.visitedPlanned, 0);
      const attention = reps.filter((r) => r.flags.length).length;
      const questions = data.reps.reduce((n, r) => n + r.open_questions, 0);
      const planPct = planned ? Math.round((done / planned) * 100) : null;
      const modeKey = { off: "vg_ms_off", shadow: "vg_ms_shadow", live: "vg_ms_live" }[data.settings.mode];
      slot.innerHTML = `<div class="card vg-summary">
        <div class="vg-summary-top"><strong>${t("vg_sum_today")}</strong><span class="muted">${clock(data.nowMin)}</span><span class="badge ${data.settings.mode === "live" ? "badge-success" : "badge-neutral"}">${t(modeKey)}</span></div>
        <div class="vg-stats">
          <button type="button" class="vg-stat" data-go="pulse"><strong class="${planPct !== null && planPct < 50 ? "vg-bad" : ""}">${planPct === null ? "—" : planPct + "%"}</strong><span>${t("vg_sum_plan")}</span></button>
          <button type="button" class="vg-stat" data-go="pulse"><strong class="${attention ? "vg-warn" : ""}">${attention}</strong><span>${t("vg_sum_attention")}</span></button>
          <button type="button" class="vg-stat" data-go="qa"><strong class="${questions ? "vg-warn" : ""}">${questions}</strong><span>${t("vg_sum_questions")}</span></button>
        </div>
      </div>`;
      slot.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.go)));
    } catch {
      slot.innerHTML = "";
    }
  }

  const showError = (err) => (body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`);
  let token = 0;
  async function load() {
    const mine = ++token;
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (tab === "messages") return await paintMessages(mine);
      if (tab === "pulse") return await paintPulse(mine);
      if (tab === "qa") return await paintQa(mine);
      if (tab === "feed") return await paintFeed(mine);
      if (tab === "autotasks") return await paintAutoTasks(mine);
      if (tab === "settings") return await paintSettings(mine);
    } catch (err) {
      if (mine === token) showError(err);
    }
  }

  // ---- messages (everyone) ----
  async function paintMessages(mine) {
    const { messages, badge } = await api.vaghinakInbox();
    if (mine !== token) return;
    if (!messages.length) {
      body.innerHTML = `<p class="empty-state">${t("vg_empty")}</p>`;
      return;
    }
    body.innerHTML = `<div class="card-list vg-list">${messages
      .map((m) => {
        const open = m.needs_answer && !m.answered_at;
        return `<div class="card vg-msg ${m.read_at ? "" : "vg-unread"} ${open ? "vg-open" : ""}" data-id="${m.id}">
          <div class="vg-msg-body">${escapeHtml(m.body)}</div>
          ${m.answered_at ? `<div class="vg-answered">${escapeHtml(answerLabel(m))}</div>` : ""}
          <div class="vg-msg-foot"><span class="muted vg-msg-meta">${m.read_at ? "" : `<span class="vg-unread-dot" role="img" aria-label="${t("vg_unread")}"></span>`}${escapeHtml(formatRelative(m.created_at))}${m.answered_at ? ` · ${t("vg_answered")}` : ""}</span>${open || m.needs_answer ? "" : reactHtml(m)}</div>
          ${open ? answerFormHtml(m, `vg-m${m.id}`) : ""}
        </div>`;
      })
      .join("")}</div>`;
    body.querySelectorAll(".vg-msg").forEach((card) => {
      const m = messages.find((x) => x.id === Number(card.dataset.id));
      if (m.needs_answer && !m.answered_at) wireAnswerForm(card, m, () => load());
      card.querySelectorAll("[data-react]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          try {
            await api.vaghinakReact(m.id, btn.dataset.react);
            card.querySelectorAll("[data-react]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
          } catch (err) {
            showToast(err.message);
          }
        })
      );
    });
    // opening the page = reading the messages that need no answer
    api.vaghinakReadAll().then(({ count }) => setVaghinakBadge(count)).catch(() => {});
  }
  const reactHtml = (m) =>
    `<div class="vg-react"><button type="button" class="vg-react-btn" data-react="helpful" aria-pressed="${m.reaction === "helpful"}">${t("vg_helpful")}</button><button type="button" class="vg-react-btn" data-react="not_relevant" aria-pressed="${m.reaction === "not_relevant"}">${t("vg_not_relevant")}</button></div>`;
  const answerLabel = (m) => {
    const choice = (m.choices ?? []).find((c) => c.key === m.answer_choice)?.label;
    return [choice, m.answer_text].filter(Boolean).join(" — ");
  };

  // ---- team today (management) ----
  async function paintPulse(mine) {
    const data = await api.vaghinakPulse();
    if (mine !== token) return;
    const modeKey = { off: "vg_mode_off", shadow: "vg_mode_shadow", live: "vg_mode_live" }[data.settings.mode];
    const flagText = (f) => t(`vg_flag_${f.code}`).replace("{n}", f.code === "stopped_early" ? String(f.remaining ?? "") : f.minutes != null ? formatDuration(f.minutes) : "");
    body.innerHTML = `
      <p class="muted vg-mode-line"><span class="badge ${data.settings.mode === "live" ? "badge-success" : "badge-neutral"}">${t(modeKey)}</span> ${data.day} · ${clock(data.nowMin)}</p>
      ${data.settings.mode === "shadow" ? `<p class="muted vg-hint">${t("vg_mode_hint_shadow")}</p>` : ""}
      <div class="card-list vg-list">
        ${
          data.reps.length
            ? data.reps
                .map((r) => {
                  const pct = r.plannedCount ? Math.round((r.visitedPlanned / r.plannedCount) * 100) : null;
                  const facts = [
                    r.started ? `${t("vg_p_started")} ${clock(r.firstMin)}` : t("vg_p_none"),
                    r.atOffice ? `${t("vg_p_office")} ${formatDuration(r.officeMinutes)}` : "",
                    !r.atOffice && r.started && r.idleMinutes ? `${t("vg_p_idle")} ${formatDuration(r.idleMinutes)}` : "",
                  ].filter(Boolean);
                  return `<div class="card vg-rep ${r.muted ? "vg-muted" : ""}">
                    <div class="vg-rep-top"><strong>${escapeHtml(r.name)}</strong>${r.open_questions ? `<span class="badge badge-warning">${t("vg_open_q").replace("{n}", String(r.open_questions))}</span>` : ""}</div>
                    <div class="muted">${facts.map(escapeHtml).join(" · ")}</div>
                    <div class="vg-plan"><div class="progress-bar"><div class="progress-bar-fill" style="width:${pct ?? 0}%"></div></div><span>${t("vg_p_plan")} ${r.visitedPlanned}/${r.plannedCount}</span></div>
                    <div class="vg-flags">${r.muted ? `<span class="badge badge-neutral">${t("vg_muted")}</span>` : r.flags.length ? r.flags.map((f) => `<span class="badge badge-warning">${escapeHtml(flagText(f))}</span>`).join("") : `<span class="badge badge-success">${t("vg_all_good")}</span>`}</div>
                    ${canSettings ? `<button type="button" class="btn-link vg-mute" data-mute="${r.user_id}" data-on="${r.muted ? "0" : "1"}">${r.muted ? t("vg_unmute") : t("vg_mute")}</button>` : ""}
                  </div>`;
                })
                .join("")
            : `<p class="empty-state">${t("vg_no_reps")}</p>`
        }
      </div>
      ${state.user.role === "admin" ? `<button type="button" class="btn btn-block" id="vg-run-now">${t("vg_run_now")}</button>` : ""}`;
    body.querySelectorAll("[data-mute]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api.vaghinakMute(Number(btn.dataset.mute), btn.dataset.on === "1").catch((e) => showToast(e.message));
        load();
      })
    );
    body.querySelector("#vg-run-now")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const { created } = await api.vaghinakRunNow();
        showToast(t("vg_run_done").replace("{n}", String(created)));
      } catch (err) {
        showToast(err.message);
      }
      load();
    });
  }

  // ---- questions and answers (management) ----
  async function paintQa(mine) {
    const rows = await api.vaghinakQa();
    if (mine !== token) return;
    body.innerHTML = rows.length
      ? `<div class="card-list vg-list">${rows
          .map((q) => {
            const label = (q.choices ?? []).find((c) => c.key === q.answer_choice)?.label;
            return `<div class="card vg-msg">
              <div class="vg-rep-top"><strong>${escapeHtml(q.user_name)}</strong>
                ${q.mandatory ? `<span class="badge badge-danger">${t("vg_mandatory")}</span>` : ""}${q.shadow ? `<span class="badge badge-neutral">${t("vg_shadow_badge")}</span>` : ""}</div>
              <div class="vg-msg-body">${escapeHtml(q.body)}</div>
              <div class="muted vg-msg-meta">${escapeHtml(formatDateTime(q.created_at))}</div>
              ${q.answered_at ? `<div class="vg-answered">${escapeHtml([label, q.answer_text].filter(Boolean).join(" — "))} <span class="muted">· ${escapeHtml(formatDateTime(q.answered_at))}</span></div>` : `<div class="vg-waiting">${t("vg_unanswered")}</div>`}
            </div>`;
          })
          .join("")}</div>`
      : `<p class="empty-state">${t("vg_qa_empty")}</p>`;
  }

  // ---- everything he said (management) ----
  async function paintFeed(mine) {
    const rows = await api.vaghinakFeed();
    if (mine !== token) return;
    body.innerHTML = rows.length
      ? `<div class="card-list vg-list">${rows
          .map(
            (m) => `<div class="card vg-msg">
              <div class="vg-rep-top"><strong>${escapeHtml(m.user_name)}</strong>${m.shadow ? `<span class="badge badge-neutral">${t("vg_shadow_badge")}</span>` : ""}${m.reaction ? `<span class="badge ${m.reaction === "helpful" ? "badge-success" : "badge-warning"}">${t(m.reaction === "helpful" ? "vg_helpful" : "vg_not_relevant")}</span>` : ""}</div>
              <div class="vg-msg-body">${escapeHtml(m.body)}</div>
              <div class="muted vg-msg-meta">${escapeHtml(formatDateTime(m.created_at))}</div>
            </div>`
          )
          .join("")}</div>`
      : `<p class="empty-state">${t("vg_empty")}</p>`;
  }

  // ---- the automatic debt / reorder tasks: why they were or were not created ----
  async function paintAutoTasks(mine) {
    const d = await api.vaghinakAutoTasks();
    if (mine !== token) return;
    const when = (v) => (v ? escapeHtml(formatRelative(v)) : "—");
    const row = (label, n, tone = "") => `<div class="health-row"><span class="health-label">${t(label)}</span><span class="health-value ${tone}">${n}</span></div>`;
    const kinds = [["debt_collection", "vg_at_kind_debt"], ["reorder_followup", "vg_at_kind_reorder"]];
    body.innerHTML = `
      <div class="card health-card">
        <h3 class="health-title">${t("vg_at_title")}<button type="button" class="settings-hint-icon" id="vg-at-hint" aria-label="${t("more_info")}">!</button></h3>
        ${row("vg_at_last_sync", when(d.last_sync_at))}
        ${row("vg_at_overdue", d.overdue_total)}
        ${row("vg_at_ready", d.ready, d.ready ? "vg-warn" : "")}
        ${row("vg_at_has_open", d.has_open)}
        ${row("vg_at_promise", d.promise_running)}
        ${row("vg_at_cooling", d.cooling)}
        ${row("vg_at_hold", d.on_hold)}
        ${row("vg_at_channel", d.channel_skipped)}
        ${row("vg_at_no_rep", d.no_rep, d.no_rep ? "vg-warn" : "")}
        ${d.capped_by_limit ? row("vg_at_capped", d.capped_by_limit, "vg-warn") : ""}
      </div>
      <div class="card health-card">
        <h3 class="health-title">${t("vg_at_created")}</h3>
        ${kinds.map(([k, label]) => `<div class="health-row"><span class="health-label">${t(label)}</span><span class="health-value">${t("vg_at_created_row").replace("{last}", when(d.tasks[k]?.last_created)).replace("{w}", d.tasks[k]?.last_7_days ?? 0).replace("{m}", d.tasks[k]?.last_30_days ?? 0)}</span></div>`).join("")}
      </div>`;
    body.querySelector("#vg-at-hint").addEventListener("click", () => openInfoPopup(`<p>${t("vg_at_hint").replace("{n}", d.cooldown_days).replace("{m}", d.max_per_rep)}</p>`));
  }

  // ---- settings (admin / CEO / operations director) ----
  async function paintSettings(mine) {
    const { settings, people } = await api.vaghinakSettings();
    if (mine !== token) return;
    const modes = [["off", "vg_mode_off"], ["shadow", "vg_mode_shadow"], ["live", "vg_mode_live"]];
    body.innerHTML = `
      <h2 class="section-title">${t("vg_mode")}</h2>
      <div class="vg-modes" role="radiogroup">${modes.map(([k, label]) => `<button type="button" class="map-filter-chip${settings.mode === k ? " chip-active" : ""}" data-mode="${k}" role="radio" aria-checked="${settings.mode === k}">${t(label)}</button>`).join("")}</div>
      <p class="muted vg-hint">${t(`vg_mode_hint_${settings.mode}`)}</p>
      <h2 class="section-title">${t("vg_set_thresholds")}</h2>
      <div class="card vg-fields">${SETTING_FIELDS.map(([key, label, kind]) =>
        `<label class="vg-field"><span>${t(label)}${kind === "min" ? ` <b class="vg-dur" data-dur="${key}">${formatDuration(settings[key])}</b>` : ""}</span><input data-setting="${key}" data-kind="${kind}" ${kind === "time" ? `type="time" value="${clock(settings[key])}"` : `type="number" inputmode="numeric" min="0" max="1440" value="${settings[key]}"`} /></label>`
      ).join("")}</div>
      <h2 class="section-title">${t("vg_set_people")}</h2>
      <p class="muted vg-hint">${t("vg_set_people_hint")}</p>
      <div class="card vg-fields">${people
        .map((p) => `<label class="vg-field"><span>${escapeHtml(p.name_hy || p.name)}</span><input type="text" maxlength="60" data-address="${p.id}" value="${escapeHtml(p.vaghinak_address ?? "")}" placeholder="${t("vg_auto")}" /></label>`)
        .join("")}</div>`;
    body.querySelectorAll("[data-mode]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        try {
          await api.vaghinakSaveSettings({ mode: btn.dataset.mode });
          showToast(t("vg_saved"));
          load();
        } catch (err) {
          showToast(err.message);
        }
      })
    );
    body.querySelectorAll('[data-kind="min"]').forEach((input) =>
      input.addEventListener("input", () => {
        const cap = body.querySelector(`[data-dur="${input.dataset.setting}"]`);
        if (cap) cap.textContent = formatDuration(input.value);
      })
    );
    body.querySelectorAll("[data-setting]").forEach((input) =>
      input.addEventListener("change", async () => {
        const value = input.dataset.kind === "time" ? Number(input.value.split(":")[0]) * 60 + Number(input.value.split(":")[1]) : Number(input.value);
        try {
          await api.vaghinakSaveSettings({ [input.dataset.setting]: value });
          showToast(t("vg_saved"));
        } catch (err) {
          showToast(err.message);
        }
      })
    );
    body.querySelectorAll("[data-address]").forEach((input) =>
      input.addEventListener("change", async () => {
        try {
          await api.vaghinakSetAddress(Number(input.dataset.address), input.value);
          showToast(t("vg_saved"));
        } catch (err) {
          showToast(err.message);
        }
      })
    );
  }

  load();
  paintSummary();
}
