// Cash custody chain screen -- the hand-to-hand journey of the physical
// cash, layered on top of the Payments screen (see
// server/src/routes/cashHandoffs.js and migrations/059_cash_handoffs.sql).
//
// Two halves:
//   "Hand over"  -- what the signed-in user currently holds (or, for a
//                   director, what one of their reps is handing them), with
//                   per-channel subtotals and a Submit-all button.
//   "To confirm" -- incoming handoffs awaiting this user's decision, each
//                   broken down by sales channel so they can count the
//                   physical notes channel by channel before confirming.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateTime, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

// Mirrors server/src/roles.js's validHandoffRecipientRoles /
// canSubmitHandoffForOthers -- kept local for the same reason every other
// view in this app duplicates its role rules (there is no shared client
// roles module; see payments.js's REVIEW_ROLES).
const NEXT_HOP_ROLES = {
  sales_manager: ["sales_director"],
  sales_director: ["ceo", "accountant"],
  ceo: ["accountant"],
};
// The only on-behalf-of case in the chain is the FIRST hop: a sales
// director declaring "I have received this rep's collections". The server
// enforces that too (checkOnBehalf: the actor must be the receiver, and a
// rep's only legal receiver is a director), so a CEO or accountant would
// only ever get an error out of that picker -- don't offer it to them.
// Admin keeps it as the usual backstop.
const SUBMIT_FOR_OTHERS_ROLES = new Set(["admin", "sales_director"]);

const HANDOFF_STATUS_META = {
  pending: { key: "handoff_status_pending", cls: "badge-warning" },
  confirmed: { key: "handoff_status_confirmed", cls: "badge-success" },
  rejected: { key: "handoff_status_rejected", cls: "badge-danger" },
};

function roleLabel(role) {
  return t(`role_${role}`) || role;
}

