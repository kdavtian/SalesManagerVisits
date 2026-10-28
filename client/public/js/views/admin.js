import { api } from "../api.js";
import { escapeHtml, formatDateTime, regionLabelHy, parseDateOnly, formatPhoneDisplay, openInfoPopup } from "../util.js";
import { t } from "../i18n.js";
import { placeLabel } from "../places.js";
import { ownsSalesChannels } from "../shared/roles.js";
import { ALL_ROLES, QUICK_ACTIONS, defaultQuickActionIds, withMergedTiles } from "../quickActions.js";
export { renderProductsSection } from "./admin/products.js";
export { renderTeamSection } from "./admin/team.js";


export async function renderPlanApprovalsSection(container) {
  container.innerHTML = `<div id="plan-approvals-section"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const section = container.querySelector("#plan-approvals-section");

  async function load() {
    const plans = await api.getPendingVisitPlans();
    if (!plans.length) {
      section.innerHTML = `<p class="muted">${t("plan_approvals_empty")}</p>`;
      return;
    }
    section.innerHTML = plans
      .map((p) => {
        // plan_date is a plain calendar date (no time) -- parseDateOnly
        // avoids the UTC-midnight-parsing bug that showed the previous
        // day's date for an approver in a timezone behind UTC.
        const dateLabel = parseDateOnly(p.plan_date)?.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        const names = p.customer_names.map(escapeHtml).join(", ") || t("no_customers_found");
        return `
        <div class="card plan-approval-row">
          <div class="pending-request-header">
            <span class="badge badge-accent">${t("review")}</span>
            <span class="muted">${escapeHtml(p.user_name)} · ${t("plan_for_date")} ${dateLabel}</span>
          </div>
          <p class="proposed-changes-label">${names}</p>
          <div class="sheet-actions">
            <button class="btn" data-action="reject" data-id="${p.id}">${t("reject")}</button>
            <button class="btn btn-primary" data-action="approve" data-id="${p.id}">${t("approve")}</button>
          </div>
        </div>
      `;
      })
      .join("");

    section.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.closest(".plan-approval-row").querySelectorAll("button").forEach((b) => (b.disabled = true));
        await api.reviewVisitPlan(btn.dataset.id, btn.dataset.action);
        window.dispatchEvent(new Event("plans-changed"));
        load();
      });
    });
  }

  load();
}

// Company-wide queue of every customer field-edit request awaiting review,
// so admin doesn't have to remember to reopen each customer's own card to
// notice one -- previously the only way to see a pending request was
// customerDetail.js's own banner, which only ever showed up if you
// happened to be looking at that specific customer. Same
// list/approve/reject shape as renderPlanApprovalsSection above; fires
// "edit-requests-changed" on approve/reject so app.js's topbar badge (see
// applyPlanApprovalBadge) updates immediately instead of waiting for the
// next 60s poll.
export async function renderEditRequestsSection(container) {
  container.innerHTML = `<div id="edit-requests-section"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const section = container.querySelector("#edit-requests-section");

  async function load() {
    const requests = await api.listEditRequests({ status: "pending" });
    if (!requests.length) {
      section.innerHTML = `<p class="muted">${t("edit_requests_empty")}</p>`;
      return;
    }
    section.innerHTML = requests
      .map((r) => {
        const changesList = Object.entries(r.changes)
          .map(([field, value]) => `<div class="proposed-change"><strong>${escapeHtml(t(field))}</strong>: ${escapeHtml(String(value))}</div>`)
          .join("");
        return `
        <div class="card plan-approval-row" data-id="${r.id}">
          <div class="pending-request-header">
            <span class="badge badge-accent">${t("review")}</span>
            <span class="muted">${escapeHtml(r.customer_name)} · ${t("requested_by")} ${escapeHtml(r.requested_by_name)}</span>
          </div>
          <p class="proposed-changes-label">${t("proposed_changes")}</p>
          ${changesList}
          <div class="sheet-actions">
            <button class="btn" data-action="reject" data-id="${r.id}">${t("reject")}</button>
            <button class="btn btn-primary" data-action="approve" data-id="${r.id}">${t("approve")}</button>
          </div>
        </div>
      `;
      })
      .join("");

    section.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.closest(".plan-approval-row").querySelectorAll("button").forEach((b) => (b.disabled = true));
        await api.reviewEditRequest(btn.dataset.id, btn.dataset.action);
        window.dispatchEvent(new Event("edit-requests-changed"));
        load();
      });
    });
  }

  load();
}

