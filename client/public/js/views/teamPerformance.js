import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, seesAllPerformance, isPerfCeo, canEditChannelPlan, canReviewPerfPlan } from "../state.js";

const BRANDS = ["castrol", "lotos", "royal"];
const PACE_COLOR = {
  excellent: "success",
  on_track: "accent",
  slightly_behind: "warning",
  at_risk: "danger",
};

function currentMonthStart() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = String(monthStr).slice(0, 10).split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthPickerHtml(month) {
  return `
    <div class="perf-month-picker">
      <button type="button" class="icon-btn" id="perf-month-prev" aria-label="Previous month">${"‹"}</button>
      <strong>${escapeHtml(formatMonthLabel(month))}</strong>
      <button type="button" class="icon-btn" id="perf-month-next" aria-label="Next month">${"›"}</button>
    </div>
  `;
}

function wireMonthPicker(root, month, onChange) {
  root.querySelector("#perf-month-prev").addEventListener("click", () => onChange(shiftMonth(month, -1)));
  root.querySelector("#perf-month-next").addEventListener("click", () => onChange(shiftMonth(month, 1)));
}

function statusBadgeHtml(status) {
  if (!status) return "";
  const color = PACE_COLOR[status] || "accent";
  return `<span class="perf-status-badge perf-status-${color}">${t(`perf_pace_${status}`)}</span>`;
}

// One KPI's numbers -- target/actual/achievement/status/forecast/required
// rate -- rendered the same way everywhere it appears (channel card, my
// performance, dashboard row), so the shape only needs describing once.
function kpiBlockHtml(label, kpi, { isAmd = true, unit = "" } = {}) {
  if (!kpi) return "";
  const fmt = (v) => (v == null ? "—" : isAmd ? formatAmd(Math.round(v)) : `${Math.round(v).toLocaleString()}${unit}`);
  const pct = kpi.achievement_pct != null ? Math.round(kpi.achievement_pct * 100) : null;
  return `
    <div class="perf-kpi-block">
      <div class="perf-kpi-head">
        <span class="perf-kpi-label">${label}</span>
        ${statusBadgeHtml(kpi.status)}
      </div>
      <div class="perf-kpi-main">
        <span class="perf-kpi-actual">${fmt(kpi.actual)}</span>
        <span class="perf-kpi-target muted">/ ${fmt(kpi.target)} ${pct != null ? `(${pct}%)` : ""}</span>
      </div>
      ${kpi.target ? `<div class="progress-bar perf-kpi-bar"><div class="progress-bar-fill" style="width:${Math.min(100, Math.max(0, (kpi.actual / kpi.target) * 100))}%"></div></div>` : ""}
      <div class="perf-kpi-foot muted">
        ${kpi.forecast != null ? `${t("perf_forecast")}: ${fmt(kpi.forecast)}` : ""}
        ${kpi.required_daily_rate != null && kpi.required_daily_rate > 0 ? ` · ${t("perf_required_daily_rate")}: ${fmt(kpi.required_daily_rate)}` : ""}
      </div>
    </div>
  `;
}

const REC_ICON = { high: "⛔", medium: "⚠️", info: "ℹ️" };

function recommendationsHtml(row) {
  if (!row.recommendations?.length) return "";
  return `
    <div class="perf-recommendations">
      ${row.recommendations
        .map((r) => `<p class="perf-recommendation perf-recommendation-${r.severity}">${REC_ICON[r.severity] ?? ""} ${escapeHtml(r.message)}</p>`)
        .join("")}
    </div>
  `;
}

