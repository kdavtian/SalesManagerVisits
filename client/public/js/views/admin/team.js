// Settings > Administration > Team: the user list, the user card and its records sheet (moved out of admin.js with the refactor tool,
// docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { SALES_CHANNELS, activateDialog, escapeHtml, formatAmd, formatDateTime, formatPhoneDisplay, labelColon, openInfoPopup, parseUserAgent, regionLabelHy, showToast } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { state } from "../../state.js";
import { ownsCustomers } from "../../shared/roles.js";
import { REP_COLORS, repColor } from "../../repColors.js";

export const ROLE_BADGE = {
  admin: { key: "role_admin", cls: "badge-accent", tint: "warning" },
  ceo: { key: "role_ceo", cls: "badge-accent", tint: "warning" },
  operations_director: { key: "role_operations_director", cls: "badge-accent", tint: "warning" },
  sales_manager: { key: "role_sales_manager", cls: "badge-neutral", tint: "neutral" },
  sales_director: { key: "role_sales_director", cls: "badge-info", tint: "info" },
  warehouse_manager: { key: "role_warehouse_manager", cls: "badge-info", tint: "info" },
  delivery_manager: { key: "role_delivery_manager", cls: "badge-info", tint: "info" },
  accountant: { key: "role_accountant", cls: "badge-info", tint: "info" },
  // Shown as its own role; the account carries the accountant's permissions (server roles.js ROLE_TITLES, owner 2026-10-27).
  financial_director: { key: "role_financial_director", cls: "badge-accent", tint: "warning" },
};

// The role a person is shown with: their role name (Financial director) when they have one, else their role.
export const shownRole = (u) => u.role_title || u.role;

// One shared option list for every role <select> in this file (new-user
// creation, change-role) -- so adding a role (see ROLE_BADGE above) only
// ever needs to happen in one place, not once per form.
export const ROLE_OPTIONS = ["sales_manager", "sales_director", "warehouse_manager", "delivery_manager", "accountant", "financial_director", "ceo", "operations_director", "admin"];

export function roleOptionsHtml(selected) {
  return ROLE_OPTIONS.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${t(ROLE_BADGE[role].key)}</option>`).join("");
}

export function userInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.slice(0, 2) || "?";
  return initials.toUpperCase();
}

export function salesChannelOptionsHtml(selected) {
  return (
    `<option value="">${t("select_sales_channel")}</option>` +
    SALES_CHANNELS.map((c) => `<option value="${escapeHtml(c)}" ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")
  );
}

export function lastSeenSummary(u) {
  if (!u.last_seen_at) return t("never");
  const device = parseUserAgent(u.last_seen_user_agent) || t("unknown");
  const version = u.last_seen_app_version ? `v${u.last_seen_app_version}` : t("unknown");
  return `${formatDateTime(u.last_seen_at)} · ${version} · ${device}`;
}

export function recordCountRows(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `<div class="connected-records-row"><span>${escapeHtml(t(`record_${key}`))}</span><strong>${n}</strong></div>`)
    .join("");
}

// Same rule as the server (userPurge.js): by NAME only.
export const looksLikeTestUser = (u) => /test|թեստ|тест/i.test(u.name ?? "");

// "Delete a test user with all their data": what goes and what stays, shown BEFORE the (two-tap) delete button.
export function purgeBlockHtml(purge) {
  const d = purge.willDelete;
  const row = (labelKey, value) => `<div class="connected-records-row"><span>${t(labelKey)}</span><strong>${value}</strong></div>`;
  const rows = [
    d.customers && row("purge_customers", d.customers),
    d.checkins && row("purge_checkins", d.checkins),
    d.orders && row("purge_orders", `${d.orders} · ${formatAmd(d.orders_amount_amd)}`),
    d.payments && row("purge_payments", `${d.payments} · ${formatAmd(d.payments_amount_amd)}`),
    d.cash_handoffs && row("purge_cash_handoffs", d.cash_handoffs),
    d.delivery_routes && row("purge_delivery_routes", d.delivery_routes),
    d.cash_expenses && row("purge_cash_expenses", d.cash_expenses),
    d.perf_plans && row("purge_perf_plans", d.perf_plans),
  ].filter(Boolean);
  const keep = [
    [purge.willKeep.customers_with_erp_id_handed_to_you, "purge_keep_erp_customers"],
    [purge.willKeep.customers_only_assigned_unassigned, "purge_keep_assigned"],
    [purge.willKeep.plans_written_for_other_reps_handed_to_you, "purge_keep_plans"],
  ].filter(([n]) => n > 0);
  return `
    <div class="purge-block">
      <h3 class="list-group-heading">${t("purge_title")}</h3>
      <p class="muted">${t("purge_intro")}</p>
      <div class="connected-records-list">${rows.join("") || `<p class="muted">${t("purge_nothing")}</p>`}</div>
      ${keep.length ? `<p class="muted purge-keep">${t("purge_keep_title")}</p><div class="connected-records-list">${keep.map(([n, key]) => row(key, n)).join("")}</div>` : ""}
      <p class="form-error purge-warning">${t("purge_warning")}</p>
      <button type="button" class="btn btn-danger btn-block" id="purge-btn">${t("purge_btn")}</button>
    </div>`;
}