function channelBreakdownHtml(byChannel, total) {
  if (!byChannel?.length) return "";
  return `
    <table class="handoff-breakdown">
      
      <tbody>
        ${byChannel
          .map(
            (c) => `<tr>
              <th scope="row">${escapeHtml(c.sales_channel)}</th>
              <td class="muted">${c.count}</td>
              <td class="text-amount">${formatAmd(c.total_amd)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">${t("handoff_total")}</th>
          <td></td>
          <td class="text-amount"><strong>${formatAmd(total)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

export async function renderCashHandoffs(root, navigate, focusHandoffId) {
  document.querySelectorAll(".sheet-overlay").forEach((el) => el.remove());

  const role = state.user.role;
  const canActForOthers = SUBMIT_FOR_OTHERS_ROLES.has(role);
  const canSendOwn = Boolean(NEXT_HOP_ROLES[role]);

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("cash_handoffs_title")}</h1></div>
      </div>
      <p class="muted">${t("cash_handoffs_intro")}</p>

      <section id="handoff-incoming-section" hidden>
        <h2 class="list-group-heading">${t("handoff_pending_confirmations")}</h2>
        <div class="card-list" id="handoff-incoming"></div>
      </section>

      <section id="handoff-available-section" hidden>
        <h2 class="list-group-heading">${t("handoff_available_title")}</h2>
        <div id="handoff-available"></div>
      </section>

      <section>
        <h2 class="list-group-heading">${t("handoff_history_title")}</h2>
        <div class="card-list" id="handoff-history"><p class="loading-state" role="status">${t("loading")}</p></div>
      </section>
    </div>
  `;

  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/payments"));
  const incomingSection = container.querySelector("#handoff-incoming-section");
  const incomingEl = container.querySelector("#handoff-incoming");
  const availableSection = container.querySelector("#handoff-available-section");
  const availableEl = container.querySelector("#handoff-available");
  const historyEl = container.querySelector("#handoff-history");

  // Whose cash the "Hand over" panel is showing: yourself, or (for a
  // director/CEO/accountant/admin) one of the reps who just handed you an
  // envelope. `null` means "my own".
  let actingFor = null;
  let senders = [];
  let historyOffset = 0;
  let historyRows = [];
  let historyHasMore = false;

  async function loadInbox() {
    let result;
    try {
      result = await api.listCashHandoffs(0);
    } catch (err) {
      historyEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    historyRows = result.rows;
    historyHasMore = result.has_more;
    historyOffset = result.rows.length;

    incomingSection.hidden = result.incoming.length === 0;
    incomingEl.innerHTML = result.incoming.map(incomingRowHtml).join("");
    incomingEl.querySelectorAll("[data-open-handoff]").forEach((btn) => {
      btn.addEventListener("click", () => openHandoffSheet(Number(btn.dataset.openHandoff)));
    });

    paintHistory();
  }

  function incomingRowHtml(h) {
    return `
      <button type="button" class="card handoff-card-btn" data-open-handoff="${h.id}">
        <div class="list-row-top">
          <strong>${escapeHtml(h.from_user_name)}</strong>
          <span class="list-row-trailing-text text-amount">${formatAmd(Number(h.amount_amd))}</span>
        </div>
        <div class="muted list-row-meta">
          ${t("handoff_items_n").replace("{n}", h.item_count)} · ${formatDateTime(h.submitted_at)}
          ${h.submitted_by !== h.from_user_id ? ` · ${t("handoff_declared_by").replace("{name}", escapeHtml(h.submitted_by_name))}` : ""}
        </div>
        <div class="list-row-bottom"><span class="badge badge-warning">${t("handoff_tap_to_review")}</span></div>
      </button>
    `;
  }

  function historyRowHtml(h) {
    const meta = HANDOFF_STATUS_META[h.status] ?? HANDOFF_STATUS_META.pending;
    return `
      <button type="button" class="card handoff-card-btn" data-open-handoff="${h.id}">
        <div class="list-row-top">
          <strong>${escapeHtml(h.from_user_name)} → ${escapeHtml(h.to_user_name)}</strong>
          <span class="list-row-trailing-text text-amount">${formatAmd(Number(h.amount_amd))}</span>
        </div>
        <div class="muted list-row-meta">${t("handoff_items_n").replace("{n}", h.item_count)} · ${formatDateTime(h.submitted_at)}</div>
        <div class="list-row-bottom"><span class="badge ${meta.cls}">${t(meta.key)}</span></div>
      </button>
    `;
  }

  function paintHistory() {
    if (!historyRows.length) {
      historyEl.innerHTML = `<p class="empty-state">${t("handoff_no_history")}</p>`;
      return;
    }
    historyEl.innerHTML = historyRows.map(historyRowHtml).join("");
    if (historyHasMore) {
      historyEl.insertAdjacentHTML(
        "beforeend",
        `<button type="button" class="btn btn-block" id="handoff-load-more">${t("load_more")}</button>`
      );
      historyEl.querySelector("#handoff-load-more").addEventListener("click", async (e) => {
        e.target.disabled = true;
        const more = await api.listCashHandoffs(historyOffset);
        historyRows = historyRows.concat(more.rows);
        historyHasMore = more.has_more;
        historyOffset += more.rows.length;
        paintHistory();
      });
    }
    historyEl.querySelectorAll("[data-open-handoff]").forEach((btn) => {
      btn.addEventListener("click", () => openHandoffSheet(Number(btn.dataset.openHandoff)));
    });
  }

  async function loadAvailable() {
    if (!canSendOwn && !canActForOthers) {
      availableSection.hidden = true;
      return;
    }
    availableSection.hidden = false;
    availableEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;

    if (canActForOthers && !senders.length) {
      try {
        senders = await api.getHandoffSenders();
      } catch {
        senders = [];
      }
    }

    let data;
    try {
      data = await api.getHandoffAvailable(actingFor?.id);
    } catch (err) {
      availableEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    paintAvailable(data);
  }

  function paintAvailable(data) {
    // The rep picker exists only for the first hop: a director declaring
    // "I have received this rep's collections". Everything past that is
    // strictly first-person, so the picker is hidden for those hops.
    const showSenderPicker = canActForOthers;
    const canSubmit = data.recipients.length > 0 && data.count > 0;

    // Wrapped in a <form> purely so the app's `form label`/`form select`
    // styling applies -- nothing here ever submits (the button is
    // type="button" and goes through the two-step sheet instead).
    availableEl.innerHTML = `
      <form id="handoff-form">
      ${
        showSenderPicker
          ? `<label for="handoff-sender-select">${t("handoff_whose_cash")}
              <select id="handoff-sender-select">
                <option value="">${t("handoff_my_own_cash")}</option>
                ${senders
                  .map(
                    (s) =>
                      `<option value="${s.id}" ${actingFor?.id === s.id ? "selected" : ""}>${escapeHtml(s.name)}${
                        s.available_count ? ` · ${formatAmd(s.available_amd)}` : ` · ${t("handoff_nothing_available")}`
                      }</option>`
                  )
                  .join("")}
              </select>
            </label>`
          : ""
      }
      ${
        actingFor
          ? `<p class="muted">${t("handoff_declaring_for").replace("{name}", escapeHtml(actingFor.name))}</p>`
          : ""
      }
      ${
        data.count === 0
          ? `<p class="empty-state" id="handoff-nothing">${t("handoff_nothing_available")}</p>`
          : `
            <div class="card" id="handoff-available-card">
              ${channelBreakdownHtml(data.by_channel, data.total_amd)}
              <p class="muted">${t("handoff_items_n").replace("{n}", data.count)}</p>
            </div>
            ${
              data.recipients.length
                ? `<label for="handoff-recipient-select">${t("handoff_give_to")}
                    <select id="handoff-recipient-select">
                      ${data.recipients
                        .map((r) => `<option value="${r.id}">${escapeHtml(r.name)} · ${roleLabel(r.role)}</option>`)
                        .join("")}
                    </select>
                  </label>
                  ${
                    data.recipients.length === 1
                      ? `<p class="muted" id="handoff-single-recipient">${t("handoff_single_recipient").replace(
                          "{name}",
                          escapeHtml(data.recipients[0].name)
                        )}</p>`
                      : ""
                  }`
                : `<p class="form-error" style="position:static;">${t("handoff_no_recipients")}</p>`
            }
          `
      }
      <p class="form-error" id="handoff-submit-error" hidden></p>
      <button type="button" class="btn btn-primary btn-block" id="handoff-submit-all" ${canSubmit ? "" : "disabled"}>
        ${t("handoff_submit_all")}
      </button>
      </form>
    `;
    availableEl.querySelector("#handoff-form").addEventListener("submit", (e) => e.preventDefault());

    const senderSelect = availableEl.querySelector("#handoff-sender-select");
    if (senderSelect) {
      senderSelect.addEventListener("change", () => {
        actingFor = senders.find((s) => String(s.id) === senderSelect.value) || null;
        loadAvailable();
      });
    }

    availableEl
      .querySelector("#handoff-submit-all")
      .addEventListener("click", () => openSubmitConfirm(data));
  }

  // Two-step confirmation. This codebase has no "tap again within N
  // seconds" affordance anywhere -- every consequential single-tap action
  // (delete order/customer/expense, reject an order, approve a payment)
  // gates itself behind a second, explicit confirmation step. This follows
  // that same shape, but as an in-app review sheet rather than a bare
  // window.confirm(), because the whole point of the second step here is to
  // re-read the amount and channel breakdown before committing custody of
  // real money. One tap only opens the sheet; nothing is submitted until
  // the second, differently-labelled button inside it is pressed.
  function openSubmitConfirm(data) {
    const recipientSelect = availableEl.querySelector("#handoff-recipient-select");
    const recipientId = Number(recipientSelect?.value);
    const recipient = data.recipients.find((r) => r.id === recipientId);
    if (!recipient) return;

    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.id = "handoff-confirm-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("handoff_confirm_submit_title")}</h2>
        <p>${t("handoff_confirm_submit_body")
          .replace("{amount}", formatAmd(data.total_amd))
          .replace("{name}", escapeHtml(recipient.name))}</p>
        ${channelBreakdownHtml(data.by_channel, data.total_amd)}
        <p class="muted">${t("handoff_confirm_submit_hint")}</p>
        <p class="form-error" id="handoff-confirm-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="handoff-confirm-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="handoff-confirm-go">${t("handoff_confirm_submit_yes")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#handoff-confirm-cancel").addEventListener("click", () => overlay.remove());

    overlay.querySelector("#handoff-confirm-go").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const errorEl = overlay.querySelector("#handoff-confirm-error");
      errorEl.hidden = true;
      try {
        await api.createCashHandoff({
          to_user_id: recipient.id,
          all: true,
          on_behalf_of_user_id: actingFor?.id,
        });
        overlay.remove();
        window.dispatchEvent(new Event("payments-changed"));
        await Promise.all([loadAvailable(), loadInbox()]);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        e.target.disabled = false;
      }
    });
  }

  // The receiver's "count the cash against this" view.
  async function openHandoffSheet(id) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.id = "handoff-detail-overlay";
    overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    let handoff;
    try {
      handoff = await api.getCashHandoff(id);
    } catch (err) {
      overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const isRecipient = handoff.to_user_id === state.user.id || state.user.role === "admin";
    const canDecide = isRecipient && handoff.status === "pending";
    const meta = HANDOFF_STATUS_META[handoff.status] ?? HANDOFF_STATUS_META.pending;

    overlay.querySelector(".sheet").innerHTML = `
      <h2>${t("handoff_detail_title")}</h2>
      <p><span class="badge ${meta.cls}">${t(meta.key)}</span></p>
      <p class="muted">
        ${escapeHtml(handoff.from_user_name)} (${roleLabel(handoff.from_user_role)})
        → ${escapeHtml(handoff.to_user_name)} (${roleLabel(handoff.to_user_role)})
      </p>
      <p class="muted">${formatDateTime(handoff.submitted_at)}${
        handoff.submitted_by !== handoff.from_user_id
          ? ` · ${t("handoff_declared_by").replace("{name}", escapeHtml(handoff.submitted_by_name))}`
          : ""
      }</p>
      <h3 class="list-group-heading">${t("handoff_channel_breakdown")}</h3>
      ${channelBreakdownHtml(handoff.by_channel, handoff.total_amd)}
      ${canDecide ? `<p class="muted">${t("handoff_count_hint")}</p>` : ""}
      <h3 class="list-group-heading">${t("handoff_items_title")}</h3>
      <div class="card-list" id="handoff-item-list" style="margin:8px 0 12px;">
        ${handoff.payments
          .map(
            (p) => `
          <div class="order-line-row">
            <div class="order-line-top">
              <span class="order-line-name">${escapeHtml(p.customer_name_snapshot)}</span>
              <strong class="text-amount">${formatAmd(Number(p.amount_amd))}</strong>
            </div>
            <span class="order-line-meta">${escapeHtml(p.sales_channel || "—")} · ${escapeHtml(
              p.sales_manager_name_snapshot
            )} · ${formatDateTime(p.payment_date)}</span>
          </div>`
          )
          .join("")}
      </div>
      ${handoff.rejection_reason ? `<p class="form-error" style="position:static;">${escapeHtml(handoff.rejection_reason)}</p>` : ""}
      <p class="form-error" id="handoff-detail-error" hidden></p>
      <div class="sheet-actions" style="flex-wrap:wrap;">
        ${
          canDecide
            ? `<button type="button" class="btn btn-danger" id="handoff-reject-btn">${t("handoff_reject")}</button>
               <button type="button" class="btn btn-primary" id="handoff-confirm-btn">${t("handoff_confirm")}</button>`
            : ""
        }
        <button type="button" class="btn" id="handoff-close-btn">${t("done")}</button>
      </div>
    `;

    const errorEl = overlay.querySelector("#handoff-detail-error");
    overlay.querySelector("#handoff-close-btn").addEventListener("click", () => overlay.remove());

    async function act(fn) {
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      errorEl.hidden = true;
      try {
        await fn();
        overlay.remove();
        window.dispatchEvent(new Event("payments-changed"));
        await Promise.all([loadInbox(), loadAvailable()]);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }

    overlay.querySelector("#handoff-confirm-btn")?.addEventListener("click", () => {
      if (!confirm(t("handoff_confirm_receipt_prompt").replace("{amount}", formatAmd(handoff.total_amd)))) return;
      act(() => api.confirmCashHandoff(handoff.id));
    });
    overlay.querySelector("#handoff-reject-btn")?.addEventListener("click", () => {
      const reason = prompt(t("handoff_reject_reason_label"));
      if (!reason || !reason.trim()) return;
      act(() => api.rejectCashHandoff(handoff.id, reason.trim()));
    });
  }

  await loadInbox();
  await loadAvailable();
  if (focusHandoffId) openHandoffSheet(Number(focusHandoffId));
}
