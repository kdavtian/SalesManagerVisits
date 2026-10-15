// Operations control (Vaghinak -> quick actions): the operations director's console. Each card answers: which decision, who
// takes it, which action follows. Tabs: Cash (legacy balances, credit limits), Margin (price realization, USD/AMD),
// Stock (dead stock actions), Customers (win-back result), Flow (order step timing), Data (scorecard, Excel upload).
import { api } from "../api.js";
import { state } from "../state.js";
import { t } from "../i18n.js";
import { activateDialog, escapeHtml, formatAmd, groupDigits, bindAmdInput, showToast } from "../util.js";

const DECIDE_ROLES = new Set(["admin", "ceo", "operations_director"]);
const DECISIONS = ["collect", "restructure", "dispute", "legal", "write_off"];
const DECISION_BADGE = { collect: "badge-warning", restructure: "badge-info", dispute: "badge-neutral", legal: "badge-danger", write_off: "badge-neutral" };

export async function renderOpsControl(root, navigate, startTab) {
  const tabs = [["cash", "ops_tab_cash"], ["margin", "ops_tab_margin"], ["stock", "ops_tab_stock"], ["customers", "ops_tab_customers"], ["flow", "ops_tab_flow"], ["data", "ops_tab_data"]];
  let tab = tabs.some(([k]) => k === startTab) ? startTab : "cash";
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
      else if (tab === "margin") await paintMargin();
      else if (tab === "stock") await paintStock();
      else if (tab === "customers") await paintCustomers();
      else if (tab === "flow") await paintFlow();
      else if (tab === "data") await paintData();
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

  // ---------------- Margin: price realization + USD/AMD ----------------
  let marginDays = 90;
  async function paintMargin() {
    const { realization, fx, can_set_fx: canSetFx } = await api.opsMargin(marginDays);
    const pctCls = (v, floor) => (v == null ? "" : v < floor ? "ops-bad" : "");
    const driftTxt = fx.current ? `${fx.drift_pct > 0 ? "+" : ""}${fx.drift_pct}%` : "";
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_fx_title")}</h2><button type="button" class="settings-hint-icon" id="ops-fx-info" aria-label="${t("more_info")}">!</button></div>
        ${
          fx.current
            ? `<p class="ops-sum"><strong>${fx.current.rate}</strong> <span class="muted">AMD / USD · ${t("ops_fx_since_review")}: ${fx.baseline.rate} → <span class="${fx.needs_review ? "ops-bad" : ""}">${driftTxt}</span></span></p>`
            : `<p class="muted">${t("ops_fx_none")}</p>`
        }
        ${fx.needs_review ? `<p class="order-stock-warning order-stock-danger">${t("ops_fx_needs_review").replace("{pct}", String(fx.review_pct))}</p><button type="button" class="btn btn-primary btn-block" id="ops-fx-done">${t("ops_fx_review_done")}</button>` : ""}
        ${canSetFx ? `<div class="ops-fx-row"><input id="ops-fx-input" class="oc-field ops-fx-input" inputmode="decimal" placeholder="${t("ops_fx_placeholder")}" aria-label="${t("ops_fx_title")}" /><button type="button" class="btn" id="ops-fx-save">${t("save")}</button></div>` : ""}
      </section>
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_real_title")}</h2><button type="button" class="settings-hint-icon" id="ops-real-info" aria-label="${t("more_info")}">!</button></div>
        <div class="oc-chips">${[30, 90, 180].map((d) => `<button type="button" class="map-filter-chip${d === marginDays ? " chip-active" : ""}" data-days="${d}">${d} ${t("ops_days")}</button>`).join("")}</div>
        <p class="ops-sum"><strong>${realization.total.realization_pct ?? "–"}%</strong> <span class="muted">${t("ops_realization")}</span> · <strong>${realization.total.margin_pct ?? "–"}%</strong> <span class="muted">${t("ops_margin")}</span></p>
        <div class="ops-table-wrap"><table class="ops-table">
          <tr><th></th><th>${t("ops_revenue")}</th><th>${t("ops_realization_short")}</th><th>${t("ops_margin")}</th><th>${t("ops_below_short")}</th></tr>
          ${realization.channels.map((c) => `<tr><th scope="row">${escapeHtml(c.channel)}</th><td>${groupDigits(c.revenue_amd)}</td><td class="${pctCls(c.realization_pct, 85)}">${c.realization_pct ?? "–"}%</td><td class="${pctCls(c.margin_pct, 25)}">${c.margin_pct ?? "–"}%</td><td class="${c.below_landing_lines ? "ops-bad" : ""}">${c.below_landing_lines || "–"}</td></tr>`).join("")}
        </table></div>
      </section>
      <section class="card ops-card">
        <h2>${t("ops_below_title")}</h2>
        ${realization.below_landing.length ? `<div class="ops-list">${realization.below_landing.map((w) => `<div class="ops-row ops-static"><span class="ops-row-main"><strong>${escapeHtml(w.product)}</strong><span class="muted">${escapeHtml(w.customer)} · ${escapeHtml(w.channel)} · ${w.order_date}</span><span class="muted ops-facts">${groupDigits(w.price)} < ${groupDigits(w.landing)} × ${w.qty}</span></span><span class="ops-row-side"><strong class="ops-amount ops-bad">−${groupDigits(w.loss)}</strong></span></div>`).join("")}</div>` : `<p class="empty-state">${t("ops_none_below")}</p>`}
      </section>`;
    body.querySelector("#ops-fx-info").addEventListener("click", () => infoPopup(t("ops_fx_info")));
    body.querySelector("#ops-real-info").addEventListener("click", () => infoPopup(t("ops_real_info")));
    body.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => { marginDays = Number(b.dataset.days); load(); }));
    body.querySelector("#ops-fx-save")?.addEventListener("click", async () => {
      const rate = Number(body.querySelector("#ops-fx-input").value.replace(",", "."));
      try { await api.opsSetFx(rate); showToast(t("vg_saved")); load(); } catch (err) { showToast(err.message); }
    });
    body.querySelector("#ops-fx-done")?.addEventListener("click", async () => {
      try { await api.opsFxReviewDone(); showToast(t("vg_saved")); load(); } catch (err) { showToast(err.message); }
    });
  }

  // ---------------- Stock: dead stock ----------------
  const STOCK_ACTIONS = ["campaign", "bundle", "discount", "transfer", "keep"];
  async function paintStock() {
    const data = await api.opsStock();
    const shown = data.items.slice(0, 40);
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_stock_title")}</h2><button type="button" class="settings-hint-icon" id="ops-stock-info" aria-label="${t("more_info")}">!</button></div>
        <p class="ops-sum"><strong>${formatAmd(data.total_landing_amd)}</strong> <span class="muted">· ${data.items.length} SKU · ${t("ops_at_silver")} ${groupDigits(data.total_silver_amd)}</span></p>
        <p class="muted ops-undecided">${data.undecided ? `${t("ops_undecided")}: ${data.undecided}` : t("ops_all_decided")}</p>
        <div class="ops-list">${shown.map((r) => `<button type="button" class="ops-row" data-stock="${r.product_id}"><span class="ops-row-main"><strong>${escapeHtml(r.name)}</strong><span class="muted">${escapeHtml([r.brand, r.unit].filter(Boolean).join(" · "))} · ${r.stock_qty} ${t("ops_pcs")}</span><span class="muted ops-facts">${r.last_sale ? `${t("ops_last_sale")} ${r.days_since_sale} ${t("ops_days")}` : t("ops_never_sold")}</span></span><span class="ops-row-side"><strong class="ops-amount">${groupDigits(r.value_landing_amd)}</strong>${r.action ? `<span class="badge badge-info">${t(`ops_act_${r.action}`)}</span>` : `<span class="badge badge-neutral">${t("ops_dec_none")}</span>`}</span></button>`).join("") || `<p class="empty-state">${t("ops_nothing")}</p>`}</div>
        ${data.items.length > shown.length ? `<p class="muted ops-more">${t("ops_showing_top").replace("{n}", String(shown.length))}</p>` : ""}
      </section>`;
    body.querySelector("#ops-stock-info").addEventListener("click", () => infoPopup(t("ops_stock_info")));
    body.querySelectorAll("[data-stock]").forEach((row) => row.addEventListener("click", () => openStockSheet(data.items.find((i) => i.product_id === Number(row.dataset.stock)), data.can_decide)));
  }

  async function openStockSheet(r, canDecide) {
    let assignees = [];
    try { assignees = await api.listTaskAssignees(); } catch { assignees = []; }
    let action = r.action;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    const paint = () => {
      overlay.innerHTML = `<div class="sheet ops-sheet">
        <h2>${escapeHtml(r.name)}</h2>
        <p class="muted">${r.stock_qty} ${t("ops_pcs")} · ${formatAmd(r.value_landing_amd)} · ${r.last_sale ? `${t("ops_last_sale")} ${r.days_since_sale} ${t("ops_days")}` : t("ops_never_sold")}</p>
        <div class="ops-decisions" role="radiogroup">${STOCK_ACTIONS.map((a) => `<button type="button" class="ops-decision${action === a ? " is-on" : ""}" data-action="${a}" role="radio" aria-checked="${action === a}" ${canDecide ? "" : "disabled"}><strong>${t(`ops_act_${a}`)}</strong><span class="muted">${t(`ops_act_${a}_hint`)}</span></button>`).join("")}</div>
        ${action && action !== "keep" ? `<label class="vg-field"><span>${t("ops_assign_to")}</span><select id="ops-assignee" class="task-control">${assignees.map((a) => `<option value="${a.id}" ${a.id === r.assignee_id ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}</select></label>
        <label class="vg-field"><span>${t("ops_due")}</span><input type="date" id="ops-due" value="${r.due_date ?? ""}" /></label>` : ""}
        <textarea class="vg-text" id="ops-note" rows="2" maxlength="300" placeholder="${t("ops_note_placeholder")}" ${canDecide ? "" : "disabled"}>${escapeHtml(r.note ?? "")}</textarea>
        <p class="form-error" id="ops-error" hidden></p>
        <div class="sheet-actions"><button type="button" class="btn" data-close>${t("cancel")}</button>${canDecide ? `<button type="button" class="btn btn-primary" id="ops-save" ${action ? "" : "disabled"}>${t("save")}</button>` : ""}</div>
      </div>`;
      overlay.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => { r.note = overlay.querySelector("#ops-note").value; action = b.dataset.action; paint(); }));
      overlay.querySelector("#ops-save")?.addEventListener("click", async () => {
        try {
          await api.opsStockAction(r.product_id, { action, note: overlay.querySelector("#ops-note").value, due_date: overlay.querySelector("#ops-due")?.value || null, assignee_id: Number(overlay.querySelector("#ops-assignee")?.value) || null });
          overlay.remove();
          showToast(t("vg_saved"));
          load();
        } catch (err) {
          const el = overlay.querySelector("#ops-error");
          el.textContent = err.message;
          el.hidden = false;
        }
      });
    };
    paint();
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => (e.target === overlay || e.target.closest("[data-close]")) && overlay.remove());
  }

  // ---------------- Customers: win-back ----------------
  async function paintCustomers() {
    const d = await api.opsCustomers();
    const rowsHtml = (list) => list.map((e) => `<tr><th scope="row">${escapeHtml(e.label)}</th><td>${e.created}</td><td>${e.done}</td><td>${e.returned}</td><td>${groupDigits(e.returned_amd)}</td></tr>`).join("");
    const head = `<tr><th></th><th>${t("ops_wb_created")}</th><th>${t("ops_wb_done")}</th><th>${t("ops_wb_returned")}</th><th>${t("ops_wb_amount")}</th></tr>`;
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_wb_title")}</h2><button type="button" class="settings-hint-icon" id="ops-wb-info" aria-label="${t("more_info")}">!</button></div>
        <p class="ops-sum"><strong>${d.lapsed_customers}</strong> <span class="muted">${t("ops_wb_lapsed")} · ${d.active_customers} ${t("ops_wb_active")}</span></p>
        <p class="muted ops-undecided">${t("ops_wb_at_stake")}: ${formatAmd(d.lapsed_year_amd)}</p>
      </section>
      <section class="card ops-card"><h2>${t("ops_wb_by_week")}</h2>
        ${d.by_week.length ? `<div class="ops-table-wrap"><table class="ops-table">${head}${rowsHtml(d.by_week)}</table></div>` : `<p class="empty-state">${t("ops_wb_none")}</p>`}</section>
      <section class="card ops-card"><h2>${t("ops_wb_by_rep")}</h2>
        ${d.by_rep.length ? `<div class="ops-table-wrap"><table class="ops-table">${head}${rowsHtml(d.by_rep)}</table></div>` : `<p class="empty-state">${t("ops_wb_none")}</p>`}</section>`;
    body.querySelector("#ops-wb-info").addEventListener("click", () => infoPopup(t("ops_wb_info")));
  }

  // ---------------- Flow: order step timing ----------------
  let flowDays = 30;
  async function paintFlow() {
    const d = await api.opsFlow(flowDays);
    const stepCard = (key) => {
      const s = d.steps[key];
      return `<div class="ops-step"><span class="muted">${t(`ops_step_${key}`)}</span><strong>${s ? `${s.p50_h} ${t("ops_h")}` : "–"}</strong><span class="muted ops-facts">${s ? `P90 ${s.p90_h} ${t("ops_h")} · n=${s.n}` : ""}</span><span class="muted ops-facts">SLA ${d.sla[key]} ${t("ops_h")}</span></div>`;
    };
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_flow_title")}</h2><button type="button" class="settings-hint-icon" id="ops-flow-info" aria-label="${t("more_info")}">!</button></div>
        <div class="oc-chips">${[7, 30, 90].map((x) => `<button type="button" class="map-filter-chip${x === flowDays ? " chip-active" : ""}" data-days="${x}">${x} ${t("ops_days")}</button>`).join("")}</div>
        <div class="ops-steps">${["confirm", "pack", "deliver"].map(stepCard).join("")}</div>
      </section>
      ${effortCardHtml(d.effort)}
      <section class="card ops-card">
        <h2>${t("ops_waiting_title")} <span class="muted">(${d.waiting_count}${d.over_sla_count ? ` · ${d.over_sla_count} ${t("ops_over_sla")}` : ""})</span></h2>
        ${d.waiting.length ? `<div class="ops-list">${d.waiting.map((w) => `<button type="button" class="ops-row" data-order="${w.id}"><span class="ops-row-main"><strong>${escapeHtml(w.customer_name)}</strong><span class="muted">${escapeHtml(w.order_code ?? "")} · ${t(`ops_step_${w.step}`)}${w.blocked_by ? ` · ${t(`ops_blocked_${w.blocked_by}`)}` : ""}</span></span><span class="ops-row-side"><strong class="ops-amount">${groupDigits(w.total_amd)}</strong><span class="badge ${w.over_sla ? "badge-danger" : "badge-neutral"}">${w.waiting_h} ${t("ops_h")}</span></span></button>`).join("")}</div>` : `<p class="empty-state">${t("ops_nothing")}</p>`}
      </section>`;
    body.querySelector("#ops-flow-info").addEventListener("click", () => infoPopup(t("ops_flow_info")));
    body.querySelector("#ops-effort-info")?.addEventListener("click", () => infoPopup(t("ops_effort_info")));
    body.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => { flowDays = Number(b.dataset.days); load(); }));
    body.querySelectorAll("[data-order]").forEach((b) => b.addEventListener("click", async () => (await import("../orderDetailSheet.js")).openOrderDetailSheet(Number(b.dataset.order), { onChanged: load, navigate })));
  }

  // How long the reps take to make an order and how they start it (measured on the device). The decision it feeds:
  // a shortcut that does not make orders faster or shorter is cut.
  function effortCardHtml(e) {
    if (!e) return "";
    const line = (x) => (x?.n ? `${x.median_seconds ?? "–"} ${t("ops_sec")} · ${x.median_taps ?? "–"} ${t("ops_taps")}` : "–");
    const delta =
      e.current.n && e.previous.n && e.current.median_seconds != null && e.previous.median_seconds != null
        ? e.current.median_seconds - e.previous.median_seconds
        : null;
    return `<section class="card ops-card">
      <div class="ops-card-head"><h2>${t("ops_effort_title")}</h2><button type="button" class="settings-hint-icon" id="ops-effort-info" aria-label="${t("more_info")}">!</button></div>
      <p class="ops-sum"><strong>${line(e.current)}</strong> <span class="muted">n=${e.current.n}${
        delta == null ? "" : ` · <span class="${delta <= 0 ? "ops-good" : "ops-bad"}">${delta > 0 ? "+" : ""}${delta} ${t("ops_sec")} ${t("ops_vs_before")}</span>`
      }</span></p>
      <div class="ops-list">${["new", "usual", "repeat"]
        .map((k) => `<div class="ops-row ops-static"><span class="ops-row-main"><strong>${t(`ops_src_${k}`)}</strong><span class="muted ops-facts">n=${e.by_source[k].n}</span></span><span class="ops-row-side"><strong class="ops-amount">${line(e.by_source[k])}</strong></span></div>`)
        .join("")}</div>
      <p class="muted ops-facts">${t("ops_usual_share")}: ${e.usual_share_pct == null ? "–" : `${e.usual_share_pct}%`}</p>
    </section>`;
  }

  // ---------------- Data: scorecard + Excel upload ----------------
  async function paintData() {
    const d = await api.opsData();
    const ex = d.excel;
    const sorted = [...d.checks].sort((a, b) => (b.severity === "fix") - (a.severity === "fix") || b.count - a.count);
    body.innerHTML = `
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_excel_title")}</h2></div>
        <p class="ops-sum"><span class="badge ${ex.today_synced ? "badge-success" : "badge-danger"}">${ex.today_synced ? t("ops_excel_today") : t("ops_excel_missing")}</span> <span class="muted">${ex.synced_at ? `${t("ops_excel_last")}: ${String(ex.synced_at).slice(0, 16).replace("T", " ")} (${ex.hours_ago} ${t("ops_h")})` : t("ops_excel_never")}</span></p>
      </section>
      <section class="card ops-card">
        <div class="ops-card-head"><h2>${t("ops_data_title")}</h2><button type="button" class="settings-hint-icon" id="ops-data-info" aria-label="${t("more_info")}">!</button></div>
        <p class="ops-sum"><strong>${d.fix_count}</strong> <span class="muted">${t("ops_data_to_fix")}</span></p>
        <div class="ops-list">${sorted.map((c) => `<div class="ops-row ops-static"><span class="ops-row-main"><strong>${t(`ops_chk_${c.key}`)}</strong>${c.samples.length ? `<span class="muted ops-facts">${c.samples.map(escapeHtml).join(", ")}</span>` : ""}</span><span class="ops-row-side"><span class="badge ${c.count === 0 ? "badge-success" : c.severity === "fix" ? "badge-danger" : "badge-neutral"}">${c.count}</span></span></div>`).join("")}</div>
      </section>`;
    body.querySelector("#ops-data-info").addEventListener("click", () => infoPopup(t("ops_data_info")));
  }

  load();
}
