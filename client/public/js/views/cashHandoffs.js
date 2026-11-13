// Cash custody chain screen -- the hand-to-hand journey of the physical
// cash, layered on top of the Payments screen (see
// server/src/money/routes/cashHandoffs.js and migrations/059_cash_handoffs.sql).
//
// Two halves:
//   "Hand over"  -- what the signed-in user currently holds (or, for a
//                   director, what one of their reps is handing them), with
//                   per-channel subtotals and a Submit-all button.
//   "To confirm" -- incoming handoffs awaiting this user's decision, each
//                   broken down by sales channel so they can count the
//                   physical notes channel by channel before confirming.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateTime, formatDateDMY, activateDialog, channelDisplayLabel, customerNameLinkHtml, activateCustomerNameLinks, leaveSheetTo, bindAmdInput, downloadFromUrl, showToast } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { validHandoffRecipientRoles, offersHandoffOnBehalf } from "../shared/roles.js";
import { deskSelectChip } from "../deskTable.js";
import { openHandoverSheet, channelBreakdownHtml, groupByDay, sumAmd } from "../handoverSheet.js";


const HANDOFF_STATUS_META = {
  pending: { key: "handoff_status_pending", cls: "badge-warning" },
  confirmed: { key: "handoff_status_confirmed", cls: "badge-success" },
  rejected: { key: "handoff_status_rejected", cls: "badge-danger" },
};

function roleLabel(role) {
  return t(`role_${role}`) || role;
}