// Places (owner, 2026-10-25): what the spelling autocorrect could not place, and a one-tap fix of the spellings already saved (server/src/customers/routes/places.js).
export async function renderPlacesSection(container) {
  container.innerHTML = `
    <h3 class="health-title">${t("places_review_title")}<button type="button" class="settings-hint-icon" id="places-hint" aria-label="${t("more_info")}">!</button></h3>
    <div id="places-review"><p class="loading-state" role="status">${t("loading")}</p></div>
    <h3 class="health-title" style="margin-top:18px">${t("places_cleanup_title")}</h3>
    <div id="places-cleanup"></div>
  `;
  container.querySelector("#places-hint").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("places_hint"))}</p>`));
  const reviewEl = container.querySelector("#places-review");
  const cleanupEl = container.querySelector("#places-cleanup");
  const kindLabel = { unknown: "places_kind_unknown", corrected: "places_kind_corrected", other_region: "places_kind_other_region" };
  const place = (name) => escapeHtml(placeLabel(name) ?? "");

  async function loadReviews() {
    const rows = await api.placeReviews();
    if (!rows.length) {
      reviewEl.innerHTML = `<p class="muted">${t("places_review_empty")}</p>`;
      return;
    }
    reviewEl.innerHTML = rows
      .map((r) => {
        const sug = r.suggestions?.[0];
        return `
        <div class="card plan-approval-row" data-id="${r.id}">
          <div class="pending-request-header">
            <span class="badge badge-warning">${t(kindLabel[r.kind] || "places_kind_unknown")}</span>
            <span class="muted">${escapeHtml(r.customer_name)} &middot; ${escapeHtml(t(r.field))}</span>
          </div>
          <div class="proposed-change"><strong>${t("places_typed")}</strong>: ${escapeHtml(r.typed_value)}</div>
          ${r.kind === "corrected" ? `<div class="proposed-change"><strong>${t("places_saved_as")}</strong>: ${place(r.applied_value)}</div>` : ""}
          ${sug ? `<div class="proposed-change"><strong>${t("places_suggestion")}</strong>: ${place(sug.en)}${sug.region ? ` &middot; ${escapeHtml(regionLabelHy(sug.region))}` : ""}</div>` : ""}
          ${r.kind === "unknown" ? `<input type="text" class="places-hy-input" data-hy placeholder="${escapeHtml(t("places_hy_placeholder"))}" />` : ""}
          <div class="sheet-actions">
            <button class="btn" data-act="dismiss">${t("places_dismiss")}</button>
            ${r.kind !== "corrected" ? `<button class="btn" data-act="keep">${t("places_keep")}</button>` : ""}
            ${sug ? `<button class="btn btn-primary" data-act="accept" data-value="${escapeHtml(sug.en)}">${escapeHtml(t("places_use").replace("{name}", placeLabel(sug.en)))}</button>` : ""}
          </div>
        </div>`;
      })
      .join("");
    reviewEl.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest("[data-id]");
        card.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await api.placeReviewResolve(card.dataset.id, {
            action: btn.dataset.act,
            value: btn.dataset.value || undefined,
            name_hy: card.querySelector("[data-hy]")?.value.trim() || undefined,
          });
          loadReviews();
        } catch (err) {
          card.querySelectorAll("button").forEach((b) => (b.disabled = false));
          alert(err.message);
        }
      });
    });
  }

  async function loadCleanup() {
    cleanupEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const plan = await api.placeCleanup();
    if (!plan.changes.length) {
      cleanupEl.innerHTML = `<p class="muted">${t("places_cleanup_none")}</p>`;
      return;
    }
    const customers = plan.changes.reduce((n, c) => n + c.customers, 0);
    const line = (c) => {
      const f = [c.from.region, c.from.subregion].filter(Boolean).join(" / ");
      const to = [c.to.region && regionLabelHy(c.to.region), c.to.subregion && placeLabel(c.to.subregion)].filter(Boolean).join(" / ");
      return `<div class="proposed-change">${escapeHtml(f)} &rarr; <strong>${escapeHtml(to)}</strong> <span class="muted">(${c.customers})</span></div>`;
    };
    cleanupEl.innerHTML = `
      <p class="muted">${escapeHtml(t("places_cleanup_preview").replace("{n}", plan.changes.length).replace("{c}", customers))}</p>
      <div class="card">${plan.changes.slice(0, 40).map(line).join("")}</div>
      <button type="button" class="btn btn-primary btn-block" id="places-cleanup-apply">${t("places_cleanup_apply")}</button>`;
    cleanupEl.querySelector("#places-cleanup-apply").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const done = await api.placeCleanupApply();
        cleanupEl.innerHTML = `<p>${escapeHtml(t("places_cleanup_done").replace("{c}", done.customers).replace("{q}", done.queued))}</p>`;
        loadReviews();
      } catch (err) {
        e.currentTarget.disabled = false;
        alert(err.message);
      }
    });
  }

  loadReviews();
  loadCleanup();
}

// Editable company header for the pricelist export (item 14) -- name,
// logo, phone/email/website/address. A singleton row (see the
// company_profile table), not per-user.
export async function renderCompanyProfileSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const profile = await api.getCompanyProfile();
  container.innerHTML = `
    <div class="card">
      <form id="company-profile-form">
        <label>${t("company_name")}<input name="name" value="${escapeHtml(profile.name || "")}" required /></label>
        <label>${t("phone")}<input name="phone" type="tel" value="${escapeHtml(formatPhoneDisplay(profile.phone || ""))}" /></label>
        <label>${t("email")}<input name="email" type="email" value="${escapeHtml(profile.email || "")}" /></label>
        <label>${t("website")}<input name="website" value="${escapeHtml(profile.website || "")}" /></label>
        <label>${t("address")}<textarea name="address" rows="2">${escapeHtml(profile.address || "")}</textarea></label>
        <p class="form-success" id="company-profile-success" role="status" hidden>${t("saved")}</p>
        <p class="form-error" id="company-profile-error" hidden></p>
        <button type="submit" class="btn btn-primary">${t("save")}</button>
      </form>
    </div>
  `;
  const form = container.querySelector("#company-profile-form");
  const successEl = container.querySelector("#company-profile-success");
  const errorEl = container.querySelector("#company-profile-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    successEl.hidden = true;
    errorEl.hidden = true;
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.updateCompanyProfile({
        name: data.get("name"),
        phone: data.get("phone") || null,
        email: data.get("email") || null,
        website: data.get("website") || null,
        address: data.get("address") || null,
      });
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// The single canonical place to set a channel's manager (sales_channels.
// manager_user_id). Routes Distribution above, and the sales-manager
// customer-creation autofill on the server, both now read this instead of
// keeping their own divergent manager association.
export async function renderSalesChannelOwnersSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  // The Routes Distribution manager picker uses listPlannableUsers (sales
  // managers only), but a channel here can just as well be owned by a
  // Sales Director (CVO/PCO/OEM) or, in principle, an Accountant (KF/CAS)
  // -- the full admin user list, filtered to the roles that actually own
  // channels, is needed so those managers are selectable too.
  const [channels, allUsers] = await Promise.all([api.getPerfChannels(), api.listUsers()]);
  const managers = allUsers.filter((u) => ownsSalesChannels(u.role));

  container.innerHTML = `
    <p class="muted radius-help">${t("sales_channel_owners_hint")}</p>
    <div id="sco-list" class="card-list"></div>
  `;
  const listEl = container.querySelector("#sco-list");
  listEl.innerHTML = channels
    .map(
      (c) => `
    <div class="card user-row">
      <div class="user-row-top">
        <div>
          <strong>${escapeHtml(c.name)}</strong>
          <span class="muted">${escapeHtml(c.code)}</span>
        </div>
      </div>
      <label class="sco-manager-label">${t("assigned_manager")}
        <select data-channel-id="${c.id}">
          <option value="">${t("unassigned")}</option>
          ${managers.map((u) => `<option value="${u.id}" ${Number(u.id) === Number(c.manager_user_id) ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("")}
        </select>
      </label>
      <p class="form-error" id="sco-error-${c.id}" hidden></p>
    </div>`
    )
    .join("");

  listEl.querySelectorAll("select[data-channel-id]").forEach((select) => {
    select.addEventListener("change", async () => {
      const channelId = select.dataset.channelId;
      const errorEl = container.querySelector(`#sco-error-${channelId}`);
      errorEl.hidden = true;
      select.disabled = true;
      try {
        await api.updatePerfChannelManager(channelId, select.value ? Number(select.value) : null);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        select.disabled = false;
      }
    });
  });
}

