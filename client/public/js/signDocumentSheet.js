// Documents the customer signs in KAD OS (e-signature engine, owner 2026-11-13): the shared pieces of the "Documents for signature" screen
// and the customer card -- the kind / state labels, one document as a bottom sheet (content, PDF, who signed with the audit, the customer's
// objection and KAD's answer, versions; actions: cancel with a reason, a new version of the agreement, answer a dispute) and the "send the
// agreement" sheet (KAD OS customers and where their agreement stands). Server: server/src/orders/routes/signDocuments.js.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, formatDateTime, formatAmd, showToast } from "./util.js";
import { openFileReadySheet } from "./fileReadySheet.js";
import { state } from "./state.js";
import { canManagePartnerDocuments } from "./shared/roles.js";

const STATE_BADGE = { sent: "badge-info", viewed: "badge-info", signed: "badge-success", signed_remarks: "badge-warning", disputed: "badge-danger", replaced: "badge-neutral", cancelled: "badge-neutral" };
const OPEN = ["sent", "viewed"];

export const kindLabel = (kind) => t(`sd_kind_${kind}`);
export const stateBadgeHtml = (state) => `<span class="badge ${STATE_BADGE[state] ?? "badge-neutral"}">${escapeHtml(t(`sd_state_${state}`))}</span>`;

/** One row of a list (the screen and the customer card): customer or kind, title + number, state, deadline. */
export function documentRowHtml(d, { showCustomer = true } = {}) {
  const due = OPEN.includes(d.state) && d.due_at ? (d.overdue ? `<span class="badge badge-danger">${t("sd_overdue")}</span>` : `<span class="muted">${escapeHtml(t("sd_due").replace("{date}", formatDateTime(d.due_at)))}</span>`) : "";
  return `
    <button type="button" class="card list-row doc-row" data-sign-doc="${d.id}">
      <span class="list-row-body">
        <span class="list-row-top"><strong>${escapeHtml(showCustomer ? d.customer_name : d.title)}</strong></span>
        <span class="muted list-row-meta">${escapeHtml(showCustomer ? `${kindLabel(d.kind)} · ` : "")}${escapeHtml(d.number)}${d.version > 1 ? ` · v${d.version}` : ""} · ${escapeHtml(formatDateTime(d.sent_at))}</span>
        <span class="list-row-meta">${stateBadgeHtml(d.state)} ${due}</span>
      </span>
      <span class="chevron">&#8250;</span>
    </button>`;
}

const ERROR_TEXTS = { agreement_exists: "sd_err_agreement_exists", not_linked: "sd_err_not_linked", already_decided: "sd_err_already_decided" };
const errorText = (err) => (ERROR_TEXTS[err?.body?.code] ? t(ERROR_TEXTS[err.body.code]) : err.message);
const bullet = (label, value) => (value ? `<li>${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></li>` : "");

function signerHtml(heading, s, { audit = false } = {}) {
  if (!s) return `<div class="sd-side"><h4>${escapeHtml(heading)}</h4><p class="muted">${t("sd_not_signed")}</p></div>`;
  return `<div class="sd-side"><h4>${escapeHtml(heading)}</h4>
    <ul class="sd-bullets">
      ${bullet(t("sd_signer"), [s.name, s.role].filter(Boolean).join(", "))}
      ${bullet(t("sd_signed_at"), s.signed_at ? formatDateTime(s.signed_at, { year: true }) : "")}
      ${audit && s.pin_verified ? `<li>${t("sd_pin_ok")}</li>` : ""}
      ${audit ? bullet(t("sd_network"), s.ip) : ""}
      ${audit ? bullet(t("sd_device"), [s.ua, s.app_version].filter(Boolean).join(" · ")) : ""}
    </ul></div>`;
}

