// Admin management of Bonus challenge templates (docs/bonuses-design.md,
// Phase 4). Single-form create dialog rather than the multi-step wizard
// pattern used elsewhere (routePlans.js's openNewRoutePlanFlow) -- a
// deliberate scope simplification for this phase, noted in
// docs/bonuses-design.md; the fields themselves are unchanged, so a later
// pass can split this into steps without touching the API calls.
import { api } from "../api.js";
import { activateDialog, escapeHtml, formatDateTime } from "../util.js";
import { t } from "../i18n.js";

const TYPE_LABELS = { single_metric: "Single metric", balanced_basket: "Balanced basket", product_sales: "Product sales" };
const STATUS_BADGE = { draft: "badge-neutral", published: "badge-success", cancelled: "badge-danger" };
const METRICS = ["strawberry", "carrot", "apple", "cherry", "points"];

export async function renderBonusChallengesSection(container) {
  container.innerHTML = `
    <div id="challenge-template-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap">
      <button type="button" class="btn btn-block" id="add-challenge-template-btn">+ New Challenge</button>
    </div>
  `;
  const listEl = container.querySelector("#challenge-template-list");
  container.querySelector("#add-challenge-template-btn").addEventListener("click", () => openTemplateSheet(loadTemplates));

  async function loadTemplates() {
    const templates = await api.listChallengeTemplates();
    listEl.innerHTML = templates.length
      ? templates
          .map(
            (tpl) => `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(tpl.title)}</strong>
              <span class="muted">${TYPE_LABELS[tpl.type] ?? tpl.type} · ${escapeHtml(tpl.recurrence)}</span>
            </div>
            <span class="badge ${STATUS_BADGE[tpl.status] ?? "badge-neutral"}">${escapeHtml(tpl.status)}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">
              ${tpl.reward_amd ? `${Number(tpl.reward_amd).toLocaleString()} AMD` : "No cash reward"}
              ${tpl.watermelon_point_value ? ` · ${tpl.watermelon_point_value} watermelon points` : ""}
              · created ${formatDateTime(tpl.created_at)}
            </span>
            <span class="user-row-actions">
              ${tpl.status === "draft" ? `<button class="btn-link" data-action="publish" data-id="${tpl.id}">Publish</button>` : ""}
              ${tpl.status !== "cancelled" ? `<button class="btn-link btn-link-danger" data-action="cancel" data-id="${tpl.id}" data-title="${escapeHtml(tpl.title)}">Cancel</button>` : ""}
            </span>
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="empty-state">No challenge templates yet.</p>`;

    listEl.querySelectorAll('[data-action="publish"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.publishChallengeTemplate(btn.dataset.id);
          loadTemplates();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    listEl.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Cancel "${btn.dataset.title}"?`)) return;
        const reason = prompt("Reason (optional):") ?? "";
        await api.cancelChallengeTemplate(btn.dataset.id, reason);
        loadTemplates();
      });
    });
  }

  await loadTemplates();
}

async function openTemplateSheet(onSaved) {
  const users = await api.listUsers();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>New Challenge</h2>
      <form id="challenge-template-form">
        <label>Title<input name="title" type="text" required maxlength="200" /></label>
        <label>Type
          <select name="type" required>
            <option value="single_metric">Single metric</option>
            <option value="balanced_basket">Balanced basket (all components required)</option>
          </select>
        </label>
        <!-- product_sales challenges (exact SKU counts) need a product-target
             picker this first pass doesn't have yet -- create those via the
             API directly for now; see docs/bonuses-design.md's Phase 4
             scope note. Omitted here rather than offered with no way to
             attach product targets, which would only ever 400. -->
        <label>Recurrence
          <select name="recurrence" required>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="once">One-off</option>
          </select>
        </label>
        <label>Validation grace period (days)<input name="validationGraceDays" type="number" min="1" value="7" required /></label>
        <label>Cash reward (AMD, optional)<input name="rewardAmd" type="number" min="1" /></label>
        <label>Watermelon points (optional)<input name="watermelonPointValue" type="number" min="1" /></label>

        <div id="challenge-targets-section">
          <p class="settings-form-label">Targets</p>
          <div id="targets-list"></div>
          <button type="button" class="btn-link" id="add-target-row">+ add target</button>
        </div>

        <p class="settings-form-label">Audience</p>
        <div id="audience-list" class="card-list" style="max-height:200px;overflow:auto;">
          ${users
            .map(
              (u) => `<label class="user-row" style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" name="audienceUserIds" value="${u.id}" />
                <span>${escapeHtml(u.name)} <span class="muted">(${escapeHtml(u.role)})</span></span>
              </label>`
            )
            .join("")}
        </div>

        <p class="form-error" id="challenge-form-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="close-challenge-sheet">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">Create draft</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.querySelector("#close-challenge-sheet").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const targetsListEl = overlay.querySelector("#targets-list");
  function addTargetRow() {
    const row = document.createElement("div");
    row.className = "target-row";
    row.style.display = "flex";
    row.style.gap = "8px";
    row.innerHTML = `
      <select class="target-metric">${METRICS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
      <input class="target-value" type="number" min="0.5" step="0.5" placeholder="amount" required />
      <button type="button" class="btn-link btn-link-danger" data-action="remove-target">✕</button>
    `;
    row.querySelector('[data-action="remove-target"]').addEventListener("click", () => row.remove());
    targetsListEl.appendChild(row);
  }
  overlay.querySelector("#add-target-row").addEventListener("click", addTargetRow);
  addTargetRow();

  const form = overlay.querySelector("#challenge-template-form");
  const errorEl = overlay.querySelector("#challenge-form-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const fd = new FormData(form);
    const audienceUserIds = fd.getAll("audienceUserIds").map(Number);
    if (!audienceUserIds.length) {
      errorEl.textContent = "Select at least one person.";
      errorEl.hidden = false;
      return;
    }
    // Real quantities (e.g. 2.5 carrots) get scale-2'd to match
    // bonusUnits.js's server-side convention -- the form takes 0.5 steps,
    // the API takes the already-scaled integer.
    const targets = [...targetsListEl.querySelectorAll(".target-row")].map((row) => ({
      metric: row.querySelector(".target-metric").value,
      targetScaled: Math.round(Number(row.querySelector(".target-value").value) * 2),
    }));

    try {
      await api.createChallengeTemplate({
        title: fd.get("title"),
        type: fd.get("type"),
        audienceMode: "selected_users",
        audienceUserIds,
        recurrence: fd.get("recurrence"),
        validationGraceDays: Number(fd.get("validationGraceDays")),
        rewardAmd: fd.get("rewardAmd") ? Number(fd.get("rewardAmd")) : null,
        watermelonPointValue: fd.get("watermelonPointValue") ? Number(fd.get("watermelonPointValue")) : null,
        targets,
      });
      overlay.remove();
      onSaved();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
