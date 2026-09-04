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

export async function renderRecorded(root, navigate) {
  let activeTab = "unrecorded";

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
      <div id="recorded-list" class="card-list" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#recorded-list");
  const errorEl = container.querySelector("#recorded-error");
  const tabsEl = container.querySelector("#recorded-tabs");

  tabsEl.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("chip-active", b.dataset.tab === activeTab));
      load();
    });
  });

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
        <p><strong>${formatAmd(Number(r.total_amd))}</strong></p>
        ${
          r.amount_collected_amd != null
            ? `<p class="muted">${t("delivery_amount_collected")}: ${formatAmd(Number(r.amount_collected_amd))}${r.payment_method ? ` · ${t(r.payment_method === "cash" ? "payment_method_cash" : "payment_method_other")}` : ""}</p>`
            : ""
        }
        ${outstanding != null ? `<p class="muted">${t("delivery_new_balance")}: ${formatAmd(outstanding)}</p>` : ""}
        <button type="button" class="link-btn" data-view-signature="${r.id}">${t("recorded_view_signature")}</button>
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

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      const rows = await api.getRecordedList(activeTab === "recorded");
      listEl.innerHTML = rows.length
        ? rows.map(rowHtml).join("")
        : `<p class="empty-state">${t(activeTab === "recorded" ? "recorded_empty_recorded" : "recorded_empty_unrecorded")}</p>`;

      listEl.querySelectorAll("[data-view-signature]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const overlay = document.createElement("div");
          overlay.className = "sheet-overlay";
          overlay.innerHTML = `<div class="sheet"><img src="${api.podSignatureUrl(btn.dataset.viewSignature)}" alt="${t("delivery_signature_label")}" style="width:100%;border-radius:8px;background:#fff;" /></div>`;
          document.body.appendChild(overlay);
          overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
        });
      });
      listEl.querySelectorAll("[data-record]").forEach((btn) => {
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
      listEl.querySelectorAll("[data-unrecord]").forEach((btn) => {
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
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
    }
  }

  load();
}
