// The Requests screen and the full-screen request card (owner, 2026-11-08: "All requests (discount approval, edits in customer card,
// etc) should come also with push notification so that user can open it and choose approve or deny the requests. Tap on notification
// should give full details what is requested."). A push opens #/requests/<kind>/<id>; the list #/requests shows everything waiting
// that this person may decide, newest first, grouped by kind. Approve / Deny call each kind's OWN endpoint (the same server checks as
// its own screen); the server (system/routes/requests.js) says whether this person may decide it. Deny needs a written reason (an
// inline field, no dialog); Approve is one tap, except a payment: two taps, as on the Payments screen.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatAmd, formatDateTime, groupDigits, labelColon, showToast } from "../util.js";
import { refreshAllBadgesFromServer } from "../badges.js";

const KINDS = ["discount", "return", "customer_edit", "payment", "cashflow", "visit_plan", "perf_plan", "bonus_claim"];

const BACK_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;

const kindLabel = (kind, request) => t(kind === "return" && (request?.details?.return_kind === "cancel" || request?.extra === "cancel") ? "req_kind_cancel" : `req_kind_${kind}`);

// Each kind's own approve / deny endpoint (the server checks who may, exactly as on that kind's own screen).
const DECIDE = {
  discount: { approve: (r) => api.approveOrderDiscount(r.id), deny: (r, reason) => api.rejectOrderDiscount(r.id, reason) },
  return: { approve: (r) => api.approveReturn(r.id), deny: (r, reason) => api.rejectReturn(r.id, reason) },
  customer_edit: { approve: (r) => api.reviewEditRequest(r.id, "approve"), deny: (r, reason) => api.reviewEditRequest(r.id, "reject", reason) },
  payment: { approve: (r) => api.approvePayment(r.id), deny: (r, reason) => api.rejectPayment(r.id, reason) },
  cashflow: { approve: (r) => api.decideCashRequest(r.id, "approve"), deny: (r, reason) => api.decideCashRequest(r.id, "reject", reason) },
  visit_plan: { approve: (r) => api.reviewVisitPlan(r.id, "approve"), deny: (r, reason) => api.reviewVisitPlan(r.id, "reject", reason) },
  perf_plan: { approve: (r) => api.approvePerfPlan(r.id), deny: (r, reason) => api.rejectPerfPlan(r.id, reason) },
  bonus_claim: { approve: (r) => api.approveBonusRewardClaim(r.id, r.version), deny: (r, reason) => api.rejectBonusRewardClaim(r.id, reason, r.version) },
};
// what each decision changes elsewhere in the app, so those screens and badges catch up at once
const CHANGED_EVENTS = { discount: "orders-changed", customer_edit: "edit-requests-changed", visit_plan: "plans-changed", payment: "payments-changed" };

const amd = (v) => (v === null || v === undefined ? "" : formatAmd(Math.round(Number(v))));
const row = (label, value, cls = "") => `<div class="req-row ${cls}"><span class="req-row-label">${escapeHtml(label)}</span><span class="req-row-value">${value}</span></div>`;
const header = (title, rightHtml = "") => `
  <div class="detail-header">
    <button class="icon-btn" id="back-btn" aria-label="${t("back")}">${BACK_ICON}</button>
    <div class="detail-header-title"><h1>${escapeHtml(title)}</h1></div>
    <div class="detail-header-actions">${rightHtml}</div>
  </div>`;

// ---- The list -------------------------------------------------------------------------------------------------------------------------