export async function renderCashHandoffs(root, navigate, focusHandoffId, { handover = false } = {}) {
  document.querySelectorAll(".sheet-overlay").forEach((el) => el.remove());

  const role = state.user.role;
  const canActForOthers = offersHandoffOnBehalf(role);
  const canSendOwn = validHandoffRecipientRoles(role).length > 0;

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

      <section id="shortfalls-section" hidden>
        <h2 class="list-group-heading">${t("shortfall_title")}</h2>
        <div class="card-list" id="shortfalls"></div>
      </section>

      <section id="cash-sheets-section" hidden>
        <h2 class="list-group-heading">${t("cash_sheets_title")}</h2>
        <div class="card-list" id="cash-sheets"></div>
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
  const sheetsSection = container.querySelector("#cash-sheets-section");
  const sheetsEl = container.querySelector("#cash-sheets");

  // Counting shortfalls (payments redesign, release 3; owner's answer 6): counted less than handed over -> on the sender's line until
  // the missing notes are paid in (director / accountant / admin / CEO) or written off with a reason (admin / CEO). A rep sees his own.
  const shortfallsSection = container.querySelector("#shortfalls-section");
  const shortfallsEl = container.querySelector("#shortfalls");
  async function loadShortfalls() {
    let data;
    try {
      data = await api.getCashShortfalls();
    } catch {
      return;
    }
    if (!root.isConnected) return;
    shortfallsSection.hidden = !data.open.length && !data.closed.length;
    const when = (s) => formatDateDMY(s.confirmed_at || s.created_at);
    const openHtml = data.open
      .map(
        (s) => `<div class="card shortfall-card" data-id="${s.id}">
          <div class="shortfall-main"><div><strong>${escapeHtml(s.user_name)}</strong>
            <div class="muted">${escapeHtml(t("shortfall_meta").replace("{date}", when(s)).replace("{name}", s.counted_by_name || ""))}${s.note ? ` · ${escapeHtml(s.note)}` : ""}</div></div>
            <span class="text-amount shortfall-amount">−${escapeHtml(formatAmd(s.amount_amd))}</span></div>
          ${
            data.can_close || data.can_write_off
              ? `<div class="shortfall-actions">${data.can_close ? `<button type="button" class="btn" data-sf="paid">${t("shortfall_paid_in")}</button>` : ""}${data.can_write_off ? `<button type="button" class="btn" data-sf="written_off">${t("shortfall_write_off")}</button>` : ""}</div>
                 <div class="shortfall-confirm" hidden><input class="shortfall-note" maxlength="300" autocomplete="off" /><button type="button" class="btn btn-primary" data-sf-save>${t("save")}</button></div>
                 <p class="form-error" hidden></p>`
              : ""
          }
        </div>`
      )
      .join("");
    const closedHtml = data.closed.length
      ? `<details class="shortfall-closed"><summary>${escapeHtml(t("shortfall_closed").replace("{n}", data.closed.length))}</summary>${data.closed
          .map((s) => `<div class="card shortfall-card shortfall-card-closed"><div class="shortfall-main"><div><strong>${escapeHtml(s.user_name)}</strong>
            <div class="muted">${escapeHtml(t(s.status === "paid" ? "shortfall_status_paid" : "shortfall_status_written_off"))} · ${escapeHtml(formatDateDMY(s.closed_at))}${s.closed_by_name ? ` · ${escapeHtml(s.closed_by_name)}` : ""}${s.close_note ? ` · ${escapeHtml(s.close_note)}` : ""}</div></div>
            <span class="text-amount">${escapeHtml(formatAmd(s.amount_amd))}</span></div></div>`)
          .join("")}</details>`
      : "";
    shortfallsEl.innerHTML = openHtml + closedHtml;
  }
  // Paid in / Write off: one tap opens the note field (a write-off needs the reason), Save closes it -- no "are you sure?" dialog.
  shortfallsEl.addEventListener("click", async (e) => {
    const card = e.target.closest(".shortfall-card[data-id]");
    if (!card) return;
    const confirmBox = card.querySelector(".shortfall-confirm");
    const errEl = card.querySelector(".form-error");
    const pick = e.target.closest("[data-sf]");
    if (pick) {
      card.dataset.how = pick.dataset.sf;
      card.querySelectorAll("[data-sf]").forEach((b) => b.classList.toggle("btn-primary", b === pick));
      confirmBox.hidden = false;
      const note = confirmBox.querySelector(".shortfall-note");
      note.placeholder = t(pick.dataset.sf === "paid" ? "shortfall_note_paid" : "shortfall_note_write_off");
      note.focus();
      return;
    }
    if (e.target.closest("[data-sf-save]")) {
      const note = confirmBox.querySelector(".shortfall-note").value.trim();
      if (card.dataset.how === "written_off" && note.length < 3) {
        errEl.textContent = t("shortfall_reason_needed");
        errEl.hidden = false;
        return;
      }
      e.target.disabled = true;
      try {
        await api.closeCashShortfall(Number(card.dataset.id), card.dataset.how, note);
        showToast(t("cf_saved"));
        await loadShortfalls();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        e.target.disabled = false;
      }
    }
  });

  // Daily cash sheets (1.453.0): made when the director confirms a rep's cash; the bot posts each to the accounting Telegram group, the
  // accountant marks it "Recorded in Excel" (or the sync closes it when the Excel has every payment). Open ones first.
  async function loadSheets() {
    let data;
    try {
      data = await api.listCashSheets();
    } catch {
      sheetsSection.hidden = true;
      return;
    }
    sheetsSection.hidden = !data.sheets.length;
    sheetsEl.innerHTML = data.sheets
      .map(
        (s) => `
      <div class="card cash-sheet-row" data-sheet="${s.id}">
        <div class="list-row-top">
          <strong>№${s.id} · ${escapeHtml(s.rep_name ?? "—")}</strong>
          <span class="list-row-trailing-text text-amount">${formatAmd(s.total_amd)}</span>
        </div>
        <div class="muted list-row-meta">${formatDateDMY(s.sheet_date)} · ${t("handoff_items_n").replace("{n}", s.item_count)} · ${escapeHtml(s.director_name ?? "")}${
          s.counted_amd !== s.total_amd ? ` · <span class="text-danger">${t("cash_sheet_counted").replace("{amount}", formatAmd(s.counted_amd))}</span>` : ""
        }</div>
        <div class="cash-sheet-status">
          <span class="badge ${s.posted_at ? "badge-success" : "badge-neutral"}">${t(s.posted_at ? "cash_sheet_posted" : "cash_sheet_not_posted")}</span>
          <span class="badge ${s.recorded_at ? "badge-success" : "badge-warning"}">${
            s.recorded_at ? (s.recorded_auto ? t("cash_sheet_recorded_auto") : t("cash_sheet_recorded")) : t("cash_sheet_not_recorded")
          }</span>
        </div>
        <div class="cash-sheet-actions">
          <button type="button" class="btn btn-sm" data-sheet-xlsx="${s.id}">${t("cash_sheet_excel")}</button>
          ${
            data.can_record
              ? `<button type="button" class="btn btn-sm ${s.recorded_at ? "" : "btn-primary"}" data-sheet-record="${s.id}" data-on="${s.recorded_at ? "0" : "1"}">${
                  s.recorded_at ? t("cash_sheet_unmark") : t("cash_sheet_mark")
                }</button>`
              : ""
          }
        </div>
      </div>`
      )
      .join("");
    sheetsEl.querySelectorAll("[data-sheet-xlsx]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await downloadFromUrl(`/api/cash-sheets/${b.dataset.sheetXlsx}/xlsx`, `cash-sheet-${b.dataset.sheetXlsx}.xlsx`);
        } catch (err) {
          showToast(err.message);
        }
        b.disabled = false;
      })
    );
    sheetsEl.querySelectorAll("[data-sheet-record]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        const on = b.dataset.on === "1";
        try {
          await api.markCashSheetRecorded(Number(b.dataset.sheetRecord), on);
          showToast(on ? t("cash_sheet_recorded") : t("cash_sheet_not_recorded"), {
            actionLabel: t("undo"),
            onAction: () => api.markCashSheetRecorded(Number(b.dataset.sheetRecord), !on).then(loadSheets),
          });
          await loadSheets();
        } catch (err) {
          showToast(err.message);
          b.disabled = false;
        }
      })
    );
  }

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
    // Declaring a rep's cash on their behalf is only legal into the actor's
    // OWN custody (server checkOnBehalf; admin may pick anyone), so don't
    // offer the other receivers -- they would only produce an error.
    if (actingFor && role !== "admin") data.recipients = data.recipients.filter((r) => r.id === state.user.id);
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
            <div class="handoff-pick-head">
              <strong>${t("handoff_pick_title")}</strong>
              <button type="button" class="rps-link" id="handoff-pick-toggle"></button>
            </div>
            <div class="handoff-pick-list" id="handoff-pick-list">
              ${groupByDay(data.payments)
                .map(
                  (g) => `<div class="handoff-pick-day"><span>${escapeHtml(g.label)}</span><span class="muted">${g.rows.length} &middot; ${formatAmd(sumAmd(g.rows))}</span></div>
                ${g.rows
                  .map(
                    (p) => `<label class="handoff-pick-row">
                      <input type="checkbox" data-pick="${p.id}" checked />
                      <span class="handoff-pick-main"><strong>${escapeHtml(p.customer_name_snapshot || "")}</strong><span class="muted">${p.erp_customer_id_snapshot ? `ID ${escapeHtml(p.erp_customer_id_snapshot)} · ` : ""}${escapeHtml(channelDisplayLabel(p.sales_channel || "—"))}</span></span>
                      <span class="text-amount">${formatAmd(Number(p.amount_amd))}</span>
                    </label>`
                  )
                  .join("")}`
                )
                .join("")}
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
      <button type="button" class="btn btn-primary btn-block desk-inline" id="handoff-submit-all" ${canSubmit ? "" : "disabled"}>
        ${t("handoff_submit_all")}
      </button>
      </form>
    `;
    availableEl.querySelector("#handoff-form").addEventListener("submit", (e) => e.preventDefault());
    // On a computer: the tables' dropdown chips instead of window-wide selects (desktop roadmap step 9).
    deskSelectChip(availableEl.querySelector("#handoff-sender-select"), "");
    deskSelectChip(availableEl.querySelector("#handoff-recipient-select"), "");

    const senderSelect = availableEl.querySelector("#handoff-sender-select");
    if (senderSelect) {
      senderSelect.addEventListener("change", () => {
        actingFor = senders.find((s) => String(s.id) === senderSelect.value) || null;
        loadAvailable();
      });
    }

    // Hand over one by one (owner, 2026-11-13): every payment is ticked at first; untick what stays with you. The button and the
    // total follow the ticks.
    const submitBtn = availableEl.querySelector("#handoff-submit-all");
    const boxes = [...availableEl.querySelectorAll("[data-pick]")];
    const picked = () => {
      const ids = new Set(boxes.filter((b) => b.checked).map((b) => Number(b.dataset.pick)));
      return (data.payments || []).filter((p) => ids.has(p.id));
    };
    const toggleBtn = availableEl.querySelector("#handoff-pick-toggle");
    function syncPicked() {
      const rows = picked();
      const all = rows.length === boxes.length;
      submitBtn.disabled = !canSubmit || rows.length === 0;
      submitBtn.textContent = all ? t("handoff_submit_all") : t("handoff_submit_selected").replace("{n}", String(rows.length)).replace("{amount}", formatAmd(sumAmd(rows)));
      if (toggleBtn) toggleBtn.textContent = all ? t("handoff_pick_none") : t("handoff_pick_all");
      boxes.forEach((b) => b.closest(".handoff-pick-row")?.classList.toggle("handoff-pick-off", !b.checked));
    }
    boxes.forEach((b) => b.addEventListener("change", syncPicked));
    toggleBtn?.addEventListener("click", () => {
      const all = picked().length === boxes.length;
      boxes.forEach((b) => (b.checked = !all));
      syncPicked();
    });
    if (boxes.length) syncPicked();
    submitBtn.addEventListener("click", () => {
      const recipientSelect = availableEl.querySelector("#handoff-recipient-select");
      const chosen = Number(recipientSelect?.value);
      // the receiver picked on the screen comes first in the sheet
      const recipients = [...data.recipients].sort((a, b) => (b.id === chosen) - (a.id === chosen));
      openHandoverSheet({ payments: picked(), recipients, onBehalfOf: actingFor?.id, onDone: () => Promise.all([loadAvailable(), loadInbox()]) });
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
              ${customerNameLinkHtml(p.customer_name_snapshot, p.customer_id, "span", "order-line-name")}
              <strong class="text-amount">${formatAmd(Number(p.amount_amd))}</strong>
            </div>
            <span class="order-line-meta">${escapeHtml(p.sales_channel ? channelDisplayLabel(p.sales_channel) : "—")} · ${escapeHtml(
              p.sales_manager_name_snapshot
            )} · ${formatDateTime(p.payment_date)}</span>
          </div>`
          )
          .join("")}
      </div>
      ${handoff.rejection_reason ? `<p class="form-error" style="position:static;">${escapeHtml(handoff.rejection_reason)}</p>` : ""}
      ${
        handoff.status === "confirmed" && handoff.counted_amd !== null && handoff.counted_amd !== handoff.amount_amd
          ? `<p class="handoff-diff-note">${t("cash_sheet_counted").replace("{amount}", formatAmd(handoff.counted_amd))}${
              handoff.discrepancy_note ? ` — ${escapeHtml(handoff.discrepancy_note)}` : ""
            }</p>`
          : ""
      }
      ${
        handoff.cash_sheet
          ? `<p class="muted">${t("cash_sheet_line").replace("{id}", handoff.cash_sheet.id)} · ${t(handoff.cash_sheet.posted_at ? "cash_sheet_posted" : "cash_sheet_not_posted")} · ${t(
              handoff.cash_sheet.recorded_at ? "cash_sheet_recorded" : "cash_sheet_not_recorded"
            )}</p>`
          : ""
      }
      ${
        canDecide
          ? `<form class="handoff-decide" id="handoff-decide" novalidate>
              <label>${t("handoff_counted_label")}<input id="handoff-counted" value="${formatAmd(handoff.amount_amd).replace(/[^\d,]/g, "")}" /></label>
              <p class="handoff-diff" id="handoff-diff" hidden></p>
              <label id="handoff-note-wrap" hidden>${t("handoff_discrepancy_note")}<input id="handoff-note" maxlength="500" autocomplete="off" /></label>
              <label id="handoff-reason-wrap" hidden>${t("handoff_reject_reason_label")}<input id="handoff-reason" maxlength="300" autocomplete="off" /></label>
            </form>`
          : ""
      }
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
    activateCustomerNameLinks(overlay, (hash) => leaveSheetTo(overlay, navigate, hash));

    async function act(fn) {
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      errorEl.hidden = true;
      try {
        await fn();
        overlay.remove();
        window.dispatchEvent(new Event("payments-changed"));
        await Promise.all([loadInbox(), loadAvailable(), loadSheets(), loadShortfalls()]);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    }

    // Count, then confirm (owner, 2026-10-28): the counted amount starts at the expected total; a different amount turns the button into
    // "Confirm with discrepancy" and asks what happened. Reject asks for the reason in the sheet (no browser pop-ups).
    const countedInput = overlay.querySelector("#handoff-counted");
    const noteWrap = overlay.querySelector("#handoff-note-wrap");
    const diffEl = overlay.querySelector("#handoff-diff");
    const confirmBtn = overlay.querySelector("#handoff-confirm-btn");
    overlay.querySelector("#handoff-decide")?.addEventListener("submit", (e) => e.preventDefault());
    const counted = () => Number(String(countedInput?.value ?? "").replace(/\D/g, ""));
    const paintDiff = () => {
      if (!countedInput) return;
      const diff = counted() - Math.round(handoff.amount_amd);
      diffEl.hidden = noteWrap.hidden = diff === 0;
      diffEl.textContent = diff === 0 ? "" : t("handoff_diff").replace("{amount}", `${diff > 0 ? "+" : "−"}${formatAmd(Math.abs(diff))}`);
      confirmBtn.textContent = diff === 0 ? t("handoff_confirm") : t("handoff_confirm_with_diff");
      confirmBtn.classList.toggle("btn-warning", diff !== 0);
    };
    if (countedInput) bindAmdInput(countedInput, paintDiff);
    confirmBtn?.addEventListener("click", () => {
      const note = overlay.querySelector("#handoff-note").value.trim();
      if (!countedInput.value.trim()) return countedInput.focus();
      if (counted() !== Math.round(handoff.amount_amd) && !note) {
        errorEl.textContent = t("handoff_discrepancy_note_needed");
        errorEl.hidden = false;
        return overlay.querySelector("#handoff-note").focus();
      }
      act(() => api.confirmCashHandoff(handoff.id, { counted_amd: counted(), note: note || undefined }));
    });
    overlay.querySelector("#handoff-reject-btn")?.addEventListener("click", () => {
      const wrap = overlay.querySelector("#handoff-reason-wrap");
      const input = overlay.querySelector("#handoff-reason");
      if (wrap.hidden) {
        wrap.hidden = false;
        return input.focus();
      }
      if (!input.value.trim()) return input.focus();
      act(() => api.rejectCashHandoff(handoff.id, input.value.trim()));
    });
  }

  await loadInbox();
  await loadAvailable();
  loadSheets();
  loadShortfalls();
  if (focusHandoffId) openHandoffSheet(Number(focusHandoffId));
  // From the Home card "Hand over today's cash": straight to the one confirm step when there is cash and one place to give it.
  else if (handover) availableEl.querySelector("#handoff-submit-all:not([disabled])")?.click();
}
