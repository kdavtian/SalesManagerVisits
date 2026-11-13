// Documents for signature (e-signature engine, owner 2026-11-13): every document KAD Motors sent to a customer's KAD OS, in the Activity tab
// pattern -- state tabs with counts (waiting / disputed / signed / all), a kind filter, a customer search with its "x", a grouped list; a tap
// opens the document sheet (signDocumentSheet.js). "Send agreement" lists the KAD OS customers. Management and the accountant only
// (canManagePartnerDocuments; the server enforces it). ?open=<id> opens one document (the notifications link here).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../util.js";
import { icons } from "../icons.js";
import { deskSelectChip } from "../deskTable.js";
import { installInlineClearButton } from "../searchBar.js";
import { documentRowHtml, kindLabel, openSignDocumentSheet, openSendAgreementSheet } from "../signDocumentSheet.js";

const TABS = ["open", "disputed", "signed", "all"];
const KINDS = ["", "agreement", "delivery", "payment", "reconciliation", "return", "deal"];

export function renderSignDocuments(root, navigate, query) {
  const filters = { state: "open", kind: "", q: "" };
  root.innerHTML = `
    <div class="detail-view documents-view sign-documents-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("sd_title")}</h1></div>
      </div>
      <div class="activity-tabs" role="tablist" id="sd-tabs"></div>
      <div class="list-toolbar">
        <input type="search" id="sd-search" placeholder="${escapeHtml(t("sd_search"))}" aria-label="${escapeHtml(t("sd_search"))}" autocomplete="off" />
      </div>
      <div class="documents-selects">
        <select id="sd-kind" aria-label="${escapeHtml(t("sd_all_kinds"))}">${KINDS.map((k) => `<option value="${k}">${escapeHtml(k ? kindLabel(k) : t("sd_all_kinds"))}</option>`).join("")}</select>
      </div>
      <button type="button" class="btn btn-block btn-has-icon" id="sd-send-agreement">${icons.plus}${t("sd_send_agreement")}</button>
      <div class="card-list" id="sd-list"><p class="loading-state" role="status">${t("loading")}</p></div>
      <button type="button" class="btn btn-block" id="sd-more" hidden>${t("load_more")}</button>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/documents"));
  const listEl = root.querySelector("#sd-list");
  const moreBtn = root.querySelector("#sd-more");
  const kindSelect = root.querySelector("#sd-kind");
  const search = root.querySelector("#sd-search");
  let rows = [];
  let counts = {};
  let hasMore = false;
  let seq = 0;

  function paintTabs() {
    root.querySelector("#sd-tabs").innerHTML = TABS.map((key) => {
      const n = counts[key];
      return `<button role="tab" aria-selected="${filters.state === key}" class="activity-tab ${filters.state === key ? "activity-tab-active" : ""}" data-tab="${key}">${escapeHtml(t(`sd_tab_${key}`))}${n ? ` · ${n}` : ""}</button>`;
    }).join("");
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      if (filters.state === b.dataset.tab) return;
      filters.state = b.dataset.tab;
      reload();
    }));
  }

  function paintList() {
    listEl.innerHTML = rows.length ? rows.map((d) => documentRowHtml(d)).join("") : `<p class="empty-state">${t("sd_empty")}</p>`;
    listEl.querySelectorAll("[data-sign-doc]").forEach((b) => b.addEventListener("click", () => openSignDocumentSheet(Number(b.dataset.signDoc), { onChanged: reload })));
    moreBtn.hidden = !hasMore;
  }

  async function load(append) {
    const mine = ++seq;
    const params = { state: filters.state };
    if (filters.kind) params.kind = filters.kind;
    if (filters.q) params.q = filters.q;
    if (append) params.offset = rows.length;
    try {
      const result = await api.listSignDocuments(params);
      if (mine !== seq || !root.isConnected) return;
      rows = append ? [...rows, ...result.documents] : result.documents;
      counts = result.counts ?? counts;
      hasMore = result.has_more;
      paintTabs();
      paintList();
    } catch (err) {
      if (mine === seq) listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  const reload = () => load(false);

  deskSelectChip(kindSelect, t("sd_all_kinds"));
  kindSelect.addEventListener("change", () => {
    filters.kind = kindSelect.value;
    reload();
  });
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filters.q = search.value.trim();
      reload();
    }, 250);
  });
  installInlineClearButton(search); // its "x" empties the box and fires input: the list reloads
  moreBtn.addEventListener("click", () => load(true));
  root.querySelector("#sd-send-agreement").addEventListener("click", () => openSendAgreementSheet({ onSent: reload }));
  paintTabs();
  reload();
  const openId = Number(query?.get?.("open"));
  if (Number.isInteger(openId) && openId > 0) openSignDocumentSheet(openId, { onChanged: reload });
}