export function renderRequests(root, navigate) {
  root.innerHTML = `<div class="detail-view req-view">${header(t("req_title"))}<div id="req-list" class="req-list"><p class="loading-state" role="status">${t("loading")}</p></div></div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = root.querySelector("#req-list");
  let lastJson = "";

  async function load() {
    let data;
    try {
      data = await api.listRequests();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const json = JSON.stringify(data.items);
    if (json === lastJson) return;
    lastJson = json;
    paint(data.items);
  }

  function paint(items) {
    if (!items.length) {
      listEl.innerHTML = `<p class="empty-state">${t("req_empty")}</p>`;
      return;
    }
    listEl.innerHTML = KINDS.map((kind) => {
      const group = items.filter((i) => i.kind === kind);
      if (!group.length) return "";
      return `
        <section class="req-group" aria-label="${escapeHtml(t(`req_kind_${kind}`))}">
          <h2 class="req-group-title">${escapeHtml(t(`req_kind_${kind}`))} <span class="count-badge req-group-count">${group.length}</span></h2>
          ${group.map((i) => itemHtml(i)).join("")}
        </section>`;
    }).join("");
    listEl.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => navigate(el.dataset.open)));
  }

  function itemHtml(i) {
    const who = i.customer_name || i.requested_by_name || "";
    const sub = [
      i.customer_name ? i.requested_by_name : null,
      i.erp_id ? `ID ${i.erp_id}` : null,
      i.extra === i.requested_by_name ? null : extraText(i),
      i.requested_at ? formatDateTime(i.requested_at) : null,
    ].filter(Boolean);
    return `
      <button type="button" class="card req-item" data-open="#/requests/${i.kind}/${i.id}">
        <span class="req-item-main">
          <strong class="req-item-who">${escapeHtml(who)}</strong>
          <span class="req-item-sub muted">${escapeHtml(sub.join(" · "))}</span>
        </span>
        ${i.amount_amd !== null && i.amount_amd !== undefined ? `<span class="req-item-amount">${escapeHtml(amd(i.amount_amd))}</span>` : ""}
      </button>`;
  }

  function extraText(i) {
    if (!i.extra) return null;
    if (i.kind === "return") return t(i.extra === "cancel" ? "req_kind_cancel" : "req_return_kind_return");
    if (i.kind === "cashflow") return t(i.extra === "delete" ? "req_cf_delete" : "req_cf_update");
    if (i.kind === "customer_edit") return String(i.extra).split(",").filter((f) => f !== "lng").map(fieldLabel).join(", ");
    return String(i.extra);
  }

  load();
  const cleanup = () => {};
  // Back from a card: the list catches up with what was just decided
  cleanup.onRestore = load;
  return cleanup;
}

// ---- The card -------------------------------------------------------------------------------------------------------------------------

const FIELD_KEYS = new Set(["lat", "visit_frequency_days", "assigned_manager_id", "credit_term_days", "payment_method", "customer_tier", "notes", "tin", "legal_name", "legal_address"]);
function fieldLabel(field) {
  if (FIELD_KEYS.has(field)) return t(`req_field_${field}`);
  const text = t(field);
  return text === field ? field.replace(/_/g, " ") : text;
}
const valueText = (v) => (v === null || v === undefined || v === "" ? "–" : String(v));

export function renderRequestCard(root, navigate, kind, id) {
  root.innerHTML = `<div class="detail-view req-view">${header(t(`req_kind_${kind}`) || t("req_title"))}<div id="req-card"><p class="loading-state" role="status">${t("loading")}</p></div></div>`;
  const view = root.querySelector(".req-view");
  const back = () => navigate.goBack("#/requests");
  root.querySelector("#back-btn").addEventListener("click", back);
  const cardEl = root.querySelector("#req-card");
  let request = null;

  async function load() {
    try {
      request = await api.getRequest(kind, id);
    } catch (err) {
      const text = err.status === 403 ? t("req_not_allowed") : err.status === 404 ? t("req_not_found") : err.message;
      cardEl.innerHTML = `<p class="empty-state">${escapeHtml(text)}</p>`;
      view.querySelector(".req-bar")?.remove();
      return;
    }
    paint();
  }

  function paint() {
    const r = request;
    view.querySelector(".detail-header-title h1").textContent = kindLabel(kind, r);
    cardEl.innerHTML = `
      ${statusHtml(r)}
      <section class="card req-section">
        ${row(t("req_asked_by"), `<strong>${escapeHtml(r.requested_by_name ?? "–")}</strong>${r.requested_at ? `<span class="muted req-when">${escapeHtml(formatDateTime(r.requested_at))}</span>` : ""}`)}
        ${r.customer ? row(t("req_customer"), `<strong>${escapeHtml(r.customer.name ?? "")}</strong>${r.customer.erp_id ? `<span class="muted req-when">ID ${escapeHtml(r.customer.erp_id)}</span>` : ""}`) : ""}
        ${r.amount_amd !== null && r.amount_amd !== undefined ? row(kind === "perf_plan" ? t("req_sales_target") : t("req_amount"), `<strong class="req-amount">${escapeHtml(amd(r.amount_amd))}</strong>`) : ""}
        ${r.note ? row(kind === "bonus_claim" ? t("req_on_hold") : t("req_note"), escapeHtml(r.note), "req-row-note") : ""}
      </section>
      ${detailsHtml(r)}
      ${r.source_url ? `<a class="btn btn-block req-source" href="${escapeHtml(String(r.source_url).replace(/^\/?/, "/"))}">${t("req_open_source")}</a>` : ""}
    `;
    cardEl.querySelector(".req-source")?.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(String(r.source_url).replace(/^\/?#?/, "#"));
    });
    paintBar();
  }

  function statusHtml(r) {
    if (r.status === "pending" && r.can_decide) return "";
    if (r.status === "pending") return `<div class="req-status req-status-pending" role="status">${escapeHtml(t("req_waiting_other"))}</div>`;
    if (r.status === "closed") return `<div class="req-status req-status-closed" role="status">${escapeHtml(t("req_closed"))}</div>`;
    const approved = r.status === "approved";
    const who = r.decided_by_name ? t(approved ? "req_already_approved" : "req_already_denied").replace("{name}", r.decided_by_name) : t(approved ? "req_done_approved" : "req_done_denied");
    return `
      <div class="req-status ${approved ? "req-status-approved" : "req-status-denied"}" role="status">
        <strong>${approved ? "✓" : "✕"} ${escapeHtml(who)}</strong>
        ${r.decided_at ? `<span class="req-status-when">${escapeHtml(formatDateTime(r.decided_at))}</span>` : ""}
        ${!approved && r.decision_reason ? `<span class="req-status-reason">${escapeHtml(t("req_reason"))}${labelColon()}${escapeHtml(r.decision_reason)}</span>` : ""}
      </div>`;
  }

  // The fixed bottom bar: big Deny / Approve; Deny turns it into the reason field.
  function paintBar(mode = "buttons", errorText = "") {
    let bar = view.querySelector(".req-bar");
    if (!(request?.status === "pending" && request.can_decide)) {
      bar?.remove();
      view.classList.remove("req-view-has-bar");
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "req-bar";
      view.appendChild(bar);
    }
    view.classList.add("req-view-has-bar");
    const err = errorText ? `<p class="form-error req-bar-error" role="alert">${escapeHtml(errorText)}</p>` : "";
    if (mode === "deny") {
      bar.innerHTML = `
        ${err}
        <label class="req-reason-label" for="req-reason">${escapeHtml(t("req_deny_reason"))}</label>
        <textarea id="req-reason" class="req-reason" rows="2" maxlength="500" placeholder="${escapeHtml(t("req_deny_placeholder"))}"></textarea>
        <div class="req-bar-buttons">
          <button type="button" class="btn req-btn" data-act="cancel">${escapeHtml(t("cancel"))}</button>
          <button type="button" class="btn req-btn req-btn-deny-send" data-act="deny-send" disabled>${escapeHtml(t("req_deny"))}</button>
        </div>`;
      const field = bar.querySelector("#req-reason");
      const send = bar.querySelector('[data-act="deny-send"]');
      field.addEventListener("input", () => (send.disabled = !field.value.trim()));
      field.focus();
      bar.querySelector('[data-act="cancel"]').addEventListener("click", () => paintBar());
      send.addEventListener("click", () => {
        const reason = field.value.trim();
        if (!reason) return paintBar("deny", t("req_reason_required"));
        decide("deny", reason);
      });
      return;
    }
    bar.innerHTML = `
      ${err}
      <div class="req-bar-buttons">
        <button type="button" class="btn req-btn req-btn-deny" data-act="deny">${escapeHtml(t("req_deny"))}</button>
        <button type="button" class="btn btn-primary req-btn req-btn-approve" data-act="approve">${escapeHtml(t("req_approve"))}</button>
      </div>`;
    bar.querySelector('[data-act="deny"]').addEventListener("click", () => paintBar("deny"));
    const approveBtn = bar.querySelector('[data-act="approve"]');
    approveBtn.addEventListener("click", () => {
      // money: two taps, as on the Payments screen (an approved payment lands on the approver's desk)
      if (kind === "payment" && approveBtn.dataset.armed !== "1") {
        approveBtn.dataset.armed = "1";
        approveBtn.textContent = t("req_tap_again");
        setTimeout(() => {
          if (approveBtn.isConnected && approveBtn.dataset.armed === "1") {
            approveBtn.dataset.armed = "";
            approveBtn.textContent = t("req_approve");
          }
        }, 3000);
        return;
      }
      decide("approve");
    });
  }

  let busy = false;
  async function decide(action, reason = "") {
    if (busy || !request) return;
    busy = true;
    view.querySelectorAll(".req-bar button, .req-bar textarea").forEach((el) => (el.disabled = true));
    try {
      if (action === "approve") await DECIDE[kind].approve(request);
      else await DECIDE[kind].deny(request, reason);
      showToast(t(action === "approve" ? "req_done_approved" : "req_done_denied"));
      if (CHANGED_EVENTS[kind]) window.dispatchEvent(new Event(CHANGED_EVENTS[kind]));
      refreshAllBadgesFromServer({ force: true });
      busy = false;
      await load();
    } catch (err) {
      busy = false;
      // someone else decided first (409) or the server refused: show the request as it is now, with the reason next to the buttons
      try {
        request = await api.getRequest(kind, id);
        paint();
      } catch {
        // keep what is on screen
      }
      if (request?.status === "pending" && request.can_decide) paintBar(action === "deny" ? "deny" : "buttons", err.message);
      if (action === "deny" && request?.status === "pending" && request.can_decide) {
        const field = view.querySelector("#req-reason");
        if (field) {
          field.value = reason;
          view.querySelector('[data-act="deny-send"]').disabled = false;
        }
      }
    }
  }

  load();
}

// ---- What each kind asks for ----------------------------------------------------------------------------------------------------------

function detailsHtml(r) {
  const d = r.details ?? {};
  switch (r.kind) {
    case "discount":
      return discountHtml(d);
    case "return":
      return `
        <section class="card req-section">
          ${row(t("req_order"), escapeHtml(d.order_code ?? ""))}
          ${row(t("req_reason"), escapeHtml(t(`rt_reason_${d.reason}`)))}
          <h3 class="req-section-title">${escapeHtml(t(d.return_kind === "cancel" ? "req_kind_cancel" : "req_return_kind_return"))}</h3>
          ${(d.lines ?? [])
            .map((l) => `<div class="req-line"><span class="req-line-name">${escapeHtml(l.product_name)} <span class="muted">× ${escapeHtml(groupDigits(l.quantity))}</span></span>${d.return_kind === "return" ? `<span class="req-line-amount">${escapeHtml(amd(l.line_credit_amd))}</span>` : ""}</div>`)
            .join("")}
        </section>`;
    case "customer_edit":
      return changesHtml(customerChanges(d.changes ?? []));
    case "payment":
      return `
        <section class="card req-section">
          ${d.payment_date ? row(t("req_payment_date"), escapeHtml(formatDateTime(d.payment_date))) : ""}
          ${row(t("req_manager"), escapeHtml([d.manager_name, d.sales_channel].filter(Boolean).join(" · ")))}
          ${d.in_handoff ? `<p class="req-warn" role="note">${escapeHtml(t("req_in_handoff"))}</p>` : ""}
        </section>`;
    case "cashflow": {
      const e = d.entry ?? {};
      const cur = d.currency && d.currency !== "AMD" ? ` ${d.currency}` : "";
      return `
        <section class="card req-section">
          <h3 class="req-section-title">${escapeHtml(t(d.action === "delete" ? "req_cf_delete" : "req_cf_update"))}</h3>
          ${row(t("req_cf_date"), escapeHtml(valueText(e.entry_date)))}
          ${row(t("req_cf_amount"), escapeHtml(e.amount === null || e.amount === undefined ? "–" : `${groupDigits(Math.round(Number(e.amount)))}${cur || ` ${t("amd")}`}`))}
          ${row(t("req_cf_category"), escapeHtml(valueText(e.category)))}
          ${row(t("req_cf_account"), escapeHtml(valueText(e.account)))}
          ${e.info ? row(t("req_cf_info"), escapeHtml(e.info)) : ""}
        </section>
        ${d.action === "delete" ? "" : changesHtml((d.changes ?? []).map((c) => ({ label: t(`req_cf_${c.field === "entry_date" ? "date" : c.field}`), old: c.field === "amount" ? groupDigits(Math.round(Number(c.old))) : c.old, new: c.field === "amount" ? groupDigits(Math.round(Number(c.new))) : c.new })))}`;
    }
    case "visit_plan":
      return `
        <section class="card req-section">
          ${row(t("req_plan_day"), escapeHtml(d.plan_date ?? ""))}
          <h3 class="req-section-title">${escapeHtml(t("req_stops"))} <span class="count-badge">${(d.stops ?? []).length}</span></h3>
          <ol class="req-stops">${(d.stops ?? []).map((s) => `<li>${escapeHtml(s.name)}${s.erp_id ? ` <span class="muted">ID ${escapeHtml(s.erp_id)}</span>` : ""}</li>`).join("")}</ol>
        </section>`;
    case "perf_plan":
      return `
        <section class="card req-section">
          ${row(t("req_month"), escapeHtml(`${d.month ?? ""}${d.version > 1 ? ` · v${d.version}` : ""}`))}
          ${(d.targets ?? [])
            .map(
              (x) => `
            <h3 class="req-section-title">${escapeHtml(x.channel ?? "")}</h3>
            ${row(t("req_sales_target"), escapeHtml(amd(x.sales_target_amd)))}
            ${row(t("req_collection_target"), escapeHtml(amd(x.collection_target_amd)))}
            ${x.new_customers_target ? row(t("req_new_customers"), escapeHtml(String(x.new_customers_target))) : ""}`
            )
            .join("")}
        </section>`;
    case "bonus_claim":
      return `
        <section class="card req-section">
          ${row(t("req_challenge"), escapeHtml(d.challenge ?? ""))}
          ${d.start_at ? row(t("req_period"), escapeHtml(`${formatDateTime(d.start_at)} – ${formatDateTime(d.end_at)}`)) : ""}
        </section>`;
    default:
      return "";
  }
}

function discountHtml(d) {
  const warn = d.below_landing ? t("req_below_landing") : d.below_cost ? t("req_below_cost") : "";
  return `
    <section class="card req-section">
      ${row(t("req_order"), escapeHtml(d.order_code ?? ""))}
      ${warn ? `<p class="req-warn" role="note">⚠ ${escapeHtml(warn)}</p>` : ""}
      <h3 class="req-section-title">${escapeHtml(t("req_lines"))}</h3>
      ${(d.lines ?? [])
        .map((l) => {
          const changed = l.list_price_amd !== null && l.list_price_amd !== undefined && l.list_price_amd !== l.unit_price_amd;
          // the pack size only when the name does not already say it ("4L" in "EDGE 5W-30 4L"; "pcs" says nothing)
          const size = l.size && l.size !== "pcs" && !String(l.product_name).toLowerCase().includes(String(l.size).toLowerCase()) ? l.size : "";
          return `
          <div class="req-line${l.below_landing ? " req-line-warn" : ""}">
            <span class="req-line-name">${escapeHtml(l.product_name)}${size ? ` <span class="muted">${escapeHtml(size)}</span>` : ""}
              <span class="req-line-price muted">${escapeHtml(groupDigits(l.quantity))} × ${changed ? `<s>${escapeHtml(groupDigits(l.list_price_amd))}</s> → ` : ""}${escapeHtml(amd(l.unit_price_amd))}${l.below_landing ? ` · ⚠ ${escapeHtml(t("req_below_landing_short"))}` : ""}</span>
            </span>
            <span class="req-line-amount">${escapeHtml(amd(l.line_total_amd))}</span>
          </div>`;
        })
        .join("")}
      <div class="req-totals">
        ${d.discount_amd > 0 ? row(t("req_subtotal"), escapeHtml(amd(d.subtotal_amd))) : ""}
        ${d.discount_amd > 0 ? row(t("req_discount"), `<strong class="req-discount">−${escapeHtml(amd(d.discount_amd))} (${escapeHtml(String(d.discount_pct))}%)</strong>`) : ""}
        ${d.margin_pct !== null && d.margin_pct !== undefined ? row(t("req_margin"), `<span class="${d.margin_pct < 0 ? "req-negative" : ""}">${escapeHtml(String(d.margin_pct))}%</span>`) : ""}
      </div>
    </section>`;
}

// lat + lng are one "map pin" row
function customerChanges(changes) {
  const out = [];
  const lat = changes.find((c) => c.field === "lat");
  const lng = changes.find((c) => c.field === "lng");
  for (const c of changes) {
    if (c.field === "lng") continue;
    if (c.field === "lat") {
      const pin = (a, b) => (a === null || a === undefined ? null : `${Number(a).toFixed(5)}, ${Number(b).toFixed(5)}`);
      out.push({ label: fieldLabel("lat"), old: pin(lat?.old, lng?.old), new: pin(lat?.new, lng?.new) });
      continue;
    }
    out.push({ label: fieldLabel(c.field), old: c.old, new: c.new });
  }
  return out;
}

function changesHtml(changes) {
  if (!changes.length) return "";
  return `
    <section class="card req-section">
      <h3 class="req-section-title">${escapeHtml(t("req_changes"))}</h3>
      ${changes
        .map(
          (c) => `
        <div class="req-change">
          <span class="req-change-label">${escapeHtml(c.label)}</span>
          <span class="req-change-values"><span class="req-old">${escapeHtml(valueText(c.old))}</span><span class="req-arrow" aria-hidden="true">→</span><strong class="req-new">${escapeHtml(valueText(c.new))}</strong></span>
        </div>`
        )
        .join("")}
    </section>`;
}