function needsAttentionHtml(items) {
  if (!items?.length) return "";
  return `
    <div class="card perf-needs-attention">
      <strong>${t("perf_needs_attention")}</strong>
      <div class="perf-recommendations">
        ${items
          .map(
            (i) =>
              `<p class="perf-recommendation perf-recommendation-${i.severity}">${REC_ICON[i.severity] ?? ""} <strong>${escapeHtml(i.channel_name)}</strong> — ${escapeHtml(i.message)}</p>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function channelCardHtml(row) {
  const collections = row.collections;
  const canDrill = row.plan_id != null;
  return `
    <div class="card perf-channel-card">
      <div class="perf-channel-head">
        <strong>${escapeHtml(row.channel_name)}</strong>
      </div>
      ${kpiBlockHtml(t("perf_sales"), row.sales)}
      ${kpiBlockHtml(t("perf_collections"), collections)}
      ${
        collections?.pending_amd
          ? `<p class="perf-pending-hint muted${canDrill ? " perf-drill-link" : ""}" ${canDrill ? `data-drill-plan="${row.plan_id}" data-drill-channel="${row.channel_id}" data-drill-kpi="collections_pending"` : ""}>+${formatAmd(Math.round(collections.pending_amd))} ${t("perf_pending_not_recorded")}</p>`
          : ""
      }
      <div class="${canDrill ? "perf-drill-link" : ""}" ${canDrill ? `data-drill-plan="${row.plan_id}" data-drill-channel="${row.channel_id}" data-drill-kpi="new_customers"` : ""}>
        ${kpiBlockHtml(t("perf_new_customers"), row.new_customers, { isAmd: false })}
      </div>
      ${row.brands.map((b) => kpiBlockHtml(`${b.brand[0].toUpperCase()}${b.brand.slice(1)}`, b, { isAmd: false, unit: "L" })).join("")}
      ${recommendationsHtml(row)}
    </div>
  `;
}

function wireDrilldowns(container) {
  container.querySelectorAll("[data-drill-kpi]").forEach((el) => {
    el.addEventListener("click", () => {
      openDrilldownSheet(Number(el.dataset.drillPlan), Number(el.dataset.drillChannel), el.dataset.drillKpi);
    });
  });
}

async function openDrilldownSheet(planId, channelId, kpi) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${kpi === "new_customers" ? t("perf_new_customers") : t("perf_pending_not_recorded")}</h2>
      <div id="perf-drill-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="sheet-actions"><button type="button" class="btn" id="close-perf-drill">${t("cancel")}</button></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.querySelector("#close-perf-drill").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const bodyEl = overlay.querySelector("#perf-drill-body");
  try {
    const rows = await api.getPerfDrilldown(planId, channelId, kpi);
    if (!rows.length) {
      bodyEl.innerHTML = `<p class="empty-state">${t("perf_drill_empty")}</p>`;
      return;
    }
    bodyEl.innerHTML = `<div class="card-list">${rows
      .map((r) =>
        kpi === "new_customers"
          ? `<div class="card"><strong>${escapeHtml(r.customer_name || r.erp_customer_id)}</strong><div class="muted">${escapeHtml(String(r.erp_customer_id))}</div></div>`
          : `<div class="card"><strong>${formatAmd(Number(r.amount_collected_amd))}</strong><div class="muted">${escapeHtml(r.customer_name ?? "")} · ${escapeHtml(r.logged_by)} · ${new Date(r.timestamp).toLocaleDateString()}</div></div>`
      )
      .join("")}</div>`;
  } catch (err) {
    bodyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

export async function renderTeamPerformance(root, navigate) {
  if (seesAllPerformance()) {
    await renderManagementView(root, navigate);
  } else {
    await renderMyPerformanceView(root, navigate);
  }
}

// --- Sales Manager: My Performance -----------------------------------

async function renderMyPerformanceView(root, navigate) {
  let month = currentMonthStart();

  function paintShell() {
    root.innerHTML = `
      <div class="detail-view">
        <div class="detail-header">
          <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="detail-header-title"><h1>${t("my_performance")}</h1></div>
        </div>
        ${monthPickerHtml(month)}
        <div id="perf-body" style="margin-top:12px;"><p class="loading-state" role="status">${t("loading")}</p></div>
      </div>
    `;
    const container = root.querySelector(".detail-view");
    container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
    wireMonthPicker(container, month, (newMonth) => {
      month = newMonth;
      paintShell();
    });
    load();
  }

  async function load() {
    const bodyEl = root.querySelector("#perf-body");
    try {
      const row = await api.getMyPerformance(month);
      bodyEl.innerHTML = row
        ? `<p class="muted" style="margin:0 4px 10px;">${t("perf_working_day_progress").replace("{elapsed}", row.working_days.elapsed).replace("{total}", row.working_days.total)}</p>${channelCardHtml(row)}`
        : `<p class="empty-state">${t("perf_no_plan_yet")}</p>`;
      wireDrilldowns(bodyEl);
    } catch (err) {
      bodyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  paintShell();
}

// --- Management: Overview / Planning / Approvals -----------------------

async function renderManagementView(root, navigate) {
  let month = currentMonthStart();
  let tab = "overview";

  function paintShell() {
    root.innerHTML = `
      <div class="detail-view">
        <div class="detail-header">
          <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="detail-header-title"><h1>${t("team_performance")}</h1></div>
        </div>
        <div class="settings-workspace-tabs" role="tablist">
          <button type="button" class="settings-workspace-tab ${tab === "overview" ? "settings-workspace-tab-active" : ""}" data-tab="overview">${t("perf_overview")}</button>
          <button type="button" class="settings-workspace-tab ${tab === "planning" ? "settings-workspace-tab-active" : ""}" data-tab="planning">${t("perf_planning")}</button>
          <button type="button" class="settings-workspace-tab ${tab === "approvals" ? "settings-workspace-tab-active" : ""}" data-tab="approvals">${t("perf_approvals")}</button>
        </div>
        ${tab !== "approvals" ? monthPickerHtml(month) : ""}
        <div id="perf-body" style="margin-top:12px;"><p class="loading-state" role="status">${t("loading")}</p></div>
      </div>
    `;
    const container = root.querySelector(".detail-view");
    container.querySelector("#back-btn").addEventListener("click", () => navigate("#/dashboard"));
    container.querySelectorAll(".settings-workspace-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        tab = btn.dataset.tab;
        paintShell();
      });
    });
    if (tab !== "approvals") {
      wireMonthPicker(container, month, (newMonth) => {
        month = newMonth;
        paintShell();
      });
    }
    loadTab();
  }

  async function loadTab() {
    const bodyEl = root.querySelector("#perf-body");
    try {
      if (tab === "overview") await loadOverview(bodyEl);
      else if (tab === "planning") await loadPlanning(bodyEl);
      else await loadApprovals(bodyEl);
    } catch (err) {
      bodyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadOverview(bodyEl) {
    const plan = await api.getPerfPlanForMonth(month);
    if (!plan) {
      bodyEl.innerHTML = `<p class="empty-state">${t("perf_no_plan_yet")}</p>`;
      return;
    }
    if (plan.status !== "approved") {
      bodyEl.innerHTML = `<p class="empty-state">${statusBadgeHtml(plan.status === "pending_approval" ? "on_track" : "at_risk")} ${t(`perf_status_${plan.status}`)}</p>`;
      return;
    }
    const dashboard = await api.getPerfDashboard(plan.id);
    bodyEl.innerHTML = `
      <p class="muted" style="margin:0 4px 10px;">${t("perf_working_day_progress").replace("{elapsed}", dashboard.working_days.elapsed).replace("{total}", dashboard.working_days.total)}</p>
      ${needsAttentionHtml(dashboard.needs_attention)}
      ${dashboard.channels.map(channelCardHtml).join("")}
    `;
    wireDrilldowns(bodyEl);
  }

  async function loadPlanning(bodyEl) {
    const plan = await api.getPerfPlanForMonth(month);
    if (!plan) {
      bodyEl.innerHTML = `<button type="button" class="btn btn-primary btn-block" id="perf-new-plan-btn">+ ${t("perf_new_plan")}</button>`;
      bodyEl.querySelector("#perf-new-plan-btn").addEventListener("click", async () => {
        await api.createPerfPlan(month, shiftMonth(month, -1));
        loadTab();
      });
      return;
    }
    renderPlanningGrid(bodyEl, plan);
  }

  function renderPlanningGrid(bodyEl, plan) {
    const targetsByChannel = new Map(plan.targets.map((t) => [t.channel_id, t]));
    const brandTargetsByChannel = new Map();
    for (const bt of plan.brand_targets) {
      if (!brandTargetsByChannel.has(bt.channel_id)) brandTargetsByChannel.set(bt.channel_id, []);
      brandTargetsByChannel.get(bt.channel_id).push(bt);
    }

    api.getPerfChannels().then((channels) => {
      const canSubmit = plan.status === "draft" && plan.targets.length > 0;
      const isRevise = plan.status === "approved" && isPerfCeo();
      bodyEl.innerHTML = `
        <div class="card" style="margin-bottom:10px;">
          <strong>${t(`perf_status_${plan.status}`)}</strong>
          <span class="muted"> · v${plan.version}</span>
        </div>
        <div class="card-list" id="perf-channel-list"></div>
        ${plan.status === "draft" ? `<button type="button" class="btn btn-primary btn-block" id="perf-submit-btn" ${canSubmit ? "" : "disabled"} style="margin-top:12px;">${t("perf_submit_for_approval")}</button>` : ""}
      `;
      const listEl = bodyEl.querySelector("#perf-channel-list");
      listEl.innerHTML = channels
        .map((c) => {
          const target = targetsByChannel.get(c.id);
          const editable = (plan.status === "draft" && canEditChannelPlan(c.owner_role)) || isRevise;
          return `
        <button type="button" class="card settings-list-row" data-channel-id="${c.id}" ${editable ? "" : "disabled"}>
          <span class="settings-row-label">${escapeHtml(c.name)}</span>
          <span class="settings-row-value muted">${target ? formatAmd(Number(target.sales_target_amd)) : "—"}</span>
          ${editable ? `<span class="settings-row-chevron">›</span>` : ""}
        </button>`;
        })
        .join("");

      listEl.querySelectorAll("[data-channel-id]:not([disabled])").forEach((btn) => {
        btn.addEventListener("click", () => {
          const channelId = Number(btn.dataset.channelId);
          const channel = channels.find((c) => c.id === channelId);
          openTargetSheet({
            channel,
            planId: plan.id,
            target: targetsByChannel.get(channelId),
            brandTargets: brandTargetsByChannel.get(channelId) ?? [],
            mode: isRevise ? "revise" : "edit",
            onSaved: () => loadTab(),
          });
        });
      });

      bodyEl.querySelector("#perf-submit-btn")?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.submitPerfPlan(plan.id);
          loadTab();
        } catch (err) {
          alert(err.message);
          e.currentTarget.disabled = false;
        }
      });
    });
  }

  async function loadApprovals(bodyEl) {
    const approvals = await api.getPerfApprovals();
    if (!approvals.length) {
      bodyEl.innerHTML = `<p class="empty-state">${t("perf_no_approvals")}</p>`;
      return;
    }
    bodyEl.innerHTML = approvals
      .map(
        (a) => `
      <button type="button" class="card settings-list-row" data-plan-id="${a.id}">
        <span class="settings-row-label">${escapeHtml(formatMonthLabel(a.month))}<br/><span class="muted">${t("perf_submitted_by")}: ${escapeHtml(a.submitted_by_name)} · ${a.channel_count} ${t("perf_channel_count")}</span></span>
        <span class="settings-row-chevron">›</span>
      </button>`
      )
      .join("");
    bodyEl.querySelectorAll("[data-plan-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const planId = Number(btn.dataset.planId);
        const approval = approvals.find((a) => a.id === planId);
        await openReviewSheet(planId, approval.submitted_by_role, () => loadTab());
      });
    });
  }

  paintShell();
}