function contentHtml(d) {
  const c = d.content ?? {};
  const lines = c.lines ?? [];
  const remarkOf = new Map((d.remarks ?? []).map((r) => [String(r.key), r]));
  return `
    ${c.summary?.length ? `<ul class="sd-bullets">${c.summary.map((s) => bullet(s.label, s.value)).join("")}</ul>` : ""}
    ${lines.length ? `<div class="card-list sd-lines">${lines.map((l) => {
      const r = remarkOf.get(String(l.key));
      return `<div class="sd-line"><span>${escapeHtml(l.name)}${l.qty != null ? ` <span class="muted">· ${escapeHtml(String(l.qty))} ${escapeHtml(l.unit || "")}</span>` : ""}${r ? `<br><span class="badge badge-warning">${escapeHtml(t(`sd_issue_${r.issue}`))}${r.qty != null ? ` ${escapeHtml(String(r.qty))}` : ""}</span> <span class="muted">${escapeHtml(r.comment || "")}</span>` : ""}</span><span class="sd-amount">${l.amount_amd != null ? formatAmd(l.amount_amd) : ""}</span></div>`;
    }).join("")}</div>` : ""}
    ${(c.totals ?? []).map((x) => `<div class="sd-line sd-total"><span>${escapeHtml(x.label)}</span><span class="sd-amount">${formatAmd(x.amount_amd)}</span></div>`).join("")}
    ${c.text ? `<details class="sd-text"><summary>${t("sd_text")}</summary><p>${escapeHtml(c.text)}</p></details>` : ""}`;
}

function disputeHtml(d, manages = true) {
  const x = d.dispute;
  if (!x) return "";
  const by = x.by ? [x.by.name, x.by.role].filter(Boolean).join(", ") : "";
  return `<h3 class="list-group-heading">${t("sd_dispute")}</h3>
    <ul class="sd-bullets">
      ${bullet(t("sd_reason"), x.reason)}
      ${bullet(t("sd_comment"), x.comment)}
      ${bullet(t("sd_signer"), by)}
      ${bullet(t("sd_kad_answer"), x.answer)}
    </ul>
    ${manages && d.state === "disputed" && !x.answer ? `<label class="sd-field"><span class="muted">${t("sd_answer")}</span><textarea id="sd-answer" rows="3" maxlength="2000" placeholder="${escapeHtml(t("sd_answer_placeholder"))}"></textarea></label>
      <button type="button" class="btn btn-primary btn-block" id="sd-answer-send">${t("sd_answer_send")}</button>` : ""}`;
}

