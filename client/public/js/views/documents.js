// The Documents inbox (owner, 2026-10-26): every customer document in one list -- signed order blanks, signed acts, payment slips --
// filtered by period, rep and type, with "Not linked" (no order / payment yet) and "Problems" (found by the AI check, when it is on).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateTime } from "../util.js";
import { openFileViewer, fileKindLabel } from "../fileViewer.js";
import { openFileReadySheet } from "../fileReadySheet.js";
import { deskSelectChip } from "../deskTable.js";

const PERIODS = [
  ["today", "pb_today"],
  ["week", "pb_week"],
  ["month", "pb_month"],
  ["", "docs_all_time"],
];
const KINDS = ["", "order_blank", "signed_act", "payment_slip", "other"];

export function renderDocuments(root, navigate) {
  const filters = { period: "week", kind: "", user_id: "", linked: "", issues: "" };
  root.innerHTML = `
    <div class="detail-view documents-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("qa_documents")}</h1></div>
      </div>
      <div class="activity-tabs" role="tablist" id="doc-periods"></div>
      <div class="documents-selects">
        <select id="doc-kind" aria-label="${t("docs_type")}"></select>
        <select id="doc-rep" aria-label="${t("all_managers")}"><option value="">${t("all_managers")}</option></select>
      </div>
      <div class="documents-flags" id="doc-flags"></div>
      <button type="button" class="btn btn-block" id="doc-print-slips" hidden>${t("docs_print_slips")}</button>
      <div class="card-list" id="doc-list"><p class="loading-state" role="status">${t("loading")}</p></div>
      <button type="button" class="btn btn-block" id="doc-more" hidden>${t("load_more")}</button>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = root.querySelector("#doc-list");
  const moreBtn = root.querySelector("#doc-more");
  const repSelect = root.querySelector("#doc-rep");
  const printBtn = root.querySelector("#doc-print-slips");
  printBtn.addEventListener("click", async () => {
    printBtn.disabled = true;
    try {
      const ids = rows.filter((r) => r.kind === "payment_slip" && r.mime === "application/pdf").map((r) => r.id);
      const blob = await api.printPaymentSlips(ids);
      openFileReadySheet(blob, `Payment-slips-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      listEl.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
    } finally {
      printBtn.disabled = false;
    }
  });
  let rows = [];
  let hasMore = false;
  let seq = 0;
  const reps = new Map();
  // "Problems" (found by the AI check) only exists while the AI check is switched on in App configuration.
  let aiOn = false;
  api.getSettings().then((s) => {
    if (s.ai_blank_check_enabled && root.isConnected) {
      aiOn = true;
      paintFilters();
    }
  }).catch(() => {});

  const chip = (label, active, attrs) => `<button type="button" class="map-filter-chip ${active ? "chip-active" : ""}" aria-pressed="${active}" ${attrs}>${escapeHtml(label)}</button>`;
  const kindSelect = root.querySelector("#doc-kind");
  kindSelect.innerHTML = KINDS.map((k) => `<option value="${k}">${escapeHtml(k ? fileKindLabel(k) : t("docs_all_types"))}</option>`).join("");
  function paintFilters() {
    root.querySelector("#doc-periods").innerHTML = PERIODS.map(
      ([key, label]) => `<button role="tab" aria-selected="${filters.period === key}" class="activity-tab ${filters.period === key ? "activity-tab-active" : ""}" data-period="${key}">${escapeHtml(t(label))}</button>`
    ).join("");
    root.querySelector("#doc-flags").innerHTML =
      chip(t("docs_not_linked"), filters.linked === "0", 'data-flag="linked"') + (aiOn ? chip(t("docs_problems"), filters.issues === "1", 'data-flag="issues"') : "");
    root.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => ((filters.period = b.dataset.period), reload())));
    root.querySelector('[data-flag="linked"]').addEventListener("click", () => ((filters.linked = filters.linked === "0" ? "" : "0"), reload()));
    root.querySelector('[data-flag="issues"]')?.addEventListener("click", () => ((filters.issues = filters.issues === "1" ? "" : "1"), reload()));
  }
  // On a computer the two selects are the tables' dropdown chips (desktop roadmap step 9).
  deskSelectChip(kindSelect, t("docs_type"));
  const refreshRepChip = deskSelectChip(repSelect, t("manager"));
  kindSelect.addEventListener("change", () => ((filters.kind = kindSelect.value), reload()));
  repSelect.addEventListener("change", () => ((filters.user_id = repSelect.value), reload()));

  function paintList() {
    for (const r of rows) if (!reps.has(r.created_by)) reps.set(r.created_by, r.user_name);
    const current = repSelect.value;
    repSelect.innerHTML = `<option value="">${t("all_managers")}</option>` + [...reps].map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
    repSelect.value = filters.user_id || current;
    refreshRepChip();
    if (!rows.length) {
      listEl.innerHTML = `<p class="empty-state">${t("files_documents_empty")}</p>`;
    } else {
      listEl.innerHTML = rows
        .map(
          (f, i) => `
        <button type="button" class="card list-row doc-row" data-doc-index="${i}">
          ${f.mime === "application/pdf" ? `<span class="doc-row-thumb doc-row-pdf">PDF</span>` : `<img class="doc-row-thumb" src="${api.fileUrl(f, { thumb: true })}" alt="" loading="lazy" decoding="async" />`}
          <span class="list-row-body">
            <span class="list-row-top"><strong>${escapeHtml(f.customer_name)}</strong></span>
            <span class="muted list-row-meta">${escapeHtml(fileKindLabel(f.kind))} · ${escapeHtml(formatDateTime(f.created_at))}</span>
            <span class="muted list-row-meta">${escapeHtml(f.user_name)}${f.order_codes?.length ? ` · ${escapeHtml(f.order_codes.join(", "))}` : ""}</span>
            ${f.ai_status === "issues" || f.ai_status === "unreadable" ? `<span class="badge badge-danger">${t(f.ai_status === "unreadable" ? "file_ai_unreadable" : "file_ai_issues")}</span>` : ""}
            ${!f.order_ids?.length && !f.payment_id ? `<span class="badge badge-warning">${t("docs_not_linked")}</span>` : ""}
          </span>
        </button>`
        )
        .join("");
      listEl.querySelectorAll("[data-doc-index]").forEach((b) => b.addEventListener("click", () => openFileViewer(rows, Number(b.dataset.docIndex), { onChanged: reload })));
    }
    moreBtn.hidden = !hasMore;
    // Payment slips on screen: print them two to an A4 sheet (owner, 2026-10-27).
    printBtn.hidden = filters.kind !== "payment_slip" || !rows.some((r) => r.kind === "payment_slip" && r.mime === "application/pdf");
  }

  async function load(append) {
    const mine = ++seq;
    const params = { ...filters };
    for (const k of Object.keys(params)) if (!params[k]) delete params[k];
    if (append) params.offset = rows.length;
    if (!append) listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const result = await api.filesInbox(params);
      if (mine !== seq) return;
      rows = append ? [...rows, ...result.rows] : result.rows;
      hasMore = result.has_more;
      paintList();
    } catch (err) {
      if (mine === seq) listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  const reload = () => {
    paintFilters();
    return load(false);
  };
  moreBtn.addEventListener("click", () => load(true));
  paintFilters();
  load(false);
}
