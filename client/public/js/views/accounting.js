// Accounting: the orders that were sent to accounting (Lily) for a waybill or
// invoice -- Requests (not made yet), Waybills and Invoices (made), with a
// signed / unsigned filter. Everyone can open it: reps only get their own
// orders (the server limits the list), the warehouse sees every order so it
// can receive the document before handing the goods to delivery.
import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { STATUS_META, openOrderDetailSheet } from "../orderDetailSheet.js";
import { ACCOUNTING_STATUS_BADGE, accountingDocShort, accountingStatusLabel } from "../accountingDocSheet.js";

const AGENT_ROLES = new Set(["admin", "sales_director", "ceo", "operations_director", "accountant"]);

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function renderAccounting(root, navigate) {
  let group = "requests"; // requests | waybill | invoice
  let signed = ""; // "" | unsigned | signed (created documents only)
  let rows = [];
  let hasMore = false;
  let search = "";
  let loadingMore = false;

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("acc_tab")}</h1></div>
      </div>
      <div class="segmented acc-segmented" id="acc-group"></div>
      <div class="segmented acc-segmented" id="acc-signed" hidden></div>
      <p class="acc-agent" id="acc-agent" hidden></p>
      <div class="list-toolbar">
        <input type="search" id="acc-search" placeholder="${t("search")}" aria-label="${t("search")}" />
      </div>
      <div id="acc-list" class="card-list"></div>
    </div>`;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const groupEl = container.querySelector("#acc-group");
  const signedEl = container.querySelector("#acc-signed");
  const agentEl = container.querySelector("#acc-agent");
  const listEl = container.querySelector("#acc-list");

  function segmented(el, attr, items, active, onPick) {
    el.innerHTML = items
      .map(([v, label]) => `<button type="button" class="chip ${v === active ? "chip-active" : ""}" data-${attr}="${v}" aria-pressed="${v === active}">${label}</button>`)
      .join("");
    el.querySelectorAll(`[data-${attr}]`).forEach((btn) => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(`[data-${attr}]`).forEach((b) => {
          b.classList.remove("chip-active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("chip-active");
        btn.setAttribute("aria-pressed", "true");
        onPick(btn.dataset[attr.replace(/-./g, (m) => m[1].toUpperCase())]);
      });
    });
  }
  segmented(groupEl, "group", [["requests", t("acc_group_requests")], ["waybill", t("acc_group_waybills")], ["invoice", t("acc_group_invoices")]], group, (v) => {
    group = v;
    signedEl.hidden = group === "requests";
    load();
  });
  segmented(signedEl, "signed", [["", t("acc_signed_all")], ["unsigned", t("acc_signed_not_yet")], ["signed", t("acc_status_signed")]], signed, (v) => {
    signed = v;
    load();
  });

  // "Lily is online / offline" -- only for the people who send requests.
  if (AGENT_ROLES.has(state.user.role)) {
    api
      .getAccountingAgent()
      .then((a) => {
        agentEl.hidden = false;
        agentEl.innerHTML = `<span class="status-dot ${a.online ? "status-dot-on" : "status-dot-off"}"></span>${a.online ? t("acc_agent_online") : t("acc_agent_offline")}`;
      })
      .catch(() => {});
  }

  function params() {
    return group === "requests" ? { accounting: "requests" } : { accounting: group, accounting_signed: signed };
  }

  function paint() {
    const q = search.trim().toLowerCase();
    const shown = q
      ? rows.filter((o) =>
          [o.customer_name, o.order_code, o.user_name, ...(o.accounting_documents || []).map((d) => d.hc_doc_number)].filter(Boolean).join(" ").toLowerCase().includes(q)
        )
      : rows;
    if (!shown.length) {
      listEl.innerHTML = `<p class="empty-state">${t("acc_no_requests")}</p>`;
      return;
    }
    listEl.innerHTML = shown
      .map((o) => {
        const meta = STATUS_META[o.status] ?? STATUS_META.submitted;
        const numbers = (o.accounting_documents || []).map((d) => d.hc_doc_number).filter(Boolean);
        return `
        <button class="card list-row" data-order-id="${o.id}">
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(o.customer_name)}</strong>
              <span class="list-row-trailing-text text-amount">${formatAmd(Number(o.total_amd))}</span>
            </div>
            <div class="muted list-row-meta">${o.order_code ? `${escapeHtml(o.order_code)} · ` : ""}${escapeHtml(o.user_name)} · ${formatDate(o.created_at)}${numbers.length ? ` · № ${escapeHtml(numbers.join(", "))}` : ""}</div>
            <div class="list-row-bottom">
              <span class="badge ${meta.cls}">${t(meta.key)}</span>
              ${group === "requests" && o.accounting_doc_type ? `<span class="badge badge-neutral">${accountingDocShort(o.accounting_doc_type)}</span>` : ""}
              <span class="badge ${ACCOUNTING_STATUS_BADGE[o.accounting_status] ?? "badge-neutral"}">${accountingStatusLabel(o.accounting_status, o.accounting_doc_type)}</span>
              ${o.document_count > 0 ? `<span class="badge badge-neutral">&#128206; ${o.document_count}</span>` : ""}
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>`;
      })
      .join("");
    if (hasMore && !q) listEl.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-block" id="acc-load-more">${t("load_more")}</button>`);
    listEl.querySelector("#acc-load-more")?.addEventListener("click", loadMore);
    listEl.querySelectorAll("[data-order-id]").forEach((row) => {
      row.addEventListener("click", () => openOrderDetailSheet(Number(row.dataset.orderId), { onChanged: load, navigate }));
    });
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const result = await api.listOrders(params());
      rows = result.rows;
      hasMore = result.has_more;
      paint();
      window.dispatchEvent(new Event("accounting-changed"));
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const result = await api.listOrders({ ...params(), offset: rows.length });
      rows = rows.concat(result.rows);
      hasMore = result.has_more;
      paint();
    } catch {
      /* keep what is shown */
    } finally {
      loadingMore = false;
    }
  }

  let debounce;
  container.querySelector("#acc-search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      search = e.target.value;
      paint();
    }, 250);
  });

  load();
}
