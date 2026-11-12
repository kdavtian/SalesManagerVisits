// Admin > Sales directions (owner, 2026-11-12: "let me add a new sales direction on the admin panel"). Every direction with its manager and
// its rules, a "+ New direction" button and an edit sheet. The rules were names in the code before; now a new direction gets them here
// (server: team/routes/salesChannels.js, migration 204).
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { activateDialog, escapeHtml, loadSalesChannels, showToast } from "../../util.js";
import { ownsSalesChannels } from "../../shared/roles.js";

const VISIT_TYPES = ["sm", "cvo", "pco", "oem", "cas", "kf"];

function ruleChips(c) {
  const chips = [];
  if (!c.active) chips.push(["sc_inactive", "badge-danger"]);
  chips.push([c.visit_mode === "no_visit" ? "sc_visit_no" : "sc_visit_field", "badge-neutral"]);
  chips.push([{ visit: "sc_debt_visit", call: "sc_debt_call", none: "sc_debt_none" }[c.debt_mode], "badge-neutral"]);
  chips.push([{ rep: "sc_comm_rep", trade: "sc_comm_trade", none: "sc_comm_none" }[c.commission_kind], "badge-neutral"]);
  if (c.separate_plan) chips.push(["sc_separate_plan", "badge-info"]);
  if (c.director_report_excluded) chips.push(["sc_report_excluded", "badge-warning"]);
  return chips.map(([key, cls]) => `<span class="badge ${cls}">${escapeHtml(t(key))}</span>`).join(" ");
}

