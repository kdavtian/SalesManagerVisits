// Admin management of Bonus challenge templates (docs/bonuses-design.md,
// Phase 4/8). A guided multi-step wizard, same pattern as
// routePlans.js's openNewRoutePlanFlow (one sheet body re-rendered per
// step rather than one long form) -- this replaces the Phase 4 single-form
// dialog now that the module has shipped and the product-sales target
// picker (the one type this dialog couldn't create before) is worth
// building. The API payload shape is unchanged from Phase 4.
import { api } from "../api.js";
import { activateDialog, escapeHtml, formatDateTime } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { ALL_ROLES } from "../quickActions.js";

const TYPE_LABELS = { single_metric: "Single metric", balanced_basket: "Balanced basket", product_sales: "Product sales" };
const TYPE_HINTS = {
  single_metric: "Reach one target (e.g. 5 strawberries) to complete the challenge.",
  balanced_basket: "Reach every target listed to complete the challenge -- partial progress on some doesn't count.",
  product_sales: "Sell a target quantity of specific products.",
};
const STATUS_BADGE = { draft: "badge-neutral", published: "badge-success", cancelled: "badge-danger" };
const METRICS = ["strawberry", "carrot", "apple", "cherry", "points"];
const RECURRENCE_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly", once: "One-off" };
const FIRST_ROUND_POLICY_LABELS = {
  publish_forward: "Start today",
  scheduled_future: "Start on a scheduled date",
  historical_explicit: "Exact date range",
};
const ROLE_LABELS = {
  admin: "Admin",
  ceo: "CEO",
  sales_director: "Sales director",
  sales_manager: "Sales manager",
  warehouse_manager: "Warehouse manager",
  delivery_manager: "Delivery manager",
  accountant: "Accountant",
};

