// Returns and cancellations (owner, 2026-10-24): the rep asks (on the order), management / the accountant approves or rejects, the warehouse manager
// confirms the goods are back (good / damaged), the accountant records it in Excel. This page is the worklist of each of them.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { canApproveReturns, canReceiveReturns, canRecordReturns } from "../shared/roles.js";
import { escapeHtml, formatAmd, formatDateTime, showToast } from "../util.js";

const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

export async function renderReturns(root, navigate) {
  const role = state.user.role;
  const isApprover = canApproveReturns(role);
  const isWarehouse = canReceiveReturns(role);
  const canRecord = canRecordReturns(role);
  const tabs = [
    ...(isApprover ? [["decide", (r) => r.status === "requested"]] : []),
    ...(isWarehouse ? [["receive", (r) => r.status === "approved"]] : []),
    ...(canRecord ? [["record", (r) => r.kind === "return" && ["approved", "done"].includes(r.status) && !r.recorded_at]] : []),
    ["all", () => true],
  ];
  let tab = tabs[0][0];
  let rows = [];
  root.innerHTML = `
    <div class="st-view rt-view">
      <div class="st-head"><button type="button" class="btn st-back" id="rt-back" aria-label="${escapeHtml(t("back"))}">‹</button><h1>${escapeHtml(t("rt_title"))}</h1></div>
      <div class="activity-tabs" role="tablist" id="rt-tabs"></div>
      <div id="rt-list" class="st-list"></div>
      <p class="form-error" id="rt-page-error" hidden></p>
    </div>`;
  root.querySelector("#rt-back").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = root.querySelector("#rt-list");
  const errEl = root.querySelector("#rt-page-error");
  const fail = (err) => ((errEl.textContent = err.message), (errEl.hidden = false));

  const paintTabs = () => {
    root.querySelector("#rt-tabs").hidden = tabs.length < 2;
    root.querySelector("#rt-tabs").innerHTML = tabs
      .map(([k, pred]) => {
        const count = k === "all" ? 0 : rows.filter(pred).length;
        const n = count ? ` <span class="count-badge">${count}</span>` : "";
        return `<button role="tab" aria-selected="${k === tab}" class="activity-tab ${k === tab ? "activity-tab-active" : ""}" data-tab="${k}">${escapeHtml(t(`rt_tab_${k}`))}${n}</button>`;
      })
      .join("");
  };
  root.querySelector("#rt-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    paintTabs();
    paint();
  });

  const statusChip = (r) => {
    const map = { requested: ["rt_status_requested", "badge-warning"], approved: ["rt_status_approved", "badge-info"], rejected: ["rt_status_rejected", "badge-danger"], done: ["rt_status_done", "badge-success"] };
    const [key, cls] = map[r.status];
    return `<span class="badge ${cls}">${escapeHtml(t(key))}</span>`;
  };
  const card = (r) => {
    const credit = r.kind === "return" ? `<strong>${formatAmd(r.credit_amd)}</strong>` : "";
    const lines = r.items.map((i) => `<div class="rt-card-line"><span>${escapeHtml(i.product_name)} × ${nf(i.quantity)}${i.condition ? ` <span class="badge ${i.condition === "damaged" ? "badge-danger" : "badge-success"}">${escapeHtml(t(`rt_cond_${i.condition}`))}</span>` : ""}</span></div>`).join("");
    const actions = [];
    if (isApprover && r.status === "requested") actions.push(`<button type="button" class="btn btn-primary" data-act="approve">${escapeHtml(t("rt_approve"))}</button><button type="button" class="btn btn-danger" data-act="reject">${escapeHtml(t("rt_reject"))}</button>`);
    if (isWarehouse && r.status === "approved") actions.push(`<button type="button" class="btn btn-primary" data-act="receive">${escapeHtml(t(r.kind === "return" ? "rt_received" : "rt_received_cancel"))}</button>`);
    if (canRecord && r.kind === "return" && ["approved", "done"].includes(r.status) && !r.recorded_at) actions.push(`<button type="button" class="btn" data-act="record">${escapeHtml(t("rt_recorded"))}</button>`);
    return `<div class="card rt-card" data-id="${r.id}">
      <div class="rt-card-head"><div><strong>${escapeHtml(r.customer_name)}</strong><div class="muted rt-sub">${r.order_code ? `#${escapeHtml(r.order_code)} · ` : ""}${escapeHtml(t(r.kind === "return" ? "rt_kind_return" : "rt_kind_cancel"))}</div></div><div class="rt-card-right">${statusChip(r)}${credit}</div></div>
      <div class="rt-card-lines">${lines}</div>
      <div class="muted rt-sub">${escapeHtml(t(`rt_reason_${r.reason}`))}${r.note ? ` · ${escapeHtml(r.note)}` : ""}</div>
      <div class="muted rt-sub">${escapeHtml(r.requested_by_name ?? "")} · ${escapeHtml(formatDateTime(r.requested_at))}${r.decision_note ? ` · ${escapeHtml(r.decision_note)}` : ""}</div>
      ${r.recorded_at ? `<span class="badge badge-info">${escapeHtml(t(r.recorded_via === "erp" ? "rt_recorded_erp" : "rt_recorded_manual"))}</span>` : ""}
      ${actions.length ? `<div class="rt-actions">${actions.join("")}</div><div class="rt-extra" hidden></div>` : ""}
    </div>`;
  };
  const paint = () => {
    const pred = tabs.find(([k]) => k === tab)[1];
    const shown = rows.filter(pred);
    listEl.innerHTML = shown.length ? shown.map(card).join("") : `<p class="muted">${escapeHtml(t("rt_none"))}</p>`;
  };
  async function load() {
    try {
      rows = await api.listReturns({});
      paintTabs();
      paint();
    } catch (err) {
      fail(err);
    }
  }

  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const cardEl = btn.closest(".rt-card");
    const id = Number(cardEl.dataset.id);
    const r = rows.find((x) => x.id === id);
    const extra = cardEl.querySelector(".rt-extra");
    errEl.hidden = true;
    try {
      if (btn.dataset.act === "approve") {
        await api.approveReturn(id, "");
        showToast(t("rt_saved"));
        await load();
      } else if (btn.dataset.act === "record") {
        await api.recordReturn(id);
        showToast(t("rt_saved"));
        await load();
      } else if (btn.dataset.act === "reject") {
        // a reason is required: an inline field, no dialog
        extra.hidden = false;
        extra.innerHTML = `<label class="st-field">${escapeHtml(t("rt_reject_reason"))}<input data-note maxlength="500" /></label><button type="button" class="btn btn-danger" data-act="reject-send">${escapeHtml(t("rt_reject"))}</button>`;
        extra.querySelector("input").focus();
      } else if (btn.dataset.act === "reject-send") {
        const note = cardEl.querySelector("[data-note]").value.trim();
        if (!note) return fail(new Error(t("rt_reject_reason")));
        await api.rejectReturn(id, note);
        showToast(t("rt_saved"));
        await load();
      } else if (btn.dataset.act === "receive") {
        // returned lines: good (back to stock) or damaged (written off); a cancelled order has nothing to grade
        if (r.kind === "cancel") {
          await api.receiveReturn(id, []);
          showToast(t("rt_saved"));
          await load();
          return;
        }
        extra.hidden = false;
        extra.innerHTML = `${r.items.map((i) => `<div class="rt-grade" data-item="${i.id}"><span>${escapeHtml(i.product_name)} × ${nf(i.quantity)}</span><span class="rt-grade-btns"><button type="button" class="pl-reason-chip pl-reason-on" data-cond="good" aria-pressed="true">${escapeHtml(t("rt_cond_good"))}</button><button type="button" class="pl-reason-chip" data-cond="damaged" aria-pressed="false">${escapeHtml(t("rt_cond_damaged"))}</button></span></div>`).join("")}<button type="button" class="btn btn-primary" data-act="receive-send">${escapeHtml(t("rt_received"))}</button>`;
        btn.hidden = true;
      } else if (btn.dataset.act === "receive-send") {
        const items = [...cardEl.querySelectorAll("[data-item]")].map((row) => ({ id: Number(row.dataset.item), condition: row.querySelector('[data-cond][aria-pressed="true"]').dataset.cond }));
        await api.receiveReturn(id, items);
        showToast(t("rt_saved"));
        await load();
      }
    } catch (err) {
      fail(err);
    }
  });
  listEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-cond]");
    if (!c) return;
    const wrap = c.closest(".rt-grade");
    wrap.querySelectorAll("[data-cond]").forEach((x) => {
      x.classList.toggle("pl-reason-on", x === c);
      x.setAttribute("aria-pressed", String(x === c));
    });
  });
  await load();
}