export async function renderSalesChannelsSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let channels;
  let managers;
  async function load() {
    const [list, users] = await Promise.all([api.listSalesChannels(), api.listUsers()]);
    channels = list;
    // a direction's manager: an active sales manager, sales director or accountant (the server checks the same)
    managers = users.filter((u) => ownsSalesChannels(u.role) && (u.status ?? "active") === "active");
    loadSalesChannels(async () => list); // every dropdown of the app sees the change at once
  }
  try {
    await load();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  function managerOptions(selectedId, current) {
    const list = [...managers];
    // the current manager stays visible even when paused / left, so opening the card never hides who it is
    if (selectedId && !list.some((u) => u.id === selectedId) && current) list.push({ id: selectedId, name: `${current} (${t("sc_manager_inactive")})` });
    return `<option value="">${t("unassigned")}</option>${list.map((u) => `<option value="${u.id}" ${u.id === selectedId ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}`;
  }

  function render() {
    container.innerHTML = `
      <p class="muted radius-help">${t("sc_hint")}</p>
      <button type="button" class="btn btn-primary btn-has-icon" id="sc-add">${icons.plus}${t("sc_add")}</button>
      <div id="sc-list" class="card-list" style="margin-top:12px;">
        ${channels
          .map(
            (c) => `
          <div class="card sc-card ${c.active ? "" : "sc-row-inactive"}">
            <div class="sc-card-top">
              <div class="sc-card-title">
                <strong>${escapeHtml(c.name)}</strong>
                <span class="muted">${c.name !== c.code ? `${escapeHtml(c.code)} · ` : ""}${t("sc_customers").replace("{n}", c.customer_count)}</span>
              </div>
              <button type="button" class="icon-btn" data-edit="${c.id}" aria-label="${t("sc_edit")} ${escapeHtml(c.name)}">${icons.pencil}</button>
            </div>
            <div class="sc-chips">${ruleChips(c)}</div>
            <label class="sc-manager">${t("assigned_manager")}
              <select data-manager="${c.id}">${managerOptions(c.manager_user_id, c.manager_name)}</select>
            </label>
            <p class="form-error" id="sc-error-${c.id}" hidden></p>
          </div>`
          )
          .join("")}
      </div>`;
    container.querySelector("#sc-add").addEventListener("click", () => openEditor(null));
    container.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditor(channels.find((c) => c.id === Number(b.dataset.edit)))));
    container.querySelectorAll("select[data-manager]").forEach((select) => {
      select.addEventListener("change", async () => {
        const id = Number(select.dataset.manager);
        const errorEl = container.querySelector(`#sc-error-${id}`);
        errorEl.hidden = true;
        select.disabled = true;
        try {
          await api.updateSalesChannel(id, { manager_user_id: select.value ? Number(select.value) : null });
          await load();
          showToast(t("saved"));
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        } finally {
          select.disabled = false;
        }
      });
    });
  }

  function openEditor(c) {
    const isNew = !c;
    const v = c ?? { code: "", name: "", active: true, owner_role: "sales_director", visit_mode: "field", debt_mode: "visit", separate_plan: false, cash_source: "", commission_kind: "rep", visit_type_key: "sm", route_autofill: true, director_report_excluded: false, manager_user_id: null, display_order: "" };
    const opt = (value, current, key) => `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(t(key))}</option>`;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet sc-sheet">
        <h2>${t(isNew ? "sc_new_title" : "sc_edit_title")}</h2>
        <form id="sc-form" novalidate>
          <label>${t("sc_code")}
            <input name="code" value="${escapeHtml(v.code)}" ${isNew ? "required" : "disabled"} maxlength="40" autocomplete="off" autocapitalize="off" />
            <span class="muted sc-field-hint">${t(isNew ? "sc_code_hint" : "sc_code_locked")}</span>
          </label>
          <label>${t("sc_name")}<input name="name" value="${escapeHtml(v.name)}" maxlength="60" required /></label>
          <div>
            <label>${t("sc_owner")}
              <select name="owner_role">${opt("sales_director", v.owner_role, "sc_owner_director")}${opt("accountant", v.owner_role, "sc_owner_accountant")}</select>
            </label>
          </div>
          <div>
            <label>${t("sc_order")}<input name="display_order" type="number" inputmode="numeric" min="0" value="${escapeHtml(String(v.display_order ?? ""))}" placeholder="${t("sc_order_auto")}" /></label>
          </div>
          <label>${t("assigned_manager")}<select name="manager_user_id">${managerOptions(v.manager_user_id, v.manager_name)}</select></label>
          <h3 class="visit-detail-section-title">${t("sc_rules")}</h3>
          <label>${t("sc_visits")}
            <select name="visit_mode">${opt("field", v.visit_mode, "sc_visit_field_long")}${opt("no_visit", v.visit_mode, "sc_visit_no_long")}</select>
          </label>
          <label>${t("sc_debt")}
            <select name="debt_mode">${opt("visit", v.debt_mode, "sc_debt_visit")}${opt("call", v.debt_mode, "sc_debt_call")}${opt("none", v.debt_mode, "sc_debt_none")}</select>
          </label>
          <label>${t("sc_commission")}
            <select name="commission_kind">${opt("rep", v.commission_kind, "sc_comm_rep_long")}${opt("trade", v.commission_kind, "sc_comm_trade_long")}${opt("none", v.commission_kind, "sc_comm_none")}</select>
          </label>
          <div class="form-row-2">
            <label>${t("sc_visit_type")}
              <select name="visit_type_key">${VISIT_TYPES.map((k) => `<option value="${k}" ${k === v.visit_type_key ? "selected" : ""}>${k.toUpperCase()}</option>`).join("")}</select>
            </label>
            <label>${t("sc_cash_source")}<input name="cash_source" value="${escapeHtml(v.cash_source ?? "")}" maxlength="40" placeholder="Cash" /></label>
          </div>
          <label class="checkbox-row"><input type="checkbox" name="separate_plan" ${v.separate_plan ? "checked" : ""} /> <span>${t("sc_separate_plan_long")}</span></label>
          <label class="checkbox-row"><input type="checkbox" name="route_autofill" ${v.route_autofill ? "checked" : ""} /> <span>${t("sc_route_autofill")}</span></label>
          <label class="checkbox-row"><input type="checkbox" name="director_report_excluded" ${v.director_report_excluded ? "checked" : ""} /> <span>${t("sc_report_excluded_long")}</span></label>
          ${isNew ? "" : `<label class="checkbox-row"><input type="checkbox" name="active" ${v.active ? "checked" : ""} /> <span>${t("sc_active")}</span></label>`}
          <p class="form-error" id="sc-form-error" hidden></p>
          <div class="sheet-actions sheet-actions-floating">
            <button type="button" class="btn" data-cancel>${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    const form = overlay.querySelector("#sc-form");
    const errorEl = overlay.querySelector("#sc-form-error");
    // a direction that is not visited has nobody to visit for its debts either: "by visit" is offered as "by call" instead
    form.visit_mode.addEventListener("change", () => {
      if (form.visit_mode.value === "no_visit" && form.debt_mode.value === "visit") form.debt_mode.value = "call";
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const f = new FormData(form);
      const body = {
        name: String(f.get("name") ?? "").trim(),
        owner_role: f.get("owner_role"),
        manager_user_id: f.get("manager_user_id") ? Number(f.get("manager_user_id")) : null,
        visit_mode: f.get("visit_mode"),
        debt_mode: f.get("debt_mode"),
        commission_kind: f.get("commission_kind"),
        visit_type_key: f.get("visit_type_key"),
        cash_source: String(f.get("cash_source") ?? "").trim() || null,
        separate_plan: form.separate_plan.checked,
        route_autofill: form.route_autofill.checked,
        director_report_excluded: form.director_report_excluded.checked,
      };
      const order = String(f.get("display_order") ?? "").trim();
      if (order) body.display_order = Number(order);
      if (!isNew) body.active = form.active.checked;
      if (isNew) body.code = String(f.get("code") ?? "").trim();
      if (isNew && !body.code) {
        errorEl.textContent = t("sc_code_required");
        errorEl.hidden = false;
        return;
      }
      if (!body.name) body.name = body.code ?? v.name;
      // turning a direction off while customers are still in it: they keep it (nothing is moved), but no new customer can get it
      if (!isNew && v.active && !body.active && v.customer_count > 0 && !confirm(t("sc_deactivate_confirm").replace("{n}", v.customer_count))) return;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        if (isNew) await api.createSalesChannel(body);
        else await api.updateSalesChannel(v.id, body);
        await load();
        close();
        render();
        showToast(t("saved"));
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submit.disabled = false;
      }
    });
  }

  render();
}