export async function renderBonusChallengesSection(container) {
  container.innerHTML = `
    <div id="challenge-template-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap">
      <button type="button" class="btn btn-block" id="add-challenge-template-btn">+ New Challenge</button>
    </div>
  `;
  const listEl = container.querySelector("#challenge-template-list");
  container.querySelector("#add-challenge-template-btn").addEventListener("click", () => openNewChallengeWizard(loadTemplates));

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

// The guided "New Challenge" creation flow: basics, then type-specific
// rules (metric targets, or a product search-and-pick for product_sales),
// then schedule/reward, then audience, then a review step that actually
// submits -- each step replaces the sheet body, same wizard shape as
// routePlans.js's openNewRoutePlanFlow. State accumulates in one plain
// object (`draft`) across steps rather than re-reading the DOM at submit
// time, since later steps (product search results, role vs. user picker)
// aren't all present in the DOM at once.
const STEP_COUNT = 5;

async function openNewChallengeWizard(onSaved) {
  const users = await api.listUsers();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>New Challenge</h2>
      <p class="muted" id="challenge-wizard-step-label"></p>
      <div id="challenge-wizard-step-body"></div>
      <p class="form-error" id="challenge-wizard-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="challenge-wizard-back">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="challenge-wizard-next">${t("next")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const stepLabelEl = overlay.querySelector("#challenge-wizard-step-label");
  const stepBodyEl = overlay.querySelector("#challenge-wizard-step-body");
  const errorEl = overlay.querySelector("#challenge-wizard-error");
  const backBtn = overlay.querySelector("#challenge-wizard-back");
  const nextBtn = overlay.querySelector("#challenge-wizard-next");

  const draft = {
    title: "",
    description: "",
    type: "single_metric",
    targets: [{ metric: "strawberry", amount: 1 }],
    productTargets: [], // { productId, productNameSnapshot, productUnitSnapshot, targetPieces }
    recurrence: "weekly",
    validationGraceDays: 7,
    firstRoundPolicy: "publish_forward",
    scheduledStartAt: "",
    customStartDate: "",
    customEndDate: "",
    rewardAmd: "",
    watermelonPointValue: "",
    audienceMode: "selected_users",
    audienceUserIds: [],
    audienceRoles: [],
  };
  let step = 1;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function renderStep() {
    errorEl.hidden = true;
    stepLabelEl.textContent = `Step ${step} of ${STEP_COUNT}`;
    backBtn.textContent = step === 1 ? t("cancel") : t("back");
    nextBtn.textContent = step === STEP_COUNT ? "Create draft" : t("next");
    if (step === 1) renderBasicsStep();
    else if (step === 2) renderRulesStep();
    else if (step === 3) renderScheduleStep();
    else if (step === 4) renderAudienceStep();
    else renderReviewStep();
  }

  function renderBasicsStep() {
    stepBodyEl.innerHTML = `
      <label>Title<input id="w-title" type="text" maxlength="200" value="${escapeHtml(draft.title)}" /></label>
      <label>Description (optional)<textarea id="w-description" rows="2">${escapeHtml(draft.description)}</textarea></label>
      <label>Type
        <select id="w-type">
          ${Object.keys(TYPE_LABELS)
            .map((v) => `<option value="${v}" ${draft.type === v ? "selected" : ""}>${TYPE_LABELS[v]}</option>`)
            .join("")}
        </select>
      </label>
      <p class="muted" id="w-type-hint">${TYPE_HINTS[draft.type]}</p>
    `;
    const typeSelect = stepBodyEl.querySelector("#w-type");
    typeSelect.addEventListener("change", () => {
      stepBodyEl.querySelector("#w-type-hint").textContent = TYPE_HINTS[typeSelect.value];
    });
  }

  function renderRulesStep() {
    if (draft.type === "product_sales") {
      renderProductTargetsStep();
      return;
    }
    stepBodyEl.innerHTML = `
      <p class="settings-form-label">Targets</p>
      <div id="w-targets-list"></div>
      ${draft.type === "balanced_basket" ? `<button type="button" class="btn-link" id="w-add-target">+ add target</button>` : ""}
    `;
    const targetsListEl = stepBodyEl.querySelector("#w-targets-list");

    function addRow(target) {
      const row = document.createElement("div");
      row.className = "target-row";
      row.style.display = "flex";
      row.style.gap = "8px";
      row.innerHTML = `
        <select class="target-metric">${METRICS.map((m) => `<option value="${m}" ${target.metric === m ? "selected" : ""}>${m}</option>`).join("")}</select>
        <input class="target-value" type="number" min="0.5" step="0.5" placeholder="amount" value="${target.amount || ""}" />
        ${draft.type === "balanced_basket" ? `<button type="button" class="btn-link btn-link-danger" data-action="remove-target">✕</button>` : ""}
      `;
      const removeBtn = row.querySelector('[data-action="remove-target"]');
      if (removeBtn) removeBtn.addEventListener("click", () => row.remove());
      targetsListEl.appendChild(row);
    }
    // single_metric only ever shows/keeps one row, even if the draft still
    // carries extra targets from an earlier visit as balanced_basket.
    const targetsToShow = draft.type === "balanced_basket" ? draft.targets : draft.targets.slice(0, 1);
    targetsToShow.forEach(addRow);
    if (!targetsToShow.length) addRow({ metric: METRICS[0], amount: "" });
    const addBtn = stepBodyEl.querySelector("#w-add-target");
    if (addBtn) addBtn.addEventListener("click", () => addRow({ metric: METRICS[0], amount: "" }));
  }

  function renderProductTargetsStep() {
    stepBodyEl.innerHTML = `
      <p class="settings-form-label">Product targets</p>
      <input id="w-product-search" type="text" placeholder="Search products by name/SKU/brand" />
      <div id="w-product-results" class="card-list" style="max-height:160px;overflow:auto;"></div>
      <div id="w-product-targets-list" style="margin-top:10px;"></div>
    `;
    const searchEl = stepBodyEl.querySelector("#w-product-search");
    const resultsEl = stepBodyEl.querySelector("#w-product-results");
    const targetsListEl = stepBodyEl.querySelector("#w-product-targets-list");

    function renderPicked() {
      targetsListEl.innerHTML = draft.productTargets.length
        ? draft.productTargets
            .map(
              (p, i) => `
        <div class="target-row" style="display:flex;align-items:center;gap:8px;">
          <span style="flex:1;">${escapeHtml(p.productNameSnapshot)}${p.productUnitSnapshot ? ` <span class="muted">(${escapeHtml(p.productUnitSnapshot)})</span>` : ""}</span>
          <input class="product-target-pieces" type="number" min="1" step="1" value="${p.targetPieces}" data-index="${i}" style="width:80px;" />
          <button type="button" class="btn-link btn-link-danger" data-action="remove-product" data-index="${i}">✕</button>
        </div>
      `
            )
            .join("")
        : `<p class="empty-state">No products added yet.</p>`;
      targetsListEl.querySelectorAll(".product-target-pieces").forEach((input) => {
        input.addEventListener("input", () => {
          draft.productTargets[Number(input.dataset.index)].targetPieces = Number(input.value);
        });
      });
      targetsListEl.querySelectorAll('[data-action="remove-product"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          draft.productTargets.splice(Number(btn.dataset.index), 1);
          renderPicked();
        });
      });
    }
    renderPicked();

    let searchSeq = 0;
    async function search(query) {
      if (!query) {
        resultsEl.innerHTML = "";
        return;
      }
      const seq = ++searchSeq;
      resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      let products;
      try {
        products = await api.listProducts(query);
      } catch (err) {
        if (seq === searchSeq) resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      if (seq !== searchSeq) return;
      const available = products.filter((p) => !draft.productTargets.some((t) => t.productId === p.id));
      resultsEl.innerHTML = available.length
        ? available
            .slice(0, 20)
            .map(
              (p) => `<button type="button" class="card" style="text-align:left; width:100%;" data-product-id="${p.id}" data-name="${escapeHtml(p.name)}" data-unit="${escapeHtml(p.unit ?? "")}">${escapeHtml(p.name)}${p.unit ? ` <span class="muted">(${escapeHtml(p.unit)})</span>` : ""}</button>`
            )
            .join("")
        : `<p class="empty-state">No matching products.</p>`;
      resultsEl.querySelectorAll("[data-product-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          draft.productTargets.push({
            productId: Number(btn.dataset.productId),
            productNameSnapshot: btn.dataset.name,
            productUnitSnapshot: btn.dataset.unit || null,
            targetPieces: 1,
          });
          renderPicked();
          searchEl.value = "";
          resultsEl.innerHTML = "";
        });
      });
    }
    let debounceTimer = null;
    searchEl.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => search(searchEl.value.trim()), 200);
    });
  }

  function renderScheduleStep() {
    stepBodyEl.innerHTML = `
      <label>Recurrence
        <select id="w-recurrence">
          ${Object.keys(RECURRENCE_LABELS)
            .map((v) => `<option value="${v}" ${draft.recurrence === v ? "selected" : ""}>${RECURRENCE_LABELS[v]}</option>`)
            .join("")}
        </select>
      </label>
      <div id="w-once-fields"></div>
      <label>Validation grace period (days)<input id="w-grace" type="number" min="1" value="${draft.validationGraceDays}" /></label>
      <label>Cash reward (AMD, optional)<input id="w-reward" type="number" min="1" value="${escapeHtml(String(draft.rewardAmd))}" /></label>
      <label>Watermelon points (optional)<input id="w-watermelon" type="number" min="1" value="${escapeHtml(String(draft.watermelonPointValue))}" /></label>
    `;
    const recurrenceSelect = stepBodyEl.querySelector("#w-recurrence");
    const onceFieldsEl = stepBodyEl.querySelector("#w-once-fields");

    function renderOnceFields() {
      if (recurrenceSelect.value !== "once") {
        onceFieldsEl.innerHTML = "";
        return;
      }
      onceFieldsEl.innerHTML = `
        <label>Start policy
          <select id="w-first-round-policy">
            ${Object.keys(FIRST_ROUND_POLICY_LABELS)
              .map((v) => `<option value="${v}" ${draft.firstRoundPolicy === v ? "selected" : ""}>${FIRST_ROUND_POLICY_LABELS[v]}</option>`)
              .join("")}
          </select>
        </label>
        <div id="w-first-round-subfields"></div>
      `;
      const policySelect = onceFieldsEl.querySelector("#w-first-round-policy");
      const subfieldsEl = onceFieldsEl.querySelector("#w-first-round-subfields");
      function renderSubfields() {
        if (policySelect.value === "scheduled_future") {
          subfieldsEl.innerHTML = `<label>Scheduled start<input id="w-scheduled-start" type="datetime-local" value="${escapeHtml(draft.scheduledStartAt)}" /></label>`;
        } else if (policySelect.value === "historical_explicit") {
          subfieldsEl.innerHTML = `
            <label>Start date<input id="w-custom-start" type="date" value="${escapeHtml(draft.customStartDate)}" /></label>
            <label>End date<input id="w-custom-end" type="date" value="${escapeHtml(draft.customEndDate)}" /></label>
          `;
        } else {
          subfieldsEl.innerHTML = `<p class="muted">The round starts today and covers the rest of the day.</p>`;
        }
      }
      policySelect.addEventListener("change", renderSubfields);
      renderSubfields();
    }
    recurrenceSelect.addEventListener("change", renderOnceFields);
    renderOnceFields();
  }

  function renderAudienceStep() {
    stepBodyEl.innerHTML = `
      <label>Audience
        <select id="w-audience-mode">
          <option value="selected_users" ${draft.audienceMode === "selected_users" ? "selected" : ""}>Specific people</option>
          <option value="selected_roles" ${draft.audienceMode === "selected_roles" ? "selected" : ""}>Whole role(s)</option>
        </select>
      </label>
      <div id="w-audience-picker"></div>
    `;
    const modeSelect = stepBodyEl.querySelector("#w-audience-mode");
    const pickerEl = stepBodyEl.querySelector("#w-audience-picker");

    function renderPicker() {
      if (modeSelect.value === "selected_roles") {
        pickerEl.innerHTML = `
          <div class="card-list" style="max-height:200px;overflow:auto;">
            ${ALL_ROLES.map(
              (r) => `<label class="user-row" style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" class="w-audience-role" value="${r}" ${draft.audienceRoles.includes(r) ? "checked" : ""} />
                <span>${ROLE_LABELS[r] ?? r}</span>
              </label>`
            ).join("")}
          </div>
        `;
      } else {
        pickerEl.innerHTML = `
          <div class="card-list" style="max-height:200px;overflow:auto;">
            ${users
              .map(
                (u) => `<label class="user-row" style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" class="w-audience-user" value="${u.id}" ${draft.audienceUserIds.includes(u.id) ? "checked" : ""} />
                <span>${escapeHtml(u.name)} <span class="muted">(${escapeHtml(u.role)})</span></span>
              </label>`
              )
              .join("")}
          </div>
        `;
      }
    }
    modeSelect.addEventListener("change", renderPicker);
    renderPicker();
  }

  function renderReviewStep() {
    const targetsSummary =
      draft.type === "product_sales"
        ? draft.productTargets.map((p) => `${p.productNameSnapshot} x${p.targetPieces}`).join(", ") || "none"
        : draft.targets.map((t) => `${t.amount} ${t.metric}`).join(", ") || "none";
    const audienceSummary =
      draft.audienceMode === "selected_roles"
        ? draft.audienceRoles.map((r) => ROLE_LABELS[r] ?? r).join(", ") || "none"
        : `${draft.audienceUserIds.length} ${draft.audienceUserIds.length === 1 ? "person" : "people"}`;
    stepBodyEl.innerHTML = `
      <div class="card-list">
        <div class="card"><strong>${escapeHtml(draft.title)}</strong><div class="muted">${TYPE_LABELS[draft.type]} · ${RECURRENCE_LABELS[draft.recurrence]}</div></div>
        <div class="card"><div class="muted">Targets</div>${escapeHtml(targetsSummary)}</div>
        <div class="card"><div class="muted">Audience</div>${escapeHtml(audienceSummary)}</div>
        <div class="card"><div class="muted">Reward</div>${draft.rewardAmd ? `${Number(draft.rewardAmd).toLocaleString()} AMD` : "No cash reward"}${draft.watermelonPointValue ? ` · ${draft.watermelonPointValue} watermelon points` : ""}</div>
      </div>
      <p class="muted">This creates a draft -- publish it from the list once you're ready for it to start generating rounds.</p>
    `;
  }

  function readBasicsStep() {
    draft.title = stepBodyEl.querySelector("#w-title").value.trim();
    draft.description = stepBodyEl.querySelector("#w-description").value.trim();
    draft.type = stepBodyEl.querySelector("#w-type").value;
    if (!draft.title) return "Title is required.";
    return null;
  }

  function readRulesStep() {
    if (draft.type === "product_sales") {
      if (!draft.productTargets.length) return "Add at least one product.";
      for (const p of draft.productTargets) {
        if (!Number.isInteger(p.targetPieces) || p.targetPieces <= 0) return `${p.productNameSnapshot}'s target quantity must be a positive whole number.`;
      }
      return null;
    }
    const rows = [...stepBodyEl.querySelectorAll(".target-row")];
    const targets = rows.map((row) => ({
      metric: row.querySelector(".target-metric").value,
      amount: Number(row.querySelector(".target-value").value),
    }));
    if (!targets.length || targets.some((t) => !t.amount || t.amount <= 0)) return "Every target needs a positive amount.";
    if (draft.type === "single_metric" && targets.length !== 1) return "Single metric challenges take exactly one target.";
    draft.targets = targets;
    return null;
  }

  function readScheduleStep() {
    draft.recurrence = stepBodyEl.querySelector("#w-recurrence").value;
    draft.validationGraceDays = Number(stepBodyEl.querySelector("#w-grace").value);
    draft.rewardAmd = stepBodyEl.querySelector("#w-reward").value;
    draft.watermelonPointValue = stepBodyEl.querySelector("#w-watermelon").value;
    if (!Number.isInteger(draft.validationGraceDays) || draft.validationGraceDays <= 0) return "Validation grace period must be a positive number of days.";
    if (draft.recurrence === "once") {
      draft.firstRoundPolicy = stepBodyEl.querySelector("#w-first-round-policy")?.value ?? "publish_forward";
      if (draft.firstRoundPolicy === "scheduled_future") {
        draft.scheduledStartAt = stepBodyEl.querySelector("#w-scheduled-start")?.value ?? "";
        if (!draft.scheduledStartAt) return "Pick a scheduled start date/time.";
      } else if (draft.firstRoundPolicy === "historical_explicit") {
        draft.customStartDate = stepBodyEl.querySelector("#w-custom-start")?.value ?? "";
        draft.customEndDate = stepBodyEl.querySelector("#w-custom-end")?.value ?? "";
        if (!draft.customStartDate || !draft.customEndDate) return "Pick both a start and end date.";
      }
    }
    return null;
  }

  function readAudienceStep() {
    if (draft.audienceMode !== stepBodyEl.querySelector("#w-audience-mode").value) {
      draft.audienceMode = stepBodyEl.querySelector("#w-audience-mode").value;
    }
    if (draft.audienceMode === "selected_roles") {
      draft.audienceRoles = [...stepBodyEl.querySelectorAll(".w-audience-role:checked")].map((el) => el.value);
      if (!draft.audienceRoles.length) return "Select at least one role.";
    } else {
      draft.audienceUserIds = [...stepBodyEl.querySelectorAll(".w-audience-user:checked")].map((el) => Number(el.value));
      if (!draft.audienceUserIds.length) return "Select at least one person.";
    }
    return null;
  }

  async function submit() {
    const payload = {
      title: draft.title,
      description: draft.description || null,
      type: draft.type,
      audienceMode: draft.audienceMode,
      recurrence: draft.recurrence,
      validationGraceDays: draft.validationGraceDays,
      rewardAmd: draft.rewardAmd ? Number(draft.rewardAmd) : null,
      watermelonPointValue: draft.watermelonPointValue ? Number(draft.watermelonPointValue) : null,
    };
    if (draft.audienceMode === "selected_roles") payload.audienceRoles = draft.audienceRoles;
    else payload.audienceUserIds = draft.audienceUserIds;
    if (draft.type === "product_sales") {
      payload.productTargets = draft.productTargets;
    } else {
      // Real quantities (e.g. 2.5 carrots) get scale-2'd to match
      // bonusUnits.js's server-side convention -- the form takes 0.5
      // steps, the API takes the already-scaled integer.
      payload.targets = draft.targets.map((t) => ({ metric: t.metric, targetScaled: Math.round(t.amount * 2) }));
    }
    if (draft.recurrence === "once") {
      payload.firstRoundPolicy = draft.firstRoundPolicy;
      if (draft.firstRoundPolicy === "scheduled_future") {
        payload.scheduledStartAt = new Date(draft.scheduledStartAt).toISOString();
      } else if (draft.firstRoundPolicy === "historical_explicit") {
        payload.customStartDate = draft.customStartDate;
        payload.customEndDate = draft.customEndDate;
      }
    }
    await api.createChallengeTemplate(payload);
  }

  backBtn.addEventListener("click", () => {
    if (step === 1) {
      overlay.remove();
      return;
    }
    step -= 1;
    renderStep();
  });

  nextBtn.addEventListener("click", async () => {
    const readStep = { 1: readBasicsStep, 2: readRulesStep, 3: readScheduleStep, 4: readAudienceStep }[step];
    if (readStep) {
      const error = readStep();
      if (error) {
        showError(error);
        return;
      }
    }
    if (step < STEP_COUNT) {
      step += 1;
      renderStep();
      return;
    }
    nextBtn.disabled = true;
    try {
      await submit();
      overlay.remove();
      onSaved();
    } catch (err) {
      showError(err.message);
    } finally {
      nextBtn.disabled = false;
    }
  });

  renderStep();
}

