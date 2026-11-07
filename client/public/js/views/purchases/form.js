// Purchases > the new / edit invoice form (owner, 2026-11-07: "the module needs huge improvements. make it ultra best").
// One page of work for the person typing a supplier invoice from paper:
//   supplier (chips, its last rate and the next invoice number offered) -> number, date, USD rate -> products (type, Enter adds, Enter
//   moves on) -> each line shows what was bought BEFORE (last price and date, price change, stock, 12 months) -> totals always in view.
// The bar with the totals and Save never leaves the screen; an unsaved new invoice survives a closed sheet (draft); the same supplier's same
// number and day is flagged before and after Save. The server (products/purchases.js) refuses what the screen allows through.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY, groupDigits } from "../../util.js";
import { pickDate } from "../../activityDatePicker.js";
import { getProductCatalog } from "../../productCatalog.js";
import { searchProducts } from "../../productSearch.js";
import { compareProducts } from "../../productSort.js";
import { nextInvoiceNo, priceChangePct } from "../../purchaseNumbers.js";

const DRAFT_KEY = "fv_pu_draft";
const DRAFT_MAX_AGE_MS = 7 * 86400000;
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const usd = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")) || 0;
const sizeOf = (p) => (p ? Number(p.size_l) || Number(String(p.unit ?? "").replace(",", ".").match(/[\d.]+/)?.[0]) || 0 : 0);
const productLabel = (p) => `${p.brand ? `${p.brand} ` : ""}${p.name}${p.unit ? ` · ${p.unit}` : ""}`;
const keyOfNo = (no) => String(no ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return d && Date.now() - d.at < DRAFT_MAX_AGE_MS ? d : null;
  } catch {
    return null;
  }
}
const writeDraft = (d) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, at: Date.now() }));
  } catch {
    // storage unavailable: the form still works, only the draft is not kept
  }
};
const clearDraft = () => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing to clear
  }
};

/**
 * `invoice`: null (new), an app invoice (edit: has id), or a prefilled one (an Excel invoice to copy in, or a repeat: no id).
 * `rows`: the invoices the list holds (the duplicate warning is shown at once from them). `openInvoice(id)`: shows the existing invoice.
 */
