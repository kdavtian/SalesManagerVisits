// Accountant "Recorded" screen (v3 spec section 6): every delivered order
// listed with its POD signature/debt/payment snapshot until an accountant
// (or CEO/admin, who can see the same backlog to catch it before it piles
// up) checks it off against the Excel books. This screen never decides
// whether an order is paid -- Excel remains that source of truth -- it
// only tracks whether someone has looked at each delivered order.
import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Desktop only (see .recorded-layout in styles.css): a persistent
// right-hand detail pane next to a compact left-hand list, instead of
// every row's full card plus a "View signature" modal. Read once per
// load rather than tracked on resize, matching the rest of this
// project's desktop-breakpoint checks (see settings.js's
// openAdminSection).
function isDesktopView() {
  return window.matchMedia("(min-width: 1024px)").matches;
}

export async function renderRecorded(root, navigate) {
  let activeTab = "unrecorded";
  let lastRows = [];
  let selectedId = null;

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_recorded")}</h1></div>
      </div>
      <div class="segmented" id="recorded-tabs">
        <button type="button" class="chip chip-active" data-tab="unrecorded">${t("recorded_tab_unrecorded")}</button>
        <button type="button" class="chip" data-tab="recorded">${t("recorded_tab_recorded")}</button>
      </div>
      <p class="form-error" id="recorded-error" hidden></p>
      <div class="recorded-layout" id="recorded-layout">
        <div id="recorded-list" class="card-list" style="margin-top:12px;"></div>
        <div class="recorded-detail-pane" id="recorded-detail-pane" hidden></div>
      </div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#recorded-list");
  const detailPane = container.querySelector("#recorded-detail-pane");
  const errorEl = container.querySelector("#recorded-error");
  const tabsEl = container.querySelector("#recorded-tabs");

  tabsEl.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("chip-active", b.dataset.tab === activeTab));
      selectedId = null;
      load();
    });
  });

  // Desktop compact list row -- name/date/amount/status only, click
  // selects it into the detail pane. The mobile card (rowHtml below)
  // carries everything inline instead, so it has no use for this.
  function compactRowHtml(r) {
    const badge = r.recorded
      ? `<span class="badge badge-success">${t("recorded_recorded_by")}</span>`
      : `<span class="badge badge-warning">${t("recorded_tab_unrecorded")}</span>`;
    return `
      <button type="button" class="card list-row ${r.id === selectedId ? "recorded-row-active" : ""}" data-select-row="${r.id}">
        <div class="list-row-body">
          <div class="list-row-top"><strong>${escapeHtml(r.customer_name)}</strong></div>
          <div class="muted list-row-meta">${formatDate(r.delivered_at)} &bull; ${formatAmd(Number(r.total_amd))}</div>
        </div>
        ${badge}
      </button>`;
  }

  function rowHtml(r) {
    const outstanding =
      r.debt_balance_before_amd != null ? Number(r.debt_balance_before_amd) + Number(r.total_amd) - Number(r.amount_collected_amd || 0) : null;
    return `
      <div class="card">
        <div class="order-detail-ids">
          <span>${t("customer_id_label")}: ${escapeHtml(r.erp_customer_id || "")}</span>
          ${r.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(r.order_code)}</span>` : ""}
        </div>
        <strong>${escapeHtml(r.customer_name)}</strong>
        <p class="muted">${t("delivery_open_stop")}: ${formatDate(r.delivered_at)}</p>
        <p><span class="text-amount">${formatAmd(Number(r.total_amd))}</span></p>
        ${
          r.amount_collected_amd != null
            ? `<p class="muted">${t("delivery_amount_collected")}: ${formatAmd(Number(r.amount_collected_amd))}${r.payment_method ? ` · ${t(r.payment_method === "cash" ? "payment_method_cash" : "payment_method_other")}` : ""}</p>`
            : ""
        }
        ${outstanding != null ? `<p class="muted">${t("delivery_new_balance")}: ${formatAmd(outstanding)}</p>` : ""}
        <button type="button" class="link-btn" data-view-signature="${r.id}">${t("recorded_view_signature")}</button>
        ${
          r.pod_record_id && Number(r.amount_collected_amd) > 0
            ? r.payment_id
              ? `<button type="button" class="link-btn" data-view-payment="${r.payment_id}">${t("recorded_view_payment")}</button>`
              : `<button type="button" class="link-btn" data-create-payment="${r.pod_record_id}">${t("recorded_create_payment")}</button>`
            : ""
        }
        <div class="sheet-actions" style="margin-top:8px;">
          ${
            r.recorded
              ? `<span class="muted">${t("recorded_recorded_by")}: ${escapeHtml(r.recorded_by_name || "")}</span>
                 <button type="button" class="btn" data-unrecord="${r.id}">${t("recorded_undo")}</button>`
              : `<button type="button" class="btn btn-primary btn-block" data-record="${r.id}">${t("recorded_mark_recorded")}</button>`
          }
        </div>
      </div>`;
  }

  // Desktop detail pane -- same fields as the mobile card, but the
  // signature is always visible inline instead of behind a "View
  // signature" button/modal, since the pane already has the room.
  function detailPaneHtml(r) {
    const outstanding =
      r.debt_balance_before_amd != null ? Number(r.debt_balance_before_amd) + Number(r.total_amd) - Number(r.amount_collected_amd || 0) : null;
    return `
      <div class="order-detail-ids">
        <span>${t("customer_id_label")}: ${escapeHtml(r.erp_customer_id || "")}</span>
        ${r.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(r.order_code)}</span>` : ""}
      </div>
      <h2 class="section-title">${escapeHtml(r.customer_name)}</h2>
      <p class="muted">${t("delivery_open_stop")}: ${formatDate(r.delivered_at)}</p>
      <p><span class="text-amount">${formatAmd(Number(r.total_amd))}</span></p>
      ${
        r.amount_collected_amd != null
          ? `<p class="muted">${t("delivery_amount_collected")}: ${formatAmd(Number(r.amount_collected_amd))}${r.payment_method ? ` · ${t(r.payment_method === "cash" ? "payment_method_cash" : "payment_method_other")}` : ""}</p>`
          : ""
      }
      ${outstanding != null ? `<p class="muted">${t("delivery_new_balance")}: ${formatAmd(outstanding)}</p>` : ""}
      <img src="${api.podSignatureUrl(r.id)}" alt="${t("delivery_signature_label")}" style="width:100%;max-width:360px;border-radius:8px;background:#fff;margin:12px 0;" />
      ${
        r.pod_record_id && Number(r.amount_collected_amd) > 0
          ? r.payment_id
            ? `<button type="button" class="link-btn" data-view-payment="${r.payment_id}">${t("recorded_view_payment")}</button>`
            : `<button type="button" class="link-btn" data-create-payment="${r.pod_record_id}">${t("recorded_create_payment")}</button>`
          : ""
      }
      <div class="sheet-actions" style="margin-top:8px;">
        ${
          r.recorded
            ? `<span class="muted">${t("recorded_recorded_by")}: ${escapeHtml(r.recorded_by_name || "")}</span>
               <button type="button" class="btn" data-unrecord="${r.id}">${t("recorded_undo")}</button>`
            : `<button type="button" class="btn btn-primary btn-block" data-record="${r.id}">${t("recorded_mark_recorded")}</button>`
        }
      </div>`;
  }

  // Shared by the mobile card list and the desktop detail pane -- same
  // record/unrecord/payment actions, wherever the markup they act on
  // happens to be rendered.
  function wireActions(scopeEl) {
    scopeEl.querySelectorAll("[data-view-signature]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.className = "sheet-overlay";
        overlay.innerHTML = `<div class="sheet"><img src="${api.podSignatureUrl(btn.dataset.viewSignature)}" alt="${t("delivery_signature_label")}" style="width:100%;border-radius:8px;background:#fff;" /></div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
      });
    });
    scopeEl.querySelectorAll("[data-record]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.setOrderRecorded(btn.dataset.record, true);
          window.dispatchEvent(new Event("recorded-changed"));
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
    scopeEl.querySelectorAll("[data-unrecord]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.setOrderRecorded(btn.dataset.unrecord, false);
          window.dispatchEvent(new Event("recorded-changed"));
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
    scopeEl.querySelectorAll("[data-view-payment]").forEach((btn) => {
      btn.addEventListener("click", () => navigate(`#/payments/${btn.dataset.viewPayment}`));
    });
    scopeEl.querySelectorAll("[data-create-payment]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        errorEl.hidden = true;
        try {
          await api.createPaymentFromPod(btn.dataset.createPayment);
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
  }

  function selectRow(id) {
    const r = lastRows.find((x) => x.id === id);
    if (!r) return;
    selectedId = id;
    listEl.querySelectorAll("[data-select-row]").forEach((el) => {
      el.classList.toggle("recorded-row-active", Number(el.dataset.selectRow) === id);
    });
    detailPane.hidden = false;
    detailPane.innerHTML = detailPaneHtml(r);
    wireActions(detailPane);
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      const rows = await api.getRecordedList(activeTab === "recorded");
      lastRows = rows;
      const desktop = isDesktopView();
      listEl.innerHTML = rows.length
        ? rows.map((r) => (desktop ? compactRowHtml(r) : rowHtml(r))).join("")
        : `<p class="empty-state">${t(activeTab === "recorded" ? "recorded_empty_recorded" : "recorded_empty_unrecorded")}</p>`;

      if (desktop) {
        if (rows.length) {
          listEl.querySelectorAll("[data-select-row]").forEach((btn) => {
            btn.addEventListener("click", () => selectRow(Number(btn.dataset.selectRow)));
          });
          selectRow(rows.some((r) => r.id === selectedId) ? selectedId : rows[0].id);
        } else {
          detailPane.hidden = true;
          detailPane.innerHTML = "";
        }
      } else {
        detailPane.hidden = true;
        wireActions(listEl);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
    }
  }

  load();
}