/** One document as a bottom sheet. onChanged runs after any action (the list repaints). */
export async function openSignDocumentSheet(id, { onChanged } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet sd-sheet" role="dialog" aria-modal="true"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  const sheet = overlay.querySelector(".sheet");

  const act = async (btn, work) => {
    btn.disabled = true;
    try {
      await work();
      onChanged?.();
    } catch (err) {
      showToast(errorText(err));
    } finally {
      btn.disabled = false;
    }
  };

  async function paint() {
    let d;
    try {
      d = await api.getSignDocument(id);
    } catch (err) {
      sheet.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (!overlay.isConnected) return;
    const manages = canManagePartnerDocuments(state.user?.role); // a rep reads the document; management acts on it
    const canCancel = manages && [...OPEN, "disputed"].includes(d.state);
    const canReplace = canCancel && d.kind === "agreement";
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <h2>${escapeHtml(d.title)}</h2>
      <p class="muted">${escapeHtml(d.customer_name)} · ${escapeHtml(d.number)}</p>
      <p>${stateBadgeHtml(d.state)} ${d.overdue ? `<span class="badge badge-danger">${t("sd_overdue")}</span>` : ""}</p>
      ${d.cancelled_reason ? `<p class="muted">${escapeHtml(t("sd_cancelled_reason").replace("{reason}", d.cancelled_reason))}</p>` : ""}
      ${contentHtml(d)}
      <h3 class="list-group-heading">${t("sd_signatures")}</h3>
      <div class="sd-sides">${signerHtml("KAD Motors", d.kad_signer)}${signerHtml(t("sd_customer_side"), d.customer_signer, { audit: true })}</div>
      ${disputeHtml(d, manages)}
      ${d.versions?.length > 1 ? `<h3 class="list-group-heading">${t("sd_versions")}</h3><div class="sd-versions">${d.versions.map((v) => `<button type="button" class="btn ${v.id === d.id ? "btn-primary" : ""}" data-version="${v.id}">${escapeHtml(v.number ?? `v${v.version}`)} · ${escapeHtml(t(`sd_state_${v.state}`))}</button>`).join("")}</div>` : ""}
      <div id="sd-cancel-box" hidden>
        <label class="sd-field"><span class="muted">${t("sd_cancel_reason")}</span><input type="text" id="sd-cancel-reason" maxlength="500" /></label>
        <button type="button" class="btn btn-danger btn-block" id="sd-cancel-confirm">${t("sd_cancel_confirm")}</button>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn" id="sd-pdf">${t("sd_pdf")}</button>
        ${canReplace ? `<button type="button" class="btn" id="sd-replace">${t("sd_new_version")}</button>` : ""}
        ${canCancel ? `<button type="button" class="btn" id="sd-cancel">${t("sd_cancel")}</button>` : ""}
      </div>`;
    sheet.querySelector('[data-action="close-sheet"]').addEventListener("click", close);
    const pdfBtn = sheet.querySelector("#sd-pdf");
    pdfBtn.addEventListener("click", () => act(pdfBtn, async () => openFileReadySheet(await api.getSignDocumentPdf(d.id), `${d.number}-v${d.version}.pdf`)));
    sheet.querySelectorAll("[data-version]").forEach((b) => b.addEventListener("click", () => {
      id = Number(b.dataset.version);
      paint();
    }));
    const replaceBtn = sheet.querySelector("#sd-replace");
    replaceBtn?.addEventListener("click", () => window.confirm(t("sd_new_version_confirm")) && act(replaceBtn, async () => {
      const next = await api.replaceSignDocument(d.id);
      id = next.id;
      showToast(t("sd_sent_ok"));
      await paint();
    }));
    // Cancelling asks the reason inline (no confirm dialog): the field opens, the red button does it.
    sheet.querySelector("#sd-cancel")?.addEventListener("click", () => {
      const box = sheet.querySelector("#sd-cancel-box");
      box.hidden = false;
      box.querySelector("input").focus();
    });
    const confirmBtn = sheet.querySelector("#sd-cancel-confirm");
    confirmBtn.addEventListener("click", () => {
      const reason = sheet.querySelector("#sd-cancel-reason").value.trim();
      if (!reason) return sheet.querySelector("#sd-cancel-reason").focus();
      act(confirmBtn, async () => {
        await api.cancelSignDocument(d.id, reason);
        await paint();
      });
    });
    const answerBtn = sheet.querySelector("#sd-answer-send");
    answerBtn?.addEventListener("click", () => {
      const text = sheet.querySelector("#sd-answer").value.trim();
      if (!text) return sheet.querySelector("#sd-answer").focus();
      act(answerBtn, async () => {
        await api.answerSignDocument(d.id, text);
        await paint();
      });
    });
  }
  await paint();
}

/** Send the one-time agreement on electronic documents: the KAD OS customers, those without one first. onSent(document). */
export async function openSendAgreementSheet({ customerId = null, onSent } = {}) {
  const send = async (cid) => {
    // a legal document goes to the customer: one question first
    if (!window.confirm(t("sd_send_agreement_confirm"))) return null;
    const doc = await api.sendAgreement(cid);
    showToast(t("sd_sent_ok"));
    onSent?.(doc);
    return doc;
  };
  if (customerId) {
    try {
      return await send(customerId);
    } catch (err) {
      showToast(errorText(err));
      return null;
    }
  }
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
    <h2>${t("sd_candidates_title")}</h2>
    <div class="card-list" id="sd-candidates"><p class="loading-state" role="status">${t("loading")}</p></div>
  </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", close);
  const list = overlay.querySelector("#sd-candidates");
  try {
    const { customers } = await api.agreementCandidates();
    customers.sort((a, b) => Number(Boolean(a.agreement_state)) - Number(Boolean(b.agreement_state)));
    list.innerHTML = customers.length
      ? customers
          .map(
            (c) => `<div class="card list-row doc-row"><span class="list-row-body"><strong>${escapeHtml(c.name)}</strong>
              <span class="list-row-meta">${c.agreement_state ? stateBadgeHtml(c.agreement_state) : `<span class="muted">${t("sd_agreement_none")}</span>`}</span></span>
              ${c.agreement_state ? "" : `<button type="button" class="btn btn-primary" data-send="${c.id}">${t("sd_send")}</button>`}</div>`
          )
          .join("")
      : `<p class="empty-state">${t("sd_candidates_empty")}</p>`;
    list.querySelectorAll("[data-send]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await send(Number(b.dataset.send));
          close();
        } catch (err) {
          showToast(errorText(err));
          b.disabled = false;
        }
      })
    );
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
  return null;
}
