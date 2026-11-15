// Vaghinak - Sales Expert, step 1 (owner, 2026-11-15): the sales funnel. Four stages, how many customers stand on each, this month's moves,
// per rep and per region, and the list of a stage's customers closest to the next stage first. Rules and numbers: server/src/team/vaghinak/funnel.js.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { editsVaghinakSettings } from "../shared/roles.js";
import { escapeHtml, activateDialog, showToast } from "../util.js";

const STAGES = [1, 2, 3, 4];
const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key));

export async function renderFunnel(root, navigate) {
  let data = null;
  let stage = 1;
  let rep = "";
  let region = "";
  let onlyMissing = false;
  root.innerHTML = `
    <div class="st-view fn-view">
      <div class="st-head"><button type="button" class="btn st-back" id="fn-back" aria-label="${escapeHtml(t("back"))}">‹</button><h1>${escapeHtml(t("fn_title"))}</h1>
        <button type="button" class="icon-btn fn-info" id="fn-info" aria-label="${escapeHtml(t("fn_how"))}">!</button></div>
      <div id="fn-body"><p class="loading-state" role="status">${escapeHtml(t("loading"))}</p></div>
    </div>`;
  root.querySelector("#fn-back").addEventListener("click", () => navigate.goBack("#/vaghinak"));
  root.querySelector("#fn-info").addEventListener("click", () => data && openRules());
  const body = root.querySelector("#fn-body");

  try {
    data = await api.getFunnel();
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const inScope = () => data.customers.filter((c) => (!rep || String(c.rep_id ?? "") === rep) && (!region || (c.region ?? "") === region));

  function detail(c) {
    if (c.stage === 1) return t(`fn_lvl_${c.potential_level ?? 0}`);
    if (c.stage === 2) return fill("fn_groups_of", { n: c.groups, of: data.settings.groupsTarget[c.tier] ?? data.settings.groupsTarget.bronze });
    if (c.next === "expected_volume_missing") return t("fn_no_expected");
    return fill("fn_share_line", { l: nf(c.litres_month), of: nf(c.expected_volume_l), pct: c.share ?? 0 });
  }
  // the next step that moves the customer one stage up (server team/vaghinak/nextSteps.js)
  function stepText(step) {
    if (!step) return "";
    const p = step.params ?? {};
    return fill(`fn_step_${step.kind}`, { group: t(`fn_group_${String(p.group ?? "").toLowerCase().replace(/\s+/g, "_")}`), brand: p.brand ?? "", share: p.share ?? 0, before: p.before ?? 0, now: p.now ?? 0 });
  }
  const days = (since) => (since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000)) : null);

  function paint() {
    const rows = inScope();
    const count = (s) => rows.filter((c) => c.stage === s).length;
    const total = rows.length || 1;
    // this month's moves of the customers the filters show
    const ids = new Set(rows.map((c) => c.id));
    const moves = data.moves.filter((m) => ids.has(m.customer_id));
    const movesIn = (s) => moves.filter((m) => m.to_stage === s && m.from_stage < s).length;
    const movesDown = (s) => moves.filter((m) => m.from_stage === s && m.to_stage < s).length;
    const missing = rows.filter((c) => c.next === "expected_volume_missing").length;
    const reps = [...new Map(data.customers.filter((c) => c.rep_id).map((c) => [String(c.rep_id), c.rep_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const regions = [...new Set(data.customers.map((c) => c.region).filter(Boolean))].sort();
    const levels = [0, 1, 2, 3, 4].map((l) => [l, rows.filter((c) => c.stage === 1 && (c.potential_level ?? 0) === l).length]);
    let list = rows.filter((c) => c.stage === stage);
    if (onlyMissing) list = rows.filter((c) => c.next === "expected_volume_missing");
    list.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1) || String(a.name).localeCompare(String(b.name)));
    const byRep = reps.map(([id, name]) => [name, STAGES.map((s) => rows.filter((c) => String(c.rep_id) === id && c.stage === s).length)]).filter(([, n]) => n.some(Boolean));

    body.innerHTML = `
      <div class="fn-filters">
        <select id="fn-rep" aria-label="${escapeHtml(t("fn_rep"))}"><option value="">${escapeHtml(t("fn_all_reps"))}</option>${reps.map(([id, name]) => `<option value="${id}" ${id === rep ? "selected" : ""}>${escapeHtml(name ?? "")}</option>`).join("")}</select>
        <select id="fn-region" aria-label="${escapeHtml(t("fn_region"))}"><option value="">${escapeHtml(t("fn_all_regions"))}</option>${regions.map((r) => `<option ${r === region ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}</select>
      </div>
      <div class="fn-stages" role="tablist">
        ${STAGES.map((s) => `<button type="button" role="tab" class="fn-stage fn-stage-${s}" data-stage="${s}" aria-selected="${!onlyMissing && s === stage}">
            <span class="fn-stage-name">${s}. ${escapeHtml(t(`fn_stage_${s}`))}</span>
            <strong class="fn-stage-count">${nf(count(s))}</strong>
            <span class="fn-stage-pct muted">${Math.round((count(s) / total) * 100)}%</span>
            <span class="fn-stage-moves">${movesIn(s) ? `<span class="fn-up">▲ ${movesIn(s)}</span>` : ""}${movesDown(s) ? `<span class="fn-down">▼ ${movesDown(s)}</span>` : ""}</span>
          </button>`).join("")}
      </div>
      <p class="muted fn-month">${escapeHtml(t("fn_moves_month"))}</p>
      ${stage === 1 && !onlyMissing ? `<div class="fn-levels">${levels.map(([l, n]) => `<span class="badge">${escapeHtml(t(`fn_lvl_${l}`))} · ${n}</span>`).join("")}</div>` : ""}
      ${missing ? `<button type="button" class="fn-missing ${onlyMissing ? "is-on" : ""}" id="fn-missing">${escapeHtml(fill("fn_missing_expected", { n: missing }))}</button>` : ""}
      <h2 class="list-group-heading">${escapeHtml(onlyMissing ? t("fn_no_expected") : `${stage}. ${t(`fn_stage_${stage}`)} · ${t(`fn_next_${stage}`)}`)}</h2>
      <div class="fn-list">${
        list.length
          ? list
              .map(
                (c) => `<button type="button" class="fn-row" data-customer="${c.id}">
                  <span class="fn-row-main"><strong>${escapeHtml(c.name)}</strong><span class="muted">${escapeHtml([c.rep_name, c.region].filter(Boolean).join(" · "))}</span>${c.step ? `<span class="fn-step">→ ${escapeHtml(stepText(c.step))}</span>` : ""}</span>
                  <span class="fn-row-side"><span class="fn-detail">${escapeHtml(detail(c))}</span>
                    ${c.progress === null ? "" : `<span class="fn-bar" role="img" aria-label="${c.progress}%"><span style="width:${c.progress}%"></span></span>`}
                    ${days(c.since) !== null ? `<span class="muted fn-days">${escapeHtml(fill("fn_days", { n: days(c.since) }))}</span>` : ""}</span>
                </button>`
              )
              .join("")
          : `<p class="empty-state">${escapeHtml(t("fn_empty"))}</p>`
      }</div>
      ${picksHtml(rows)}
      ${
        byRep.length > 1 && !rep
          ? `<h2 class="list-group-heading">${escapeHtml(t("fn_by_rep"))}</h2>
             <table class="fn-table"><thead><tr><th>${escapeHtml(t("fn_rep"))}</th>${STAGES.map((s) => `<th>${s}</th>`).join("")}</tr></thead>
             <tbody>${byRep.map(([name, n]) => `<tr><th scope="row">${escapeHtml(name ?? "")}</th>${n.map((v) => `<td>${v || ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`
          : ""
      }`;
    body.querySelector("#fn-rep").addEventListener("change", (e) => ((rep = e.target.value), paint()));
    body.querySelector("#fn-region").addEventListener("change", (e) => ((region = e.target.value), paint()));
    body.querySelectorAll("[data-stage]").forEach((b) => b.addEventListener("click", () => ((stage = Number(b.dataset.stage)), (onlyMissing = false), paint())));
    body.querySelector("#fn-missing")?.addEventListener("click", () => ((onlyMissing = !onlyMissing), paint()));
    body.querySelector("#fn-picks-run")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api.runFunnelPicks();
        data = await api.getFunnel();
        showToast(fill("fn_picks_made", { n: r.picked ?? 0 }));
        paint();
      } catch (ex) {
        showToast(ex.message);
      }
    });
    body.querySelector("#fn-steps-mode")?.addEventListener("click", async (e) => {
      const next = data.steps_mode === "live" ? "shadow" : "live";
      const btn = e.currentTarget;
      // going live gives tasks to every sales manager: two taps, no browser pop-up (the first shows what will happen)
      if (next === "live" && btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = t("fn_steps_live_confirm");
        setTimeout(() => {
          if (btn.isConnected && btn.dataset.armed === "1") {
            btn.dataset.armed = "";
            btn.textContent = t("fn_steps_to_live");
          }
        }, 6000);
        return;
      }
      btn.disabled = true;
      try {
        await api.vaghinakSaveSettings({ salesStepsMode: next });
        data = await api.getFunnel();
        paint();
      } catch (ex) {
        showToast(ex.message);
      }
    });
    // a customer on stage 2+ gets its monthly need written right here (stage 4 measures our share of it); a potential one opens its card
    body.querySelectorAll("[data-customer]").forEach((b) =>
      b.addEventListener("click", () => {
        const c = data.customers.find((x) => x.id === Number(b.dataset.customer));
        if (c && c.stage >= 2) openVolume(c);
        else navigate(`#/customers/${b.dataset.customer}`);
      })
    );
  }

  function openVolume(c) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet">
      <h2>${escapeHtml(c.name)}</h2>
      <p class="muted">${escapeHtml(detail(c))}</p>
      <label class="fn-set">${escapeHtml(t("fn_expected_label"))}<input type="number" inputmode="numeric" min="0" step="1" id="fn-vol" value="${c.expected_volume_l ?? ""}" /></label>
      <p class="muted">${escapeHtml(t("fn_expected_hint"))}</p>
      <p class="form-error" id="fn-vol-error" hidden></p>
      <div class="sheet-actions"><button type="button" class="btn" id="fn-open">${escapeHtml(t("fn_open_customer"))}</button><button type="button" class="btn btn-primary" id="fn-vol-save">${escapeHtml(t("save"))}</button></div>
    </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#fn-open").addEventListener("click", () => {
      overlay.remove();
      navigate(`#/customers/${c.id}`);
    });
    overlay.querySelector("#fn-vol-save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const raw = overlay.querySelector("#fn-vol").value.trim();
      btn.disabled = true;
      try {
        await api.setFunnelExpectedVolume(c.id, raw === "" ? null : Number(raw));
        data = await api.getFunnel();
        overlay.remove();
        showToast(t("saved"));
        paint();
      } catch (ex) {
        const err = overlay.querySelector("#fn-vol-error");
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  // This week's 5 best steps per sales manager (shadow: only management sees them; live: they are the reps' tasks too)
  function picksHtml(rows) {
    const ids = new Set(rows.map((c) => c.id));
    const nameOf = new Map(data.customers.map((c) => [c.id, c]));
    const picks = data.picks.filter((p) => ids.has(p.customer_id));
    const canEdit = editsVaghinakSettings(state.user.role);
    const live = data.steps_mode === "live";
    const byRepPicks = new Map();
    for (const p of picks) byRepPicks.set(p.rep_id, [...(byRepPicks.get(p.rep_id) ?? []), p]);
    const repName = (id) => data.customers.find((c) => c.rep_id === id)?.rep_name ?? "";
    return `<h2 class="list-group-heading">${escapeHtml(t("fn_picks_title"))}${picks[0] ? ` · ${escapeHtml(picks[0].week_start)}` : ""}</h2>
      <div class="fn-picks-head">
        <span class="badge ${live ? "badge-success" : "badge-warning"}">${escapeHtml(t(live ? "fn_steps_live" : "fn_steps_shadow"))}</span>
        <span class="muted">${escapeHtml(t(live ? "fn_steps_live_hint" : "fn_steps_shadow_hint"))}</span>
      </div>
      ${
        picks.length
          ? [...byRepPicks.entries()]
              .map(([repId, list]) => `<div class="fn-picks-rep"><strong>${escapeHtml(repName(repId))}</strong><ol>${list
                .map((p) => {
                  const c = nameOf.get(p.customer_id);
                  const done = p.task_status === "done";
                  return `<li class="${done ? "fn-pick-done" : ""}">${escapeHtml(c?.name ?? "")} — ${escapeHtml(stepText(p))}${done ? ` <span class="badge badge-success">${escapeHtml(t("fn_pick_done"))}</span>` : ""}</li>`;
                })
                .join("")}</ol></div>`)
              .join("")
          : `<p class="muted">${escapeHtml(t("fn_picks_none"))}</p>`
      }
      ${canEdit ? `<div class="fn-picks-actions">${picks.length ? "" : `<button type="button" class="btn" id="fn-picks-run">${escapeHtml(t("fn_picks_run"))}</button>`}<button type="button" class="btn ${live ? "" : "btn-primary"}" id="fn-steps-mode">${escapeHtml(t(live ? "fn_steps_to_shadow" : "fn_steps_to_live"))}</button></div>` : ""}`;
  }

  // The four stages in plain words, with the numbers in force; management with the right edits the numbers here.
  function openRules() {
    const s = data.settings;
    const canEdit = editsVaghinakSettings(state.user.role);
    const field = (key, value, label) =>
      `<label class="fn-set">${escapeHtml(label)}<input type="number" inputmode="numeric" min="${key === "funnelWindowDays" ? 7 : 1}" max="${key === "funnelSharePct" ? 100 : key === "funnelWindowDays" ? 365 : 7}" name="${key}" value="${value}" ${canEdit ? "" : "disabled"} /></label>`;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet">
      <h2>${escapeHtml(t("fn_how"))}</h2>
      <p class="muted">${escapeHtml(t("fn_rules_change_note"))}</p>
      <ol class="fn-rules">${STAGES.map((n) => `<li><strong>${escapeHtml(t(`fn_stage_${n}`))}</strong> ${escapeHtml(t(`fn_rule_${n}`))}</li>`).join("")}</ol>
      <div class="fn-sets">
        ${field("funnelGroupsBronze", s.groupsTarget.bronze, t("fn_set_bronze"))}
        ${field("funnelGroupsSilver", s.groupsTarget.silver, t("fn_set_silver"))}
        ${field("funnelGroupsGold", s.groupsTarget.gold, t("fn_set_gold"))}
        ${field("funnelSharePct", s.sharePct, t("fn_set_share"))}
        ${field("funnelWindowDays", s.windowDays, t("fn_set_window"))}
      </div>
      <p class="form-error" id="fn-set-error" hidden></p>
      ${canEdit ? `<div class="sheet-actions"><button type="button" class="btn btn-primary" id="fn-set-save">${escapeHtml(t("save"))}</button></div>` : ""}
    </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#fn-set-save")?.addEventListener("click", async (e) => {
      const patch = Object.fromEntries([...overlay.querySelectorAll("input[name]")].map((i) => [i.name, Number(i.value)]));
      const err = overlay.querySelector("#fn-set-error");
      const bad = Object.entries(patch).some(([k, v]) => !Number.isInteger(v) || v < (k === "funnelWindowDays" ? 7 : 1) || v > (k === "funnelSharePct" ? 100 : k === "funnelWindowDays" ? 365 : 7));
      if (bad) {
        err.textContent = t("fn_set_bad");
        err.hidden = false;
        return;
      }
      e.currentTarget.disabled = true;
      try {
        await api.vaghinakSaveSettings(patch);
        data = await api.getFunnel();
        overlay.remove();
        showToast(t("saved"));
        paint();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        overlay.querySelector("#fn-set-save").disabled = false;
      }
    });
  }

  paint();
}