// Reward claim review/payout (docs/bonuses-design.md, Phase 5). Server-side
// role checks are the real authorization; the role checks here only decide
// which action buttons this viewer even sees, matching roles.js's
// canApproveBonusRewards (admin/ceo/accountant) and canRecordBonusPayouts
// (admin/accountant) without duplicating those as importable client
// predicates for just this one screen.
const CLAIM_STATUS_BADGE = { awaiting_validation: "badge-neutral", approved: "badge-info", on_hold: "badge-neutral", rejected: "badge-danger", paid: "badge-success" };

function canApproveBonusRewardsClient() {
  return ["admin", "ceo", "accountant"].includes(state.user?.role);
}
function canRecordBonusPayoutsClient() {
  return ["admin", "accountant"].includes(state.user?.role);
}

export async function renderBonusRewardClaimsSection(container) {
  container.innerHTML = `<div id="reward-claims-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const listEl = container.querySelector("#reward-claims-list");
  const canApprove = canApproveBonusRewardsClient();
  const canPay = canRecordBonusPayoutsClient();

  async function loadClaims() {
    const claims = await api.listBonusRewardClaims();
    listEl.innerHTML = claims.length
      ? claims
          .map(
            (c) => `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${Number(c.amount_amd).toLocaleString()} AMD</strong>
              <span class="muted">round #${c.round_id}${c.hold_reason ? ` · ${escapeHtml(c.hold_reason)}` : ""}${c.rejection_reason ? ` · ${escapeHtml(c.rejection_reason)}` : ""}</span>
            </div>
            <span class="badge ${CLAIM_STATUS_BADGE[c.status] ?? "badge-neutral"}">${escapeHtml(c.status)}</span>
          </div>
          <div class="user-row-meta">
            <span class="muted">${formatDateTime(c.created_at)}${c.payment_reference ? ` · ref ${escapeHtml(c.payment_reference)}` : ""}</span>
            <span class="user-row-actions">
              ${canApprove && ["awaiting_validation", "on_hold"].includes(c.status) ? `<button class="btn-link" data-action="approve" data-id="${c.id}" data-version="${c.version}">Approve</button>` : ""}
              ${canApprove && ["awaiting_validation", "on_hold"].includes(c.status) ? `<button class="btn-link btn-link-danger" data-action="reject" data-id="${c.id}" data-version="${c.version}">Reject</button>` : ""}
              ${canApprove && c.status === "awaiting_validation" ? `<button class="btn-link" data-action="hold" data-id="${c.id}" data-version="${c.version}">Hold</button>` : ""}
              ${canPay && c.status === "approved" ? `<button class="btn-link" data-action="pay" data-id="${c.id}" data-version="${c.version}">Record payout</button>` : ""}
            </span>
          </div>
        </div>
      `
          )
          .join("")
      : `<p class="empty-state">No reward claims.</p>`;

    listEl.querySelectorAll('[data-action="approve"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.approveBonusRewardClaim(btn.dataset.id, Number(btn.dataset.version));
          loadClaims();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    listEl.querySelectorAll('[data-action="reject"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reason = prompt("Reason:") ?? "";
        try {
          await api.rejectBonusRewardClaim(btn.dataset.id, reason, Number(btn.dataset.version));
          loadClaims();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    listEl.querySelectorAll('[data-action="hold"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reason = prompt("Reason:") ?? "";
        try {
          await api.holdBonusRewardClaim(btn.dataset.id, reason, Number(btn.dataset.version));
          loadClaims();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    listEl.querySelectorAll('[data-action="pay"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const paymentReference = prompt("Payment reference (optional):") ?? "";
        try {
          await api.payBonusRewardClaim(btn.dataset.id, paymentReference, Number(btn.dataset.version));
          loadClaims();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  await loadClaims();
}