// A single channel's sales/collection/new-customer/brand targets, edited
// as one small form -- not a spreadsheet grid, so autosave-per-cell isn't
// needed; one Save call per channel is simple and hard to get wrong.
function openTargetSheet({ channel, planId, target, brandTargets, mode = "edit", onSaved }) {
  const brandValues = new Map(brandTargets.map((bt) => [bt.brand, bt.target_liters]));
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(channel.name)}</h2>
      <form id="perf-target-form">
        <label>${t("perf_sales")}<input type="number" name="sales_target_amd" min="0" value="${target ? Number(target.sales_target_amd) : ""}" /></label>
        <label>${t("perf_collections")}<input type="number" name="collection_target_amd" min="0" value="${target ? Number(target.collection_target_amd) : ""}" /></label>
        <label>${t("perf_new_customers")}<input type="number" name="new_customers_target" min="0" step="1" value="${target ? target.new_customers_target : ""}" /></label>
        ${
          mode === "edit"
            ? BRANDS.map(
                (b) => `<label>${b[0].toUpperCase()}${b.slice(1)} (L)<input type="number" name="brand_${b}" min="0" value="${brandValues.get(b) ?? ""}" /></label>`
              ).join("")
            : ""
        }
        <p class="form-error" id="perf-target-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-perf-target">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${mode === "revise" ? t("perf_revise") : t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-perf-target").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#perf-target-form");
  const errorEl = overlay.querySelector("#perf-target-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');

    if (mode === "revise") {
      const reason = prompt(t("perf_revise_reason_prompt"));
      if (!reason) return;
      submitBtn.disabled = true;
      try {
        await api.revisePerfPlan(planId, reason, [
          {
            channel_id: channel.id,
            sales_target_amd: Number(data.get("sales_target_amd")) || 0,
            collection_target_amd: Number(data.get("collection_target_amd")) || 0,
            new_customers_target: Number(data.get("new_customers_target")) || 0,
          },
        ]);
        close();
        onSaved();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
      return;
    }

    submitBtn.disabled = true;
    try {
      await api.savePerfTargets(planId, channel.id, {
        sales_target_amd: Number(data.get("sales_target_amd")) || 0,
        collection_target_amd: Number(data.get("collection_target_amd")) || 0,
        new_customers_target: Number(data.get("new_customers_target")) || 0,
        brand_targets: BRANDS.map((b) => ({ brand: b, target_liters: Number(data.get(`brand_${b}`)) || 0 })),
      });
      close();
      onSaved();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

async function openReviewSheet(planId, submittedByRole, onDone) {
  const plan = await api.getPerfPlan(planId);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  const canReview = canReviewPerfPlan(submittedByRole);
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${escapeHtml(formatMonthLabel(plan.month))} · v${plan.version}</h2>
      <div class="card-list">
        ${plan.targets
          .map(
            (t) => `
          <div class="card">
            <strong>${escapeHtml(t.channel_name)}</strong>
            <div class="muted">${formatAmd(Number(t.sales_target_amd))} · ${formatAmd(Number(t.collection_target_amd))} · ${t.new_customers_target} new</div>
          </div>`
          )
          .join("")}
      </div>
      <div class="perf-comments">
        <strong>${t("perf_comments") ?? "Comments"}</strong>
        <div class="card-list" id="perf-comment-list">
          ${plan.comments
            .map(
              (c) =>
                `<div class="card"><span class="muted">${escapeHtml(c.author_name)} · ${new Date(c.created_at).toLocaleDateString()}</span><p style="margin:4px 0 0;">${escapeHtml(c.body)}</p></div>`
            )
            .join("") || `<p class="muted" id="perf-no-comments">${t("perf_no_comments") ?? ""}</p>`}
        </div>
        <form id="perf-comment-form" style="display:flex;gap:8px;margin-top:8px;">
          <input type="text" name="body" placeholder="${t("perf_comment_placeholder")}" style="flex:1;" />
          <button type="submit" class="btn">${t("perf_add_comment")}</button>
        </form>
      </div>
      <p class="form-error" id="perf-review-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="cancel-perf-review">${t("cancel")}</button>
        ${canReview ? `<button type="button" class="btn btn-danger" id="perf-review-reject">${t("perf_reject")}</button><button type="button" class="btn btn-primary" id="perf-review-approve">${t("perf_approve")}</button>` : ""}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-perf-review").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  overlay.querySelector("#perf-comment-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.querySelector('input[name="body"]');
    if (!input.value.trim()) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const comment = await api.addPerfComment(planId, input.value.trim());
      const listEl = overlay.querySelector("#perf-comment-list");
      listEl.querySelector("#perf-no-comments")?.remove();
      listEl.insertAdjacentHTML(
        "beforeend",
        `<div class="card"><span class="muted">${escapeHtml(comment.author_name ?? state.user.name)} · ${new Date(comment.created_at).toLocaleDateString()}</span><p style="margin:4px 0 0;">${escapeHtml(comment.body)}</p></div>`
      );
      input.value = "";
    } catch (err) {
      alert(err.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  const errorEl = overlay.querySelector("#perf-review-error");
  overlay.querySelector("#perf-review-approve")?.addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.approvePerfPlan(planId);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      e.currentTarget.disabled = false;
    }
  });
  overlay.querySelector("#perf-review-reject")?.addEventListener("click", async (e) => {
    const reason = prompt(t("perf_reject_reason_prompt"));
    if (!reason) return;
    e.currentTarget.disabled = true;
    try {
      await api.rejectPerfPlan(planId, reason);
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      e.currentTarget.disabled = false;
    }
  });
}
