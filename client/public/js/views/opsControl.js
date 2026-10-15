// Operations control (Home -> Operations): the operations director's console. Each card answers: which decision, who
// takes it, which action follows. Tabs: Cash (legacy balances + credit limits). More tabs are added per release.
import { api } from "../api.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { activateDialog, escapeHtml, formatAmd, groupDigits, bindAmdInput, showToast } from "../util.js";

const DECIDE_ROLES = new Set(["admin", "ceo", "operations_director"]);
const DECISIONS = ["collect", "restructure", "dispute", "legal", "write_off"];
const DECISION_BADGE = { collect: "badge-warning", restructure: "badge-info", dispute: "badge-neutral", legal: "badge-danger", write_off: "badge-neutral" };

export async function renderOpsControl(root, navigate) {
  const tabs = [["cash", "ops_tab_cash"]];
  let tab = "cash";
  root.innerHTML = `
    <div class="detail-view ops-view">
      <div class="detail-header oc-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title oc-title"><h1>${t("ops_title")}</h1><span class="oc-customer">${t("ops_subtitle")}</span></div>
      </div>
      ${tabs.length > 1 ? `<div class="oc-chips" id="ops-tabs" role="tablist">${tabs.map(([k, label]) => `<button type="button" class="map-filter-chip${k === tab ? " chip-active" : ""}" data-tab="${k}" role="tab" aria-selected="${k === tab}">${t(label)}</button>`).join("")}</div>` : ""}
      <div id="ops-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => history.back());
  const body = root.querySelector("#ops-body");
  root.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab;
      root.querySelectorAll("[data-tab]").forEach((b) => {
        b.classList.toggle("chip-active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      });
      load();
    })
  );

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (tab === "cash") await paintCash();
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------------- Cash ----------------
  async function paintCash() {
    const [legacy, limits] = await Promise.all([api.opsLegacyBalances(), api.opsCreditLimits()]);
    const canDecide = DECIDE_ROLES.has(state.user.role);
    const shown = legacy.items.slice(0, 40);
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_legacy_title")}</h2><button type="button" class="settings-hint-icon" id="ops-legacy-info" aria-label="${t("more_info")}">!</button></div>
        <p class="ops-sum"><strong>${formatAmd(legacy.total_amd)}</strong> <span class="muted">· ${legacy.items.length} ${t("ops_accounts")}</span></p>
        <p class="muted ops-undecided">${legacy.undecided_count ? `${t("ops_undecided")}: ${legacy.undecided_count} · ${formatAmd(legacy.undecided_amd)}` : t("ops_all_decided")}</p>
        <div class="ops-list">${shown.map(legacyRowHtml).join("") || `<p class="empty-state">${t("ops_none")}</p>`}</div>
        ${legacy.items.length > shown.length ? `<p class="muted ops-more">${t("ops_showing_top").replace("{n}", String(shown.length))}</p>` : ""}
      </section>
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_limits_title")}</h2><button type="button" class="settings-hint-icon" id="ops-limits-info" aria-label="${t("more_info")}">!</button></div>
        <p class="ops-sum"><strong>${limits.without_limit}</strong> <span class="muted">${t("ops_without_limit")}</span> · <span class="muted">${limits.with_limit} ${t("ops_with_limit")}</span></p>
        <button type="button" class="btn btn-block" id="ops-review-limits" ${limits.suggestions.length ? "" : "disabled"}>${t("ops_review_suggestions")}</button>
      </section>`;
    body.querySelector("#ops-legacy-info").addEventListener("click", () => infoPopup(t("ops_legacy_info")));
    body.querySelector("#ops-limits-info").addEventListener("click", () => infoPopup(t("ops_limits_info")));
    body.querySelectorAll("[data-legacy]").forEach((row) =>
      row.addEventListener("click", () => openDecisionSheet(legacy.items.find((i) => i.customer_id === Number(row.dataset.legacy)), canDecide))
    );
    body.querySelector("#ops-review-limits").addEventListener("click", () => openLimitsSheet(limits));
  }

  function legacyRowHtml(r) {
    const facts = [
      r.balance0_amd >= r.debt_amd * 0.5 ? `${t("ops_opening")} ${groupDigits(r.balance0_amd)}` : "",
      r.never_paid ? t("ops_never_paid") : "",
      !r.ever_ordered ? t("ops_never_ordered") : r.still_buying ? t("ops_still_buying") : "",
      r.oldest_unpaid_days != null ? `${r.oldest_unpaid_days} ${t("ops_days")}` : "",
    ].filter(Boolean);
    return `<button type="button" class="ops-row" data-legacy="${r.customer_id}">
      <span class="ops-row-main"><strong>${escapeHtml(r.name)}</strong><span class="muted">${escapeHtml([r.sales_channel, r.rep_name].filter(Boolean).join(" · "))}</span><span class="muted ops-facts">${facts.map(escapeHtml).join(" · ")}</span></span>
      <span class="ops-row-side"><strong class="ops-amount">${groupDigits(r.debt_amd)}</strong>${r.decision ? `<span class="badge ${DECISION_BADGE[r.decision]}">${t(`ops_dec_${r.decision}`)}</span>` : `<span class="badge badge-neutral">${t("ops_dec_none")}</span>`}</span>
    </button>`;
  }

  function infoPopup(html) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet"><p>${escapeHtml(html)}</p><div class="sheet-actions"><button type="button" class="btn btn-primary" data-close>${t("done")}</button></div></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => (e.target === overlay || e.target.closest("[data-close]")) && overlay.remove());
  }

  // ---- decision sheet for one account ----
  function openDecisionSheet(r, canDecide) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    let decision = r.decision;
    const paint = () => {
      overlay.innerHTML = `<div class="sheet ops-sheet">
        <h2>${escapeHtml(r.name)}</h2>
        <p class="muted">${formatAmd(r.debt_amd)} · ${escapeHtml([r.sales_channel, r.rep_name].filter(Boolean).join(" · "))}</p>
        <p class="muted ops-facts">${t("ops_opening")} ${groupDigits(r.balance0_amd)}${r.last_payment_date ? ` · ${t("ops_last_payment")} ${r.last_payment_date}` : ` · ${t("ops_never_paid")}`}</p>
        <div class="ops-decisions" role="radiogroup">${DECISIONS.map((d) => `<button type="button" class="ops-decision${decision === d ? " is-on" : ""}" data-decision="${d}" role="radio" aria-checked="${decision === d}" ${canDecide ? "" : "disabled"}><strong>${t(`ops_dec_${d}`)}</strong><span class="muted">${t(`ops_dec_${d}_hint`)}</span></button>`).join("")}</div>
        <textarea class="vg-text" id="ops-note" rows="2" maxlength="500" placeholder="${t("ops_note_placeholder")}" ${canDecide ? "" : "disabled"}>${escapeHtml(r.note ?? "")}</textarea>
        ${canDecide ? "" : `<p class="muted">${t("ops_read_only")}</p>`}
        <p class="form-error" id="ops-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" data-close>${t("cancel")}</button>
          ${canDecide && r.decision ? `<button type="button" class="btn" id="ops-clear">${t("ops_remove_decision")}</button>` : ""}
          ${canDecide ? `<button type="button" class="btn btn-primary" id="ops-save" ${decision ? "" : "disabled"}>${t("save")}</button>` : ""}
        </div>
      </div>`;
      overlay.querySelectorAll("[data-decision]").forEach((b) => b.addEventListener("click", () => {
        decision = b.dataset.decision;
        r.note = overlay.querySelector("#ops-note").value;
        paint();
      }));
      const save = async (value) => {
        try {
          await api.opsDecideLegacy(r.customer_id, value, overlay.querySelector("#ops-note")?.value ?? "");
          overlay.remove();
          showToast(t("vg_saved"));
          load();
        } catch (err) {
          const el = overlay.querySelector("#ops-error");
          el.textContent = err.message;
          el.hidden = false;
        }
      };
      overlay.querySelector("#ops-save")?.addEventListener("click", () => save(decision));
      overlay.querySelector("#ops-clear")?.addEventListener("click", () => save(null));
    };
    paint();
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => (e.target === overlay || e.target.closest("[data-close]")) && overlay.remove());
  }

  // ---- credit limit suggestions ----
  function openLimitsSheet(limits) {
    const rows = limits.suggestions.map((s) => ({ ...s, value: s.suggested_amd, on: !s.over_now }));
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet ops-sheet">
      <h2>${t("ops_limits_title")}</h2>
      <p class="muted">${t("ops_limits_sheet_hint")}</p>
      <div class="ops-limit-list">${rows
        .map(
          (r, i) => `<div class="ops-limit-row${r.over_now ? " is-over" : ""}" data-i="${i}">
            <label class="ops-limit-pick"><input type="checkbox" ${r.on ? "checked" : ""} ${limits.can_apply ? "" : "disabled"} aria-label="${escapeHtml(r.name)}" /></label>
            <span class="ops-limit-main"><strong>${escapeHtml(r.name)}</strong><span class="muted">${escapeHtml([r.sales_channel, r.rep_name].filter(Boolean).join(" · "))} · ${t("ops_avg_month")} ${groupDigits(r.monthly_avg_amd)}${r.has_history ? "" : ` · ${t("ops_no_history")}`}</span>${r.over_now ? `<span class="ops-over">${t("ops_debt_over").replace("{debt}", groupDigits(r.debt_amd))}</span>` : r.debt_amd ? `<span class="muted">${t("ops_debt")} ${groupDigits(r.debt_amd)}</span>` : ""}</span>
            <input class="oc-field amd-input ops-limit-input" inputmode="numeric" ${limits.can_apply ? "" : "disabled"} aria-label="${t("ops_limit")}" />
          </div>`
        )
        .join("")}</div>
      <p class="form-error" id="ops-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-close>${t("cancel")}</button>
        ${limits.can_apply ? `<button type="button" class="btn btn-primary" id="ops-apply"></button>` : ""}
      </div>
    </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => (e.target === overlay || e.target.closest("[data-close]")) && overlay.remove());
    const applyBtn = overlay.querySelector("#ops-apply");
    const refresh = () => {
      const n = rows.filter((r) => r.on).length;
      if (applyBtn) {
        applyBtn.textContent = t("ops_apply_n").replace("{n}", String(n));
        applyBtn.disabled = n === 0;
      }
    };
    overlay.querySelectorAll(".ops-limit-row").forEach((el) => {
      const r = rows[Number(el.dataset.i)];
      const field = bindAmdInput(el.querySelector(".ops-limit-input"), () => (r.value = field.get() ?? 0));
      field.set(r.value);
      el.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
        r.on = e.target.checked;
        refresh();
      });
    });
    refresh();
    applyBtn?.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        const { applied, skipped } = await api.opsApplyCreditLimits(rows.filter((r) => r.on).map((r) => ({ customer_id: r.customer_id, limit: r.value })));
        overlay.remove();
        showToast(t("ops_applied").replace("{n}", String(applied)).replace("{s}", String(skipped)));
        load();
      } catch (err) {
        const el = overlay.querySelector("#ops-error");
        el.textContent = err.message;
        el.hidden = false;
        applyBtn.disabled = false;
      }
    });
  }

  load();
}