// The one-case escape hatch for a test account that accumulated enough
// check-ins/edit-requests/etc. to permanently 23503 out of DELETE /:id --
// see server/src/team/routes/users.js's AUTO_CLEAR/MUST_RESOLVE for what's safe
// to auto-clear vs. what represents someone else's real record and has to
// be resolved by hand first. `retryDelete` is the caller's own delete
// attempt (already wired to show this sheet again on another 409), so a
// successful clear here can immediately re-attempt it instead of making
// the admin tap "Delete" a second time.
export function openUserRecordsSheet(u, retryDelete, onPurged) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  api.getUserDeletionReport(u.id).then(
    (report) => renderReport(report),
    (err) => {
      overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  );

  function renderReport(report) {
    const willClearRows = recordCountRows(report.willClear);
    const willCascadeRows = recordCountRows(report.willCascade);
    const mustResolveRows = recordCountRows(report.mustResolve);
    const hasAnything = willClearRows || willCascadeRows || mustResolveRows;

    overlay.querySelector(".sheet").innerHTML = `
      <h2>${t("connected_records_title")}</h2>
      <p class="muted">${escapeHtml(u.name)} · ${escapeHtml(u.email)}</p>
      ${report.purgeAllowed ? purgeBlockHtml(report.purge) : ""}
      ${!hasAnything && !report.purgeAllowed ? `<p class="empty-state">${t("connected_records_none")}</p>` : ""}
      ${
        mustResolveRows
          ? `<h3 class="list-group-heading">${t("connected_records_must_resolve")}</h3>
             <p class="muted">${t("connected_records_must_resolve_hint")}</p>
             <div class="connected-records-list">${mustResolveRows}</div>`
          : ""
      }
      ${
        willClearRows
          ? `<h3 class="list-group-heading">${t("connected_records_will_clear")}</h3>
             <div class="connected-records-list">${willClearRows}</div>`
          : ""
      }
      ${
        willCascadeRows
          ? `<h3 class="list-group-heading">${t("connected_records_will_cascade")}</h3>
             <div class="connected-records-list">${willCascadeRows}</div>`
          : ""
      }
      <p class="form-error" id="records-sheet-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="records-sheet-close">${t("done")}</button>
        ${report.canDeleteRecords && willClearRows ? `<button type="button" class="btn btn-danger" id="records-sheet-clear">${t("connected_records_clear_btn")}</button>` : ""}
      </div>
    `;

    overlay.querySelector("#records-sheet-close").addEventListener("click", () => overlay.remove());
    // Two taps on purpose (no confirm() dialog): the first arms the button and shows what it will do, the second deletes.
    const purgeBtn = overlay.querySelector("#purge-btn");
    if (purgeBtn) {
      let armedTimer = null;
      purgeBtn.addEventListener("click", async () => {
        if (!purgeBtn.classList.contains("is-armed")) {
          purgeBtn.classList.add("is-armed");
          purgeBtn.textContent = t("purge_btn_armed");
          armedTimer = setTimeout(() => {
            purgeBtn.classList.remove("is-armed");
            purgeBtn.textContent = t("purge_btn");
          }, 6000);
          return;
        }
        clearTimeout(armedTimer);
        purgeBtn.disabled = true;
        const errorEl = overlay.querySelector("#records-sheet-error");
        try {
          await api.purgeUser(u.id);
          overlay.remove();
          onPurged?.();
          showToast(t("purge_done"), { ms: 4000 });
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          purgeBtn.disabled = false;
          purgeBtn.classList.remove("is-armed");
          purgeBtn.textContent = t("purge_btn");
        }
      });
    }
    overlay.querySelector("#records-sheet-clear")?.addEventListener("click", async (e) => {
      if (!confirm(t("confirm_clear_records"))) return;
      const btn = e.currentTarget;
      const errorEl = overlay.querySelector("#records-sheet-error");
      btn.disabled = true;
      try {
        await api.deleteUserRecords(u.id);
        btn.textContent = t("connected_records_cleared_now_delete");
        // Either outcome closes this sheet -- a success already closed the
        // edit sheet too (via retryDelete's own close()+loadUsers()); a
        // failure leaves the edit sheet open showing its own fresh error.
        await retryDelete();
        overlay.remove();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        btn.disabled = false;
      }
    });
  }
}