export async function openPurchaseForm(invoice, { onSaved, rows = [], openInvoice } = {}) {
  const editing = Boolean(invoice?.id);
  const fresh = !invoice; // only a blank new invoice has a draft
  const draft = fresh ? readDraft() : null;
  const source = draft ?? invoice ?? {};
  let supplierName = source.supplier ?? source.supplierName ?? "";
  let date = source.invoice_date ?? source.date ?? isoDay(new Date());
  const lines = (source.lines ?? []).map((l) => ({ product_id: l.product_id, product_name: l.product_name, qty: Number(l.qty) || 0, cost_usd: Number(l.cost_usd) || 0 }));
  const clientRef = `pu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const history = new Map(); // product_id -> GET /purchases/product-history entry
  let allowDuplicate = false;
  let duplicateId = null;

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet pu-form-sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const [suppliersData, catalog] = await Promise.all([
    api.listSuppliers().catch(() => ({ suppliers: [], excel_names: [], excel_suppliers: [], default_usd_rate: null })),
    getProductCatalog().catch(() => []),
  ]);
  const products = (catalog ?? []).slice().sort(compareProducts);
  const byId = new Map(products.map((p) => [p.id, p]));
  // everyone who can be picked: the app's suppliers, then the ones only the Excel knows; the invoice's own supplier is always there
  const known = [...suppliersData.suppliers.filter((s) => s.active !== false), ...(suppliersData.excel_suppliers ?? [])];
  if (supplierName && !known.some((s) => s.name.toLowerCase() === supplierName.toLowerCase())) known.push({ name: supplierName });
  const supplierOf = (name) => known.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  const defaultRate = suppliersData.default_usd_rate;

  const sheet = overlay.querySelector(".sheet");
  sheet.innerHTML = `
    <div class="pu-form-head">
      <h2>${t(editing ? "pu_edit" : "pu_new")}</h2>
      <button type="button" class="icon-btn" data-close aria-label="${t("close")}">${icons.close}</button>
    </div>
    <form id="pu-form" class="pu-form" autocomplete="off" novalidate>
      <div class="pu-form-body">
        <p class="pu-draft" id="pu-draft" hidden><span>${t("pu_draft_restored")}</span><button type="button" class="settings-reset-link" id="pu-draft-discard">${t("pu_draft_discard")}</button></p>
        <fieldset class="pu-block">
          <legend>${t("pu_supplier")}</legend>
          <div class="pu-supplier-pick" id="pu-supplier-chips" role="radiogroup" aria-label="${t("pu_supplier")}"></div>
          <div id="pu-new-supplier" hidden><input name="supplier_new" maxlength="120" value="${escapeHtml(source.supplier_new ?? "")}" placeholder="${t("pu_supplier_new")}" aria-label="${t("pu_supplier_new")}" /></div>
          <p class="pu-field-err" id="err-supplier" role="alert" hidden></p>
        </fieldset>
        <div class="pu-grid3">
          <div class="pu-field">
            <label for="pu-no">${t("pu_invoice_no")}</label>
            <input id="pu-no" name="invoice_no" maxlength="80" value="${escapeHtml(source.invoice_no ?? "")}" />
            <div class="pu-hints" id="pu-no-hints"></div>
            <p class="pu-field-err" id="err-no" role="alert" hidden></p>
          </div>
          <div class="pu-field">
            <label for="pu-date">${t("pu_date")}</label>
            <button type="button" class="btn pu-date-btn" id="pu-date">${escapeHtml(formatDateDMY(date))}</button>
          </div>
          <div class="pu-field">
            <label for="pu-rate">${t("pu_rate")}</label>
            <input id="pu-rate" name="usd_rate" inputmode="decimal" value="${escapeHtml(String(source.usd_rate ?? source.rate ?? ""))}" />
            <div class="pu-hints" id="pu-rate-hints"></div>
            <p class="pu-field-err" id="err-rate" role="alert" hidden></p>
          </div>
        </div>
        <div class="pu-dup" id="pu-dup" role="alert" hidden>
          <span id="pu-dup-text"></span>
          <span class="pu-dup-actions"><button type="button" class="btn" id="pu-dup-open">${t("pu_dup_open")}</button><button type="button" class="btn" id="pu-dup-anyway">${t("pu_dup_anyway")}</button></span>
        </div>
        <h3 class="section-title section-title-tight">${t("pu_lines")}</h3>
        <div class="pu-add">
          <input type="search" id="pu-search" placeholder="${t("pu_search_hint")}" aria-label="${t("pu_search_product")}" autocomplete="off" />
          <div id="pu-results" class="pu-results" role="listbox"></div>
        </div>
        <div id="pu-lines" class="pu-flines"></div>
        <p class="pu-field-err" id="err-lines" role="alert" hidden></p>
        <div class="pu-field">
          <label for="pu-note">${t("pu_note")}</label>
          <input id="pu-note" name="note" maxlength="1000" value="${escapeHtml(source.note ?? "")}" />
        </div>
        <p class="form-error" id="pu-error" role="alert" hidden></p>
      </div>
      <div class="pu-bar">
        <div class="pu-bar-totals" id="pu-total"></div>
        <div class="pu-bar-btns">
          <button type="button" class="btn" id="pu-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary" id="pu-save">${t("pu_save")}</button>
        </div>
      </div>
    </form>`;
  const $ = (sel) => sheet.querySelector(sel);
  const form = $("#pu-form");
  const noInput = $("#pu-no");
  const rateInput = $("#pu-rate");
  const searchEl = $("#pu-search");
  const resultsEl = $("#pu-results");
  const linesEl = $("#pu-lines");
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  $("#pu-cancel").addEventListener("click", close);

  // ---- helpers: errors ---------------------------------------------------------------------------------------------------------------
  const fieldErr = (id, text) => {
    const el = $(`#err-${id}`);
    el.textContent = text || "";
    el.hidden = !text;
  };
  const flag = (input, bad) => input?.setAttribute("aria-invalid", bad ? "true" : "false");

  // ---- draft -------------------------------------------------------------------------------------------------------------------------
  let saveTimer = null;
  const snapshot = () => ({ supplier: supplierName, supplier_new: $("#pu-new-supplier input").value, invoice_no: noInput.value, invoice_date: date, usd_rate: rateInput.value, note: $("#pu-note").value, lines: lines.map((l) => ({ ...l })) });
  const touched = () => Boolean(supplierName || noInput.value.trim() || lines.length || $("#pu-note").value.trim());
  function scheduleDraft() {
    if (!fresh) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => (touched() ? writeDraft(snapshot()) : clearDraft()), 400);
  }
  if (draft) $("#pu-draft").hidden = false;
  $("#pu-draft-discard").addEventListener("click", () => {
    clearDraft();
    close();
    openPurchaseForm(null, { onSaved, rows, openInvoice });
  });

  // ---- supplier chips, number and rate hints -------------------------------------------------------------------------------------------
  function paintSupplier() {
    const chips = known.map((s) => {
      const on = s.name.toLowerCase() === supplierName.toLowerCase();
      return `<button type="button" class="pu-chip ${on ? "pu-chip-on" : ""}" role="radio" aria-checked="${on}" data-supplier="${escapeHtml(s.name)}"><strong>${escapeHtml(s.name)}</strong>${s.brands ? `<span class="muted">${escapeHtml(s.brands)}</span>` : ""}</button>`;
    });
    chips.push(`<button type="button" class="pu-chip pu-chip-add ${supplierName === "__new" ? "pu-chip-on" : ""}" role="radio" aria-checked="${supplierName === "__new"}" data-supplier="__new"><strong>${t("pu_supplier_add")}</strong></button>`);
    $("#pu-supplier-chips").innerHTML = chips.join("");
    $("#pu-new-supplier").hidden = supplierName !== "__new";
    $("#pu-supplier-chips").querySelectorAll("[data-supplier]").forEach((b) =>
      b.addEventListener("click", () => {
        supplierName = b.dataset.supplier;
        fieldErr("supplier", "");
        paintSupplier();
        offerRate();
        offerNumber();
        checkDuplicate();
        scheduleDraft();
        if (supplierName === "__new") $("#pu-new-supplier input").focus();
        else if (!noInput.value) noInput.focus();
      })
    );
  }
  function offerNumber() {
    const s = supplierOf(supplierName);
    const last = s?.last_invoice_no;
    const next = nextInvoiceNo(last);
    $("#pu-no-hints").innerHTML = last
      ? `${next ? `<button type="button" class="pu-hint-chip" id="pu-next">${escapeHtml(t("pu_next_no").replace("{no}", next))}</button>` : ""}<span class="muted">${escapeHtml(t("pu_last_no").replace("{no}", last))}${s.last_invoice_date ? ` · ${escapeHtml(formatDateDMY(s.last_invoice_date))}` : ""}</span>`
      : "";
    $("#pu-next")?.addEventListener("click", () => {
      noInput.value = next;
      fieldErr("no", "");
      flag(noInput, false);
      checkDuplicate();
      scheduleDraft();
    });
  }
  function offerRate() {
    const s = supplierOf(supplierName);
    const last = s?.last_usd_rate ?? defaultRate;
    if (last && !rateInput.value) {
      rateInput.value = String(last);
      paintTotal();
    }
    $("#pu-rate-hints").innerHTML = last ? `<span class="muted">${escapeHtml(t("pu_rate_last").replace("{rate}", groupDigits(last)))}</span>` : "";
  }
  $("#pu-new-supplier input").addEventListener("input", scheduleDraft);

  // ---- duplicate ---------------------------------------------------------------------------------------------------------------------
  function showDuplicate(id) {
    duplicateId = id;
    $("#pu-dup-text").textContent = t("pu_dup_warning").replace("{no}", noInput.value.trim());
    $("#pu-dup").hidden = false;
    $("#pu-dup-open").hidden = !(id && openInvoice);
    $("#pu-dup-anyway").hidden = false;
  }
  function checkDuplicate() {
    allowDuplicate = false;
    duplicateId = null;
    $("#pu-dup").hidden = true;
    const name = supplierName === "__new" ? "" : supplierName;
    const no = keyOfNo(noInput.value);
    if (!name || !no) return;
    const same = rows.find((r) => r.id && r.invoice_date === date && keyOfNo(r.invoice_no) === no && String(r.supplier ?? "").toLowerCase() === name.toLowerCase() && r.id !== invoice?.id);
    if (same) showDuplicate(same.id);
  }
  $("#pu-dup-open").addEventListener("click", () => {
    if (!duplicateId || !openInvoice) return;
    close();
    openInvoice(duplicateId);
  });
  $("#pu-dup-anyway").addEventListener("click", () => {
    allowDuplicate = true;
    $("#pu-dup").hidden = true;
  });
  noInput.addEventListener("input", () => {
    fieldErr("no", "");
    flag(noInput, false);
    checkDuplicate();
    scheduleDraft();
  });
  rateInput.addEventListener("input", () => {
    fieldErr("rate", "");
    flag(rateInput, false);
    paintTotal();
    scheduleDraft();
  });
  $("#pu-note").addEventListener("input", scheduleDraft);
  $("#pu-date").addEventListener("click", async (e) => {
    const picked = await pickDate({ value: date, title: t("pu_date") });
    if (picked) {
      date = picked;
      e.currentTarget.textContent = formatDateDMY(date);
      checkDuplicate();
      scheduleDraft();
    }
  });

  // ---- history of the products on the invoice ------------------------------------------------------------------------------------------
  async function loadHistory(ids) {
    const need = [...new Set(ids.filter((id) => id && !history.has(id)))];
    if (!need.length) return;
    try {
      const got = await api.getPurchaseHistory(need, { no: invoice?.invoice_no, date: invoice?.invoice_date });
      for (const id of need) history.set(id, got[id] ?? { last: null });
      refreshHints(); // in place: a redraw would take the focus from the field being typed in
    } catch {
      // the hints are an extra: the form works without them
    }
  }
  function histText(h) {
    if (!h) return "";
    if (!h.last) return `<span class="muted">${t("pu_hist_none")}</span>`;
    const bits = [t("pu_hist_last").replace("{usd}", usd(h.last.cost_usd)).replace("{date}", formatDateDMY(h.last.day)).replace("{supplier}", escapeHtml(h.last.supplier || "—"))];
    if (h.stock_qty != null) bits.push(t("pu_hist_stock").replace("{n}", groupDigits(h.stock_qty)));
    if (h.packs_12m > 0) bits.push(t("pu_hist_12m").replace("{n}", groupDigits(h.packs_12m)));
    return `<span class="muted">${bits.join(" · ")}</span>`;
  }

  // ---- totals ------------------------------------------------------------------------------------------------------------------------
  function paintTotal() {
    const rate = num(rateInput.value);
    const packs = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
    const liters = lines.reduce((a, l) => a + (Number(l.qty) || 0) * sizeOf(byId.get(l.product_id)), 0);
    const sum = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost_usd) || 0), 0);
    $("#pu-total").innerHTML = `
      <span class="pu-bar-main"><strong>${usd(sum)}</strong>${rate > 0 ? `<span class="muted">${formatAmd(Math.round(sum * rate))}</span>` : ""}</span>
      <span class="pu-bar-sub muted">${groupDigits(packs)} ${t("pu_total_packs").toLowerCase()} · ${groupDigits(Math.round(liters))} L${liters > 0 && sum > 0 ? ` · ${usd(sum / liters)}/L` : ""}</span>`;
  }

  // ---- lines -------------------------------------------------------------------------------------------------------------------------
  // the change chip beside a price: kept in step with the typed price without redrawing the inputs (the focus stays where it is)
  function updateDelta(row, i) {
    const h = history.get(lines[i].product_id);
    const change = h?.last ? priceChangePct(h.last.cost_usd, lines[i].cost_usd) : null;
    let chip = row.querySelector(".pu-delta");
    if (change === null || change === 0) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("em");
      row.querySelector('[data-f="cost_usd"]').closest("label").appendChild(chip);
    }
    chip.className = `pu-delta ${change > 0 ? "pu-delta-up" : "pu-delta-down"}`;
    chip.textContent = `${change > 0 ? "+" : ""}${change}%`;
  }
  function refreshHints() {
    linesEl.querySelectorAll("[data-i]").forEach((row) => {
      const i = Number(row.dataset.i);
      const h = history.get(lines[i].product_id);
      row.querySelector(".pu-fl-hist").innerHTML = h ? histText(h) : "";
      updateDelta(row, i);
    });
  }
  function paintLines() {
    linesEl.innerHTML = lines.length
      ? lines
          .map((l, i) => {
            const p = byId.get(l.product_id);
            const h = history.get(l.product_id);
            const change = h?.last ? priceChangePct(h.last.cost_usd, l.cost_usd) : null;
            const sum = (Number(l.qty) || 0) * (Number(l.cost_usd) || 0);
            return `<div class="pu-fl" data-i="${i}">
              <div class="pu-fl-main">
                <span class="pu-fl-name">${escapeHtml(p ? productLabel(p) : l.product_name || "")}</span>
                <span class="pu-fl-hist">${h ? histText(h) : ""}</span>
              </div>
              <label class="pu-fl-num"><span>${t("pu_packs")}</span><input data-f="qty" inputmode="decimal" aria-label="${t("pu_packs")}" value="${l.qty || ""}" /></label>
              <label class="pu-fl-num"><span>${t("pu_cost_usd")}</span><input data-f="cost_usd" inputmode="decimal" aria-label="${t("pu_cost_usd")}" value="${l.cost_usd || l.cost_usd === 0 ? l.cost_usd : ""}" />
                ${change !== null && change !== 0 ? `<em class="pu-delta ${change > 0 ? "pu-delta-up" : "pu-delta-down"}">${change > 0 ? "+" : ""}${change}%</em>` : ""}</label>
              <span class="pu-fl-sum"><span class="pu-fl-sum-label">${t("pu_line_sum")}</span><strong>${usd(sum)}</strong></span>
              <button type="button" class="icon-btn icon-btn-danger" data-remove aria-label="${t("pu_remove")}">${icons.trash}</button>
              <p class="pu-field-err pu-fl-err" data-err hidden role="alert"></p>
            </div>`;
          })
          .join("")
      : ""; // nothing yet: the search box above says what to do, and Save names what is missing
    linesEl.querySelectorAll("[data-i]").forEach((row) => {
      const i = Number(row.dataset.i);
      const inputs = [...row.querySelectorAll("[data-f]")];
      inputs.forEach((input, k) => {
        input.addEventListener("input", () => {
          lines[i][input.dataset.f] = num(input.value);
          input.setAttribute("aria-invalid", "false");
          row.querySelector("[data-err]").hidden = true;
          fieldErr("lines", "");
          // the line total, the change chip and the bar follow without redrawing the inputs (focus stays)
          row.querySelector(".pu-fl-sum strong").textContent = usd((Number(lines[i].qty) || 0) * (Number(lines[i].cost_usd) || 0));
          updateDelta(row, i);
          paintTotal();
          scheduleDraft();
        });
        // Enter moves on: packs -> price -> the next line's packs (or the search box after the last line); it never submits by accident
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (k === 0) inputs[1].focus();
          else (linesEl.querySelector(`[data-i="${i + 1}"] [data-f="qty"]`) ?? searchEl).focus();
        });
      });
      row.querySelector("[data-remove]").addEventListener("click", () => {
        lines.splice(i, 1);
        paintLines();
        scheduleDraft();
      });
    });
    paintTotal();
  }

  // ---- product search ----------------------------------------------------------------------------------------------------------------
  let found = [];
  let active = 0;
  function paintResults() {
    resultsEl.innerHTML = found
      .map((p, k) => `<button type="button" class="pu-result ${k === active ? "pu-result-active" : ""}" role="option" aria-selected="${k === active}" data-pid="${p.id}">${escapeHtml(productLabel(p))}</button>`)
      .join("");
    resultsEl.querySelectorAll("[data-pid]").forEach((b) => b.addEventListener("click", () => add(Number(b.dataset.pid))));
  }
  function add(id) {
    lines.push({ product_id: id, qty: 0, cost_usd: 0 });
    searchEl.value = "";
    found = [];
    resultsEl.innerHTML = "";
    fieldErr("lines", "");
    paintLines();
    scheduleDraft();
    loadHistory([id]);
    linesEl.querySelector(`[data-i="${lines.length - 1}"] [data-f="qty"]`)?.focus();
  }
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim();
    found = q ? searchProducts(products, q).slice(0, 12) : [];
    active = 0;
    paintResults();
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && found.length) {
      e.preventDefault();
      active = (active + 1) % found.length;
      paintResults();
    } else if (e.key === "ArrowUp" && found.length) {
      e.preventDefault();
      active = (active - 1 + found.length) % found.length;
      paintResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (found[active]) add(found[active].id);
    }
  });
  // Ctrl/Cmd+Enter saves from anywhere
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ---- save --------------------------------------------------------------------------------------------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = $("#pu-error");
    errorEl.hidden = true;
    ["supplier", "no", "rate", "lines"].forEach((k) => fieldErr(k, ""));
    let firstBad = null;
    const bad = (el) => {
      firstBad ??= el;
    };
    const name = supplierName === "__new" ? String($("#pu-new-supplier input").value || "").trim() : supplierName;
    if (!name) {
      fieldErr("supplier", t("pu_need_supplier"));
      bad(supplierName === "__new" ? $("#pu-new-supplier input") : $("#pu-supplier-chips button"));
    }
    if (!noInput.value.trim()) {
      fieldErr("no", t("pu_need_no"));
      flag(noInput, true);
      bad(noInput);
    }
    const rate = num(rateInput.value);
    if (!(rate > 0)) {
      fieldErr("rate", t("pu_err_rate"));
      flag(rateInput, true);
      bad(rateInput);
    }
    if (!lines.length) {
      fieldErr("lines", t("pu_need_lines"));
      bad(searchEl);
    }
    linesEl.querySelectorAll("[data-i]").forEach((row) => {
      const l = lines[Number(row.dataset.i)];
      const qtyInput = row.querySelector('[data-f="qty"]');
      const costInput = row.querySelector('[data-f="cost_usd"]');
      const problems = [];
      if (!(Number(l.qty) > 0)) {
        problems.push(t("pu_err_qty"));
        flag(qtyInput, true);
        bad(qtyInput);
      }
      if (costInput.value.trim() === "" || !(Number(l.cost_usd) >= 0)) {
        problems.push(t("pu_err_cost"));
        flag(costInput, true);
        bad(costInput);
      }
      const err = row.querySelector("[data-err]");
      err.textContent = problems.join(" · ");
      err.hidden = !problems.length;
    });
    if (firstBad) {
      firstBad.scrollIntoView?.({ block: "center", behavior: "smooth" });
      firstBad.focus?.();
      return;
    }
    const supplier = suppliersData.suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const saveBtn = $("#pu-save");
    saveBtn.disabled = true;
    try {
      await api.savePurchase(editing ? invoice.id : null, {
        invoice_no: noInput.value.trim(),
        invoice_date: date,
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier ? null : name,
        usd_rate: rate,
        note: $("#pu-note").value.trim() || null,
        lines: lines.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), cost_usd: Number(l.cost_usd) })),
        client_ref: editing ? undefined : clientRef,
        allow_duplicate: allowDuplicate || undefined,
      });
      clearTimeout(saveTimer);
      if (fresh) clearDraft();
      close();
      onSaved?.();
    } catch (err) {
      saveBtn.disabled = false;
      if (err.status === 409 && err.body?.code === "duplicate") {
        showDuplicate(err.body.existing_id);
        $("#pu-dup").scrollIntoView?.({ block: "center", behavior: "smooth" });
        return;
      }
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      errorEl.scrollIntoView?.({ block: "center" });
    }
  });

  paintSupplier();
  offerNumber();
  offerRate();
  paintLines();
  checkDuplicate();
  loadHistory(lines.map((l) => l.product_id));
  // a fresh form starts where typing starts: the supplier is a tap, then the number
  if (!supplierName) $("#pu-supplier-chips button")?.focus();
}