// Admin-configurable Home "Quick actions" per role. Pre-checked from the
// role's *effective* list -- an explicit override if one was saved, else the
// same shipped defaults the dashboard falls back to -- so the admin opens
// onto the real current state rather than a blank slate they'd have to
// reconstruct from memory. Reset clears that role's key entirely and puts it
// back on defaults, which is not the same as saving an empty list (that
// means "show this role no tiles at all").
export async function renderQuickActionVisibilitySection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const settings = await api.getSettings();
  const visibility = { ...(settings.quick_action_visibility ?? {}) };

  function effectiveIds(role) {
    return Array.isArray(visibility[role]) ? withMergedTiles(visibility[role]) : defaultQuickActionIds(role);
  }

  container.innerHTML = `
    <p class="muted radius-help">${t("quick_action_visibility_hint")}</p>
    <p class="form-error" id="qav-error" hidden></p>
    <p class="form-success" id="qav-success" role="status" hidden>${t("saved")}</p>
    <div class="card-list" id="qav-list">
      ${ALL_ROLES.map(
        (role) => `
        <details class="card qav-role" data-role="${role}">
          <summary>
            <span><strong>${t(`role_${role}`)}</strong></span>
            <span class="muted" data-qav-count="${role}"></span>
          </summary>
          <div class="qav-actions">
            ${QUICK_ACTIONS.map(
              (a) => `
              <label class="qav-action">
                <input type="checkbox" data-role="${role}" value="${a.id}" />
                <span>${t(a.id)}</span>
              </label>`
            ).join("")}
            <button type="button" class="link-btn" data-qav-reset="${role}">${t("quick_action_visibility_reset")}</button>
          </div>
        </details>`
      ).join("")}
    </div>
  `;

  const errorEl = container.querySelector("#qav-error");
  const successEl = container.querySelector("#qav-success");

  function paint() {
    for (const role of ALL_ROLES) {
      const ids = effectiveIds(role);
      container.querySelectorAll(`input[type="checkbox"][data-role="${role}"]`).forEach((cb) => {
        cb.checked = ids.includes(cb.value);
      });
      const countEl = container.querySelector(`[data-qav-count="${role}"]`);
      countEl.textContent = `${ids.length}/${QUICK_ACTIONS.length}${
        Array.isArray(visibility[role]) ? "" : ` · ${t("quick_action_visibility_default")}`
      }`;
    }
  }
  paint();

  let saveTimer = null;
  async function save() {
    errorEl.hidden = true;
    try {
      await api.updateSettings({ quick_action_visibility: visibility });
      successEl.hidden = false;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        successEl.hidden = true;
      }, 1500);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  container.querySelectorAll('input[type="checkbox"][data-role]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const role = cb.dataset.role;
      // First edit of a defaulted role materializes its current effective
      // list, so unchecking one tile doesn't silently drop the other twelve.
      const ids = new Set(effectiveIds(role));
      if (cb.checked) ids.add(cb.value);
      else ids.delete(cb.value);
      visibility[role] = [...ids];
      paint();
      save();
    });
  });

  container.querySelectorAll("[data-qav-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      delete visibility[btn.dataset.qavReset];
      paint();
      save();
    });
  });
}