export async function renderTeamSection(container) {
  container.innerHTML = `
    <div id="user-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap">
      <button type="button" class="btn btn-block" id="add-team-member-btn">+ ${t("add_team_member")}</button>
    </div>
  `;

  const listEl = container.querySelector("#user-list");
  let users = [];

  async function loadUsers() {
    users = await api.listUsers();
    listEl.innerHTML = users
      .map((u) => {
        const roleBadge = ROLE_BADGE[shownRole(u)] ?? { key: "role_sales_manager", cls: "badge-neutral", tint: "neutral" };
        // Identity (avatar/name/role) leads; email only shows once the card
        // is opened (see openEditTeamMemberSheet) so the list stays scannable
        // instead of doubling every row's height with contact details nobody
        // is scanning for at a glance.
        return `
        <button type="button" class="card list-row ${u.status && u.status !== "active" ? "list-row-off" : ""}" data-id="${u.id}">
          <span class="list-row-icon list-row-icon-${roleBadge.tint}" aria-hidden="true">${userInitials(u.name)}</span>
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(u.name)}</strong>${ownsCustomers(u.role) ? `<span class="team-color-dot" style="background:${repColor(u.id, u.map_color)}" aria-hidden="true"></span>` : ""}
              <span class="badge ${roleBadge.cls}">${t(roleBadge.key)}</span>
              ${u.status === "paused" ? `<span class="badge badge-warning">${t("team_status_paused")}</span>` : u.status === "offboarded" ? `<span class="badge badge-danger">${t("team_status_left")}</span>` : ""}
              ${u.login_locked ? `<span class="badge badge-danger">${t("team_login_locked")}</span>` : ""}
            </div>
            ${u.position ? `<div class="muted list-row-meta">${escapeHtml(u.position)}</div>` : ""}
            <div class="muted list-row-meta">${t("last_seen")}${labelColon()}${escapeHtml(lastSeenSummary(u))}</div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    listEl.querySelectorAll("[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        const u = users.find((x) => String(x.id) === row.dataset.id);
        if (u) openEditTeamMemberSheet(u);
      });
    });
  }

  function openResetPasswordSheet(userId, userName) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("reset_password")}</h2>
        <p class="muted">${escapeHtml(userName)}</p>
        <form id="reset-password-form">
          <label>${t("new_password")}<input name="password" type="password" minlength="8" required /></label>
          <p class="form-error" id="reset-password-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-reset">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-reset").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#reset-password-form");
    const errorEl = overlay.querySelector("#reset-password-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = new FormData(form).get("password");
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.resetUserPassword(userId, password);
        overlay.remove();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  // Pause (on leave) or switch off (left the company): one guided step. The checklist shows what the person still holds; customers
  // can be handed over region by region, open tasks follow their customer or go to one chosen colleague. See POST /users/:id/status.
  async function openOffboardSheet(u) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet"><h2>${t("offboard_title")}</h2><p class="muted">${escapeHtml(u.name)}</p><p class="loading-state" role="status">${t("loading")}</p></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    let info;
    try {
      info = await api.getUserOffboarding(u.id);
    } catch (err) {
      overlay.querySelector(".sheet").innerHTML = `<h2>${t("offboard_title")}</h2><p class="form-error">${escapeHtml(err.message)}</p><div class="sheet-actions"><button type="button" class="btn" id="offboard-close">${t("cancel")}</button></div>`;
      overlay.querySelector("#offboard-close").addEventListener("click", () => overlay.remove());
      return;
    }

    const who = (c) => `${escapeHtml(c.name)}${c.position ? ` · ${escapeHtml(c.position)}` : ""}`;
    const receiverOptions = (selected) =>
      `<option value="">${t("offboard_keep")}</option>` + info.candidates.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? "selected" : ""}>${who(c)}</option>`).join("");
    const line = (text) => `<li>${text}</li>`;
    const holds = [
      line(t("offboard_customers").replace("{n}", info.customers_total)),
      line(t("offboard_tasks").replace("{n}", info.open_tasks)),
      line(t("offboard_orders").replace("{n}", info.open_orders)),
      line(t("offboard_plans").replace("{n}", info.plan_rules)),
      line(
        `${t("offboard_cash").replace("{n}", info.cash_held_count).replace("{amount}", formatAmd(info.cash_held_amd))}${
          info.cash_held_count > 0 ? ` <span class="warn-text">${t("offboard_cash_warn")}</span>` : ""
        }`
      ),
    ].join("");

    overlay.querySelector(".sheet").innerHTML = `
      <h2 class="offboard-title">${t("offboard_title")} <button type="button" class="settings-hint-icon" id="offboard-info" aria-label="${t("more_info")}">!</button></h2>
      <p class="muted">${escapeHtml(u.name)}</p>
      <form id="offboard-form">
        <div class="segmented offboard-mode" role="group">
          <button type="button" class="chip chip-active" data-mode="paused">${t("offboard_mode_pause")}</button>
          <button type="button" class="chip" data-mode="offboarded">${t("offboard_mode_left")}</button>
        </div>
        <div class="offboard-holds"><strong>${t("offboard_holds")}</strong><ul>${holds}</ul></div>
        ${
          info.customers_total > 0
            ? `<div class="offboard-regions">
                <label>${t("offboard_move_all")}<select id="offboard-all">${receiverOptions("")}</select></label>
                ${info.regions
                  .map(
                    (r, i) => `<label class="offboard-region-row"><span>${r.region ? escapeHtml(regionLabelHy(r.region)) : t("offboard_no_region")} <span class="muted">(${r.n})</span></span>
                      <select data-region-index="${i}">${receiverOptions("")}</select></label>`
                  )
                  .join("")}
              </div>`
            : ""
        }
        <label>${t("offboard_tasks_to")}<select name="tasks_to">${receiverOptions("")}</select></label>
        <p class="muted offboard-help">${t("offboard_tasks_help")}</p>
        <label>${t("offboard_note")}<input name="note" maxlength="300" /></label>
        <p class="form-error" id="offboard-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="offboard-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary" id="offboard-submit">${t("offboard_confirm_pause")}</button>
        </div>
      </form>`;

    const form = overlay.querySelector("#offboard-form");
    const errorEl = overlay.querySelector("#offboard-error");
    const submitBtn = overlay.querySelector("#offboard-submit");
    let mode = "paused";
    overlay.querySelector("#offboard-cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#offboard-info").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("offboard_info"))}</p>`));
    overlay.querySelectorAll("[data-mode]").forEach((btn) =>
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode;
        overlay.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("chip-active", b === btn));
        submitBtn.textContent = t(mode === "paused" ? "offboard_confirm_pause" : "offboard_confirm_left");
      })
    );
    overlay.querySelector("#offboard-all")?.addEventListener("change", (e) => {
      overlay.querySelectorAll("[data-region-index]").forEach((sel) => (sel.value = e.target.value));
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const moves = [];
      overlay.querySelectorAll("[data-region-index]").forEach((sel) => {
        if (sel.value) moves.push({ region: info.regions[Number(sel.dataset.regionIndex)].region, to_user_id: Number(sel.value) });
      });
      const data = new FormData(form);
      submitBtn.disabled = true;
      try {
        const out = await api.setUserStatus(u.id, {
          status: mode,
          note: String(data.get("note") || ""),
          moves,
          tasks_to_user_id: data.get("tasks_to") ? Number(data.get("tasks_to")) : undefined,
        });
        overlay.remove();
        showToast(t("offboard_done").replace("{c}", out.moved_customers).replace("{t}", out.moved_tasks));
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  // A role change is deliberately a separate, dedicated sheet from the
  // quick profile edit below -- see PATCH /:id/role's own comment in
  // routes/users.js for why it isn't folded into the regular save button.
  // Self-role-change is blocked server-side (and hidden here) so an admin
  // can never lock themselves out.
  function openChangeRoleSheet(u) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("change_role")}</h2>
        <p class="muted">${escapeHtml(u.name)}</p>
        <form id="change-role-form">
          <label>${t("role")}
            <select name="role">${roleOptionsHtml(shownRole(u))}</select>
          </label>
          <p class="form-error" id="change-role-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-change-role">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-change-role").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#change-role-form");
    const errorEl = overlay.querySelector("#change-role-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const role = new FormData(form).get("role");
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateUserRole(u.id, role);
        overlay.remove();
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  // Full profile edit for an existing staff member -- opened by tapping
  // their card. Role isn't editable here (see EDITABLE_PROFILE_FIELDS in
  // routes/users.js for why) -- Change role, Reset password and Remove
  // stay one tap away as secondary actions instead of cluttering the row
  // itself.
  function openEditTeamMemberSheet(u) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    const isSalesManager = u.role === "sales_manager";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("edit_team_member")}</h2>
        <p class="muted">
          ${t("last_seen")}${labelColon()}${escapeHtml(lastSeenSummary(u))}<br />
          ${t("device")}${labelColon()}${escapeHtml(parseUserAgent(u.last_seen_user_agent) || t("unknown"))}
        </p>
        ${
          u.login_locked
            ? `<div class="team-locked-box" id="team-locked-box">
            <span>${escapeHtml(t("team_login_locked_hint"))}</span>
            <button type="button" class="btn btn-primary btn-sm" id="edit-user-unlock">${t("team_unlock")}</button>
          </div>`
            : ""
        }
        <form id="edit-user-form">
          <label>${t("name")}<input name="name" value="${escapeHtml(u.name)}" required /></label>
          <label>${t("name_hy_label")}<input name="name_hy" value="${escapeHtml(u.name_hy || "")}" placeholder="Արտակ Հայրապետյան" /></label>
          <label>${t("email")}<input name="email" type="email" value="${escapeHtml(u.email)}" required /></label>
          <label>${t("phone")}<input name="phone" type="tel" value="${escapeHtml(formatPhoneDisplay(u.phone || ""))}" /></label>
          ${
            isSalesManager
              ? `<label>${t("sales_channel")}
            <select name="position">${salesChannelOptionsHtml(u.position)}</select>
          </label>`
              : ""
          }
          ${
            ownsCustomers(u.role)
              ? `<div class="team-color-field"><span class="team-color-label">${t("team_map_color")}</span>
            <div class="team-color-swatches" role="radiogroup" aria-label="${t("team_map_color")}">
              ${REP_COLORS.map((c) => `<button type="button" class="team-swatch ${u.map_color === c ? "team-swatch-on" : ""}" role="radio" aria-checked="${u.map_color === c}" data-color="${c}" style="--swatch:${c}" aria-label="${c}"></button>`).join("")}
              <button type="button" class="team-swatch team-swatch-auto ${!u.map_color ? "team-swatch-on" : ""}" role="radio" aria-checked="${!u.map_color}" data-color="" aria-label="${t("team_map_color_auto")}">${t("team_map_color_auto")}</button>
            </div></div>`
              : ""
          }
          <p class="form-error" id="edit-user-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-edit-user">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
        <div class="team-edit-secondary-actions">
          <button type="button" class="btn-link" id="edit-user-reset">${t("reset_password")}</button>
          ${u.id !== state.user.id ? `<button type="button" class="btn-link" id="edit-user-change-role">${t("change_role")}</button>` : ""}
          ${u.id !== state.user.id ? (u.status && u.status !== "active" ? `<button type="button" class="btn-link" id="edit-user-reactivate">${t("offboard_reactivate")}</button>` : `<button type="button" class="btn-link btn-link-danger" id="edit-user-offboard">${t("offboard_open")}</button>`) : ""}
          ${u.id !== state.user.id ? `<button type="button" class="btn-link btn-link-danger btn-has-icon" id="edit-user-delete">${icons.trash}${t("delete_user")}</button>` : ""}
          ${u.id !== state.user.id && looksLikeTestUser(u) ? `<button type="button" class="btn-link btn-link-danger" id="edit-user-purge">${t("purge_link")}</button>` : ""}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector("#cancel-edit-user").addEventListener("click", close);
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    const errorEl = overlay.querySelector("#edit-user-error");

    overlay.querySelector("#edit-user-reset").addEventListener("click", () => {
      close();
      openResetPasswordSheet(u.id, u.name);
    });
    overlay.querySelector("#edit-user-unlock")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.unlockUser(u.id);
        overlay.querySelector("#team-locked-box")?.remove();
        showToast(t("team_unlocked"));
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        e.currentTarget.disabled = false;
      }
    });
    overlay.querySelector("#edit-user-change-role")?.addEventListener("click", () => {
      close();
      openChangeRoleSheet(u);
    });
    overlay.querySelector("#edit-user-offboard")?.addEventListener("click", () => {
      close();
      openOffboardSheet(u);
    });
    overlay.querySelector("#edit-user-reactivate")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.setUserStatus(u.id, { status: "active" });
        close();
        showToast(t("offboard_reactivated"));
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        e.currentTarget.disabled = false;
      }
    });
    async function attemptDelete() {
      try {
        await api.deleteUser(u.id);
        close();
        loadUsers();
        return true;
      } catch (err) {
        // Previously unhandled -- a blocked delete (the common case: this
        // account has check-ins/orders/payments on record) just silently
        // did nothing from the admin's point of view, sheet still open,
        // no indication tapping "Delete" had even registered.
        errorEl.innerHTML = "";
        errorEl.append(document.createTextNode(err.message + " "));
        // Only the 409 "activity records" case has anything a records sheet
        // could help with -- a 403/404/etc has no connected-records path.
        if (err.status === 409) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "btn-link";
          link.textContent = t("view_connected_records");
          link.addEventListener("click", () => openUserRecordsSheet(u, attemptDelete));
          errorEl.append(link);
        }
        errorEl.hidden = false;
        return false;
      }
    }

    overlay.querySelector("#edit-user-purge")?.addEventListener("click", () =>
      openUserRecordsSheet(u, attemptDelete, () => {
        close();
        loadUsers();
      })
    );
    overlay.querySelector("#edit-user-delete")?.addEventListener("click", async () => {
      if (!confirm(t("confirm_delete_user"))) return;
      await attemptDelete();
    });

    const form = overlay.querySelector("#edit-user-form");
    let pickedColor = u.map_color ?? null;
    form.querySelectorAll(".team-swatch").forEach((sw) =>
      sw.addEventListener("click", () => {
        pickedColor = sw.dataset.color || null;
        form.querySelectorAll(".team-swatch").forEach((x) => {
          x.classList.toggle("team-swatch-on", x === sw);
          x.setAttribute("aria-checked", String(x === sw));
        });
      })
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.updateUser(u.id, {
          name: data.get("name"),
          name_hy: data.get("name_hy") || null,
          email: data.get("email"),
          phone: data.get("phone") || null,
          position: isSalesManager ? data.get("position") || null : u.position,
          ...(ownsCustomers(u.role) ? { map_color: pickedColor } : {}),
        });
        close();
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  function openAddTeamMemberSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("add_team_member")}</h2>
        <form id="new-user-form">
          <label>${t("name")}<input name="name" required /></label>
          <label>${t("email")}<input name="email" type="email" required /></label>
          <label>${t("temp_password")}<input name="password" type="password" minlength="8" required /></label>
          <label>${t("role")}
            <select name="role" id="new-user-role">${roleOptionsHtml("sales_manager")}</select>
          </label>
          <label id="new-user-position-field">${t("sales_channel")}
            <select name="position">${salesChannelOptionsHtml("")}</select>
          </label>
          <p class="form-error" id="new-user-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="cancel-add-user">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("create_account")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#cancel-add-user").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    const form = overlay.querySelector("#new-user-form");
    const errorEl = overlay.querySelector("#new-user-error");
    const roleSelect = overlay.querySelector("#new-user-role");
    const positionField = overlay.querySelector("#new-user-position-field");

    function togglePositionField() {
      positionField.hidden = roleSelect.value !== "sales_manager";
    }
    roleSelect.addEventListener("change", togglePositionField);
    togglePositionField();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      try {
        await api.createUser({
          name: data.get("name"),
          email: data.get("email"),
          password: data.get("password"),
          role: data.get("role"),
          position: data.get("role") === "sales_manager" ? data.get("position") || null : null,
        });
        overlay.remove();
        loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  container.querySelector("#add-team-member-btn").addEventListener("click", openAddTeamMemberSheet);

  loadUsers();
}