function previousMonthStart() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

export async function renderPointsCloseoutSection(container) {
  const lastMonth = previousMonthStart();
  container.innerHTML = `
    <div class="card">
      <p class="muted">${t("closeout_hint")}</p>
      <button type="button" class="btn btn-primary" id="close-out-btn">${t("close_out_month")} (${escapeHtml(formatMonthLabel(lastMonth))})</button>
      <p class="form-error" id="closeout-error" hidden></p>
    </div>
    <div class="card-list" id="closeout-history"></div>
  `;

  const historyEl = container.querySelector("#closeout-history");
  const errorEl = container.querySelector("#closeout-error");

  async function loadHistory() {
    const rows = await api.listMonthlyCloseouts();
    if (!rows.length) {
      historyEl.innerHTML = `<p class="empty-state">${t("no_closeouts_yet")}</p>`;
      return;
    }
    const byMonth = new Map();
    for (const r of rows) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month).push(r);
    }
    historyEl.innerHTML = [...byMonth.entries()]
      .map(([month, winners]) => {
        const top = winners.find((w) => w.rank === 1);
        return `
        <div class="card user-row">
          <div class="user-row-top">
            <div>
              <strong>${escapeHtml(formatMonthLabel(String(month).slice(0, 7)))}</strong>
              <span class="muted">${top ? `🏆 ${escapeHtml(top.user_name)}` : ""}</span>
            </div>
            <span class="badge badge-accent">${top ? `${top.total_points} pts` : ""}</span>
          </div>
        </div>
      `;
      })
      .join("");
  }

  container.querySelector("#close-out-btn").addEventListener("click", async (e) => {
    errorEl.hidden = true;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.closeOutMonth(lastMonth);
      loadHistory();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  loadHistory();
}

const DATA_QUALITY_FLAG_LABELS = {
  no_owner: "data_quality_flag_no_owner",
  no_channel: "data_quality_flag_no_channel",
  no_location: "data_quality_flag_no_location",
};

// Admin-only oversight tool (server/src/system/routes/dataQuality.js): surfaces
// customers missing an owner or sales channel (both nullable, and both a
// silent gap in the app's own visibility/reporting logic rather than a
// hard failure anywhere -- see the route's own comment), plus a same-
// name/same-location scan for likely duplicate customer records. Not
// meant for daily use by anyone but an admin doing periodic cleanup, so
// this is a plain read + fix-elsewhere flow (each row deep-links to the
// customer's own detail page to actually fix it), not a dedicated editor.
export async function renderDataQualitySection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const data = await api.getDataQuality();

  const countChip = (count, label) =>
    `<div class="dq-count-chip"><strong>${count}</strong><span>${t(label)}</span></div>`;

  const flagBadges = (flags) =>
    flags
      .map((f) => `<span class="badge badge-warning">${t(DATA_QUALITY_FLAG_LABELS[f] || f)}</span>`)
      .join(" ");

  const flaggedRows = data.flagged_customers.length
    ? data.flagged_customers
        .map(
          (c) => `
      <a class="card list-row dq-row" href="#/customers/${c.id}">
        <div class="dq-row-main">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="muted">${c.erp_customer_id ? `ID: ${escapeHtml(String(c.erp_customer_id))}` : t("data_quality_no_erp_id")}</span>
        </div>
        <div class="dq-row-flags">${flagBadges(c.flags)}</div>
      </a>`
        )
        .join("")
    : `<p class="muted">${t("data_quality_no_issues")}</p>`;

  const duplicateRows = data.duplicate_groups.length
    ? data.duplicate_groups
        .map(
          (g) => `
      <div class="card dq-row">
        <div class="dq-row-main">
          <strong>${escapeHtml(g.name)}</strong>
          <span class="badge badge-danger">${t("data_quality_flag_duplicate")}</span>
        </div>
        <div class="dq-row-flags">
          ${g.customers.map((c) => `<a href="#/customers/${c.id}">#${c.id}</a>`).join(", ")}
        </div>
      </div>`
        )
        .join("")
    : `<p class="muted">${t("data_quality_no_duplicates")}</p>`;

  container.innerHTML = `
    <p class="muted radius-help">${t("data_quality_hint")}</p>
    <div class="dq-counts">
      ${countChip(data.counts.no_owner, "data_quality_flag_no_owner")}
      ${countChip(data.counts.no_channel, "data_quality_flag_no_channel")}
      ${countChip(data.counts.no_location, "data_quality_flag_no_location")}
      ${countChip(data.counts.duplicate_groups, "data_quality_flag_duplicate")}
    </div>
    <h3 class="dq-subhead">${t("data_quality_flagged_heading")}</h3>
    <div class="card-list">${flaggedRows}</div>
    <h3 class="dq-subhead">${t("data_quality_duplicates_heading")}</h3>
    <div class="card-list">${duplicateRows}</div>
  `;
}

const DELIVERY_STATUS_BADGE = {
  delivered: "badge-success",
  failed: "badge-danger",
  expired: "badge-neutral",
};

// Admin-only oversight (server/src/system/routes/notifications.js's GET
// /delivery-log): what used to be visible only in server console output --
// every push-delivery attempt, including retries (push.js retries a
// transient failure twice more before giving up; each attempt is its own
// row here, so a notification that failed then succeeded on retry shows
// both).
export async function renderNotificationDeliveryLogSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const rows = await api.getNotificationDeliveryLog();

  container.innerHTML = `
    <p class="muted radius-help">${t("notification_delivery_log_hint")}</p>
    <div class="card-list">
      ${
        rows.length
          ? rows
              .map(
                (r) => `
        <div class="card dq-row">
          <div class="dq-row-main">
            <strong>${escapeHtml(r.user_name)}${r.notification_title ? ` · ${escapeHtml(r.notification_title)}` : ""}</strong>
            <span class="muted">${formatDateTime(r.attempted_at)} · ${t("notification_delivery_log_attempt")} ${r.attempt}${r.error_message ? ` · ${escapeHtml(r.error_message)}` : ""}</span>
          </div>
          <div class="dq-row-flags">
            <span class="badge ${DELIVERY_STATUS_BADGE[r.status] || "badge-neutral"}">${t(`notification_delivery_status_${r.status}`)}</span>
          </div>
        </div>`
              )
              .join("")
          : `<p class="muted">${t("notification_delivery_log_empty")}</p>`
      }
    </div>
  `;
}

const CLIENT_ERROR_KIND_BADGE = {
  error: "badge-danger",
  unhandledrejection: "badge-danger",
  slow_load: "badge-warning",
};

// Admin-only oversight (server/src/system/routes/clientErrors.js's GET /) --
// window.onerror/unhandledrejection reports plus slow-page-load reports
// from every user's device (see client/public/js/errorMonitoring.js),
// which previously left no trace anywhere.
export async function renderClientErrorLogSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const rows = await api.getClientErrorLog();

  container.innerHTML = `
    <p class="muted radius-help">${t("client_error_log_hint")}</p>
    <div class="card-list">
      ${
        rows.length
          ? rows
              .map(
                (r) => `
        <div class="card dq-row">
          <div class="dq-row-main">
            <strong>${escapeHtml(r.user_name || t("client_error_log_unknown_user"))}${r.url ? ` · ${escapeHtml(r.url)}` : ""}</strong>
            <span class="muted">${formatDateTime(r.created_at)} · ${escapeHtml(r.message)}</span>
          </div>
          <div class="dq-row-flags">
            <span class="badge ${CLIENT_ERROR_KIND_BADGE[r.kind] || "badge-neutral"}">${t(`client_error_kind_${r.kind}`)}</span>
          </div>
        </div>`
              )
              .join("")
          : `<p class="muted">${t("client_error_log_empty")}</p>`
      }
    </div>
  `;
}
