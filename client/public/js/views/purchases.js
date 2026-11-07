// Purchases (owner, 2026-11-07: "add new module Purchases, it should replace Purchase_IN in Excel"; side by side first). The supplier
// invoices of a period, from the app and from the Excel Purchase_IN sheet, each marked: matches Excel / differs / only in the app / only in
// the Excel. A tap opens the invoice with the app lines beside the Excel lines; an Excel-only invoice is copied into the app in one tap.
// Server: server/src/products/routes/purchases.js. Who: admin, CEO, operations director, accountant (canManagePurchases).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY, groupDigits, openInfoPopup, showToast } from "../util.js";
import { pickDate } from "../activityDatePicker.js";
import { getProductCatalog } from "../productCatalog.js";
import { searchProducts } from "../productSearch.js";
import { compareProducts } from "../productSort.js";
import { state } from "../state.js";
import { canDeletePurchases } from "../shared/roles.js";

const STATUSES = ["", "match", "diff", "app_only", "excel_only"];
const STATUS_LABEL = { "": "pu_st_all", match: "pu_st_match", diff: "pu_st_diff", app_only: "pu_st_app_only", excel_only: "pu_st_excel_only" };
const STATUS_BADGE = { match: "badge-success", diff: "badge-danger", app_only: "badge-warning", excel_only: "badge-neutral" };
const PERIODS = ["month", "3m", "year", "all"];

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function periodFrom(key) {
  const now = new Date();
  if (key === "month") return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  if (key === "3m") return isoDay(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  if (key === "year") return isoDay(new Date(now.getFullYear(), 0, 1));
  return null;
}
const usd = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const liters = (n) => `${groupDigits(Math.round(Number(n) || 0))} L`;
const monthTitle = (iso) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00`);
  return d.toLocaleDateString(document.documentElement.lang === "hy" ? "hy-AM" : "en-US", { month: "long", year: "numeric" });
};

export function renderPurchases(root) {
  let period = "3m";
  let status = "";
  let rows = [];
  root.innerHTML = `
    <div class="detail-view purchases-view">
      <div class="pu-head">
        <h1 class="pu-title">${t("pu_title")}<button type="button" class="settings-hint-icon" id="pu-hint" aria-label="${t("more_info")}">!</button></h1>
        <button type="button" class="btn btn-primary pu-new-btn" id="pu-new">${icons.plus}<span>${t("pu_new")}</span></button>
      </div>
      <div class="pu-chips" id="pu-periods" role="group">${PERIODS.map((p) => `<button type="button" class="map-filter-chip ${p === period ? "chip-active" : ""}" data-period="${p}" aria-pressed="${p === period}">${t(`pu_period_${p}`)}</button>`).join("")}</div>
      <div class="pu-chips" id="pu-statuses" role="group"></div>
      <div class="pu-totals" id="pu-totals"></div>
      <div class="card-list" id="pu-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  const listEl = root.querySelector("#pu-list");
  root.querySelector("#pu-hint").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("pu_hint"))}</p>`));
  root.querySelector("#pu-new").addEventListener("click", () => openPurchaseForm(null, { onSaved: load }));
  root.querySelectorAll("[data-period]").forEach((b) =>
    b.addEventListener("click", () => {
      period = b.dataset.period;
      root.querySelectorAll("[data-period]").forEach((x) => {
        x.classList.toggle("chip-active", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      load();
    })
  );

  function paint() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, s ? rows.filter((r) => r.status === s).length : rows.length]));
    root.querySelector("#pu-statuses").innerHTML = STATUSES.map(
      (s) => `<button type="button" class="map-filter-chip ${s === status ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === status}">${t(STATUS_LABEL[s])} <span class="pu-count">${counts[s]}</span></button>`
    ).join("");
    root.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", () => {
        status = b.dataset.status;
        paint();
      })
    );
    const shown = status ? rows.filter((r) => r.status === status) : rows;
    const sum = (k) => shown.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    root.querySelector("#pu-totals").innerHTML = shown.length
      ? `<span class="pu-totals-left">${shown.length} ${t(shown.length === 1 ? "pu_invoice_one" : "pu_invoices")} · ${liters(sum("liters"))}</span><span class="pu-totals-right"><strong>${usd(sum("usd"))}</strong><span class="muted">${formatAmd(sum("amd"))}</span></span>`
      : "";
    if (!shown.length) {
      listEl.innerHTML = `<p class="empty-state">${t("pu_none")}</p>`;
      return;
    }
    // grouped by month, newest first, each month with its USD total
    const groups = new Map();
    for (const r of shown) {
      const k = r.invoice_date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    listEl.innerHTML = [...groups.entries()]
      .map(
        ([k, list]) => `
      <div class="pu-month"><strong>${escapeHtml(monthTitle(`${k}-01`))}</strong><span>${usd(list.reduce((a, r) => a + r.usd, 0))}</span></div>
      <div class="card pu-group">${list
        .map(
          (r) => `<button type="button" class="pu-row" data-key="${escapeHtml(`${r.id ?? ""}|${r.invoice_no}|${r.invoice_date}`)}">
            <span class="pu-row-main"><strong>${escapeHtml(r.supplier || "—")}</strong><span class="muted">${escapeHtml(formatDateDMY(r.invoice_date))} · № ${escapeHtml(r.invoice_no)} · ${liters(r.liters)}</span></span>
            <span class="pu-row-side"><strong>${usd(r.usd)}</strong><span class="badge ${STATUS_BADGE[r.status]}">${t(STATUS_LABEL[r.status])}</span></span>
          </button>`
        )
        .join("")}</div>`
      )
      .join("");
    listEl.querySelectorAll("[data-key]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const [id, invoiceNo, date] = btn.dataset.key.split("|");
        openPurchaseSheet({ id: id ? Number(id) : null, invoiceNo, date, row: shown.find((r) => `${r.id ?? ""}|${r.invoice_no}|${r.invoice_date}` === btn.dataset.key) }, { onSaved: load });
      })
    );
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      rows = await api.listPurchases({ from: periodFrom(period) });
      paint();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  load();
}

// One invoice: the app lines beside the Excel lines. An app invoice can be edited (and deleted by admin / CEO); an Excel-only one copied in.
async function openPurchaseSheet({ id, invoiceNo, date, row }, { onSaved }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet pu-sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  const sheet = overlay.querySelector(".sheet");
  try {
    const app = id ? await api.getPurchase(id) : null;
    const excel = app ? app.excel_lines : await api.getExcelPurchase(invoiceNo, date);
    const lineRow = (l, side) => `<div class="pu-line">
        <span class="pu-line-name">${escapeHtml(l.app_product_name || l.product_name || l.erp_product_id || "")}${side === "excel" && !l.product_id && !app ? ` <span class="muted">(${t("pu_unknown_product")})</span>` : ""}</span>
        <span class="pu-line-qty">${groupDigits(l.qty)} × ${usd(l.cost_usd)}</span>
        <span class="pu-line-sum">${usd((Number(l.qty) || 0) * (Number(l.cost_usd) || 0))}</span>
      </div>`;
    const block = (title, lines, side) =>
      lines?.length
        ? `<h3 class="section-title section-title-tight">${title}</h3><div class="card pu-lines">${lines.map((l) => lineRow(l, side)).join("")}
            <div class="pu-line pu-line-total"><span>${t("total")}</span><span></span><span>${usd(lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost_usd) || 0), 0))}</span></div></div>`
        : "";
    const head = app ?? { supplier: row?.supplier, invoice_no: invoiceNo, invoice_date: date };
    const canDelete = app && canDeletePurchases(state.user.role);
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>
      <h2>${escapeHtml(head.supplier || "—")}</h2>
      <p class="muted">№ ${escapeHtml(head.invoice_no)} · ${escapeHtml(formatDateDMY(head.invoice_date))}${app ? ` · ${t("pu_rate")} ${groupDigits(app.usd_rate)}${app.created_by_name ? ` · ${t("pu_by")} ${escapeHtml(app.created_by_name)}` : ""}` : ""}</p>
      ${row ? `<p><span class="badge ${STATUS_BADGE[row.status]}">${t(STATUS_LABEL[row.status])}</span></p>` : ""}
      ${app?.note ? `<p class="muted">${escapeHtml(app.note)}</p>` : ""}
      ${block(t("pu_app_side"), app?.lines, "app")}
      ${block(t("pu_excel_side"), excel, "excel")}
      <p class="form-error" id="pu-sheet-error" hidden></p>
      <div class="sheet-actions">
        ${canDelete ? `<button type="button" class="btn btn-danger" id="pu-del">${t("pu_delete")}</button>` : ""}
        ${app ? `<button type="button" class="btn btn-primary" id="pu-edit">${t("pu_edit")}</button>` : `<button type="button" class="btn btn-primary" id="pu-copy">${t("pu_copy_from_excel")}</button>`}
      </div>`;
    sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
    sheet.querySelector("#pu-edit")?.addEventListener("click", () => {
      close();
      openPurchaseForm(app, { onSaved });
    });
    sheet.querySelector("#pu-copy")?.addEventListener("click", () => {
      close();
      // the Excel invoice as a filled form: supplier, number, date, and every line whose product the app knows
      openPurchaseForm(
        { invoice_no: invoiceNo, invoice_date: date, supplier: excel[0]?.supplier ?? row?.supplier ?? "", lines: excel.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, product_name: l.app_product_name, qty: l.qty, cost_usd: l.cost_usd })) },
        { onSaved }
      );
    });
    sheet.querySelector("#pu-del")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      // one tap arms, the second deletes (no confirm dialogs in this app)
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1";
        btn.textContent = `${t("pu_delete")}?`;
        setTimeout(() => {
          delete btn.dataset.armed;
          btn.textContent = t("pu_delete");
        }, 3000);
        return;
      }
      try {
        await api.deletePurchase(app.id);
        close();
        showToast(t("pu_deleted"));
        onSaved?.();
      } catch (err) {
        const el = sheet.querySelector("#pu-sheet-error");
        el.textContent = err.message;
        el.hidden = false;
      }
    });
  } catch (err) {
    sheet.innerHTML = `<button type="button" class="icon-btn sheet-close-x" aria-label="${t("close")}">${icons.close}</button><p class="form-error">${escapeHtml(err.message)}</p>`;
    sheet.querySelector(".sheet-close-x").addEventListener("click", close);
  }
}

// New / edit invoice. `invoice`: null (new), an app invoice (edit), or an Excel invoice to copy in (no id).
async function openPurchaseForm(invoice, { onSaved } = {}) {
  const editing = Boolean(invoice?.id);
  const lines = (invoice?.lines ?? []).map((l) => ({ product_id: l.product_id, product_name: l.product_name, qty: Number(l.qty), cost_usd: Number(l.cost_usd) }));
  let date = invoice?.invoice_date ?? isoDay(new Date());
  const clientRef = `pu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet pu-form-sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  const [{ suppliers, excel_names: excelNames }, catalog] = await Promise.all([api.listSuppliers().catch(() => ({ suppliers: [], excel_names: [] })), getProductCatalog().catch(() => [])]);
  const products = (catalog ?? []).slice().sort(compareProducts);
  const byId = new Map(products.map((p) => [p.id, p]));
  const supplierNames = [...suppliers.map((s) => s.name), ...excelNames];
  const initialSupplier = invoice?.supplier ?? "";
  const sheet = overlay.querySelector(".sheet");
  sheet.innerHTML = `
    <h2>${t(editing ? "pu_edit" : "pu_new")}</h2>
    <form id="pu-form" autocomplete="off">
      <label>${t("pu_supplier")}
        <select name="supplier">
          <option value="">${t("pu_supplier_pick")}</option>
          ${supplierNames.map((n) => `<option value="${escapeHtml(n)}" ${n.toLowerCase() === initialSupplier.toLowerCase() ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
          ${initialSupplier && !supplierNames.some((n) => n.toLowerCase() === initialSupplier.toLowerCase()) ? `<option value="${escapeHtml(initialSupplier)}" selected>${escapeHtml(initialSupplier)}</option>` : ""}
          <option value="__new">${t("pu_supplier_other")}</option>
        </select>
      </label>
      <label id="pu-new-supplier" hidden>${t("pu_supplier_new")}<input name="supplier_new" maxlength="120" /></label>
      <div class="pa-two">
        <label>${t("pu_invoice_no")}<input name="invoice_no" required maxlength="80" value="${escapeHtml(invoice?.invoice_no ?? "")}" /></label>
        <label>${t("pu_date")}<button type="button" class="btn pu-date-btn" id="pu-date">${escapeHtml(formatDateDMY(date))}</button></label>
      </div>
      <label>${t("pu_rate")}<input name="usd_rate" inputmode="decimal" required value="${escapeHtml(String(invoice?.usd_rate ?? ""))}" /></label>
      <h3 class="section-title section-title-tight">${t("pu_lines")}</h3>
      <div id="pu-lines" class="card pu-form-lines"></div>
      <div class="pu-add">
        <input type="search" id="pu-search" placeholder="${t("pu_search_product")}" aria-label="${t("pu_search_product")}" />
        <div id="pu-results" class="pu-results"></div>
      </div>
      <label>${t("pu_note")}<input name="note" maxlength="1000" value="${escapeHtml(invoice?.note ?? "")}" /></label>
      <p class="pu-form-total" id="pu-total"></p>
      <p class="form-error" id="pu-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="pu-cancel">${t("cancel")}</button>
        <button type="submit" class="btn btn-primary" id="pu-save">${t("pu_save")}</button>
      </div>
    </form>`;
  const form = sheet.querySelector("#pu-form");
  const select = form.querySelector('[name="supplier"]');
  const rateInput = form.querySelector('[name="usd_rate"]');
  const errorEl = sheet.querySelector("#pu-error");
  const linesEl = sheet.querySelector("#pu-lines");
  const resultsEl = sheet.querySelector("#pu-results");
  const searchEl = sheet.querySelector("#pu-search");
  sheet.querySelector("#pu-cancel").addEventListener("click", close);
  // the supplier's last rate is the starting rate of a new invoice
  const fillRate = () => {
    if (rateInput.value) return;
    const s = suppliers.find((x) => x.name === select.value);
    if (s?.last_usd_rate) rateInput.value = String(s.last_usd_rate);
  };
  select.addEventListener("change", () => {
    sheet.querySelector("#pu-new-supplier").hidden = select.value !== "__new";
    fillRate();
  });
  fillRate();
  sheet.querySelector("#pu-date").addEventListener("click", async (e) => {
    const picked = await pickDate({ value: date, title: t("pu_date") });
    if (picked) {
      date = picked;
      e.target.textContent = formatDateDMY(date);
    }
  });

  const total = () => lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost_usd) || 0), 0);
  function paintTotal() {
    const rate = Number(String(rateInput.value).replace(",", "."));
    sheet.querySelector("#pu-total").innerHTML = `${t("pu_total_usd")}: <strong>${usd(total())}</strong>${rate > 0 ? ` · ${t("pu_total_amd")}: <strong>${formatAmd(Math.round(total() * rate))}</strong>` : ""}`;
  }
  rateInput.addEventListener("input", paintTotal);
  function paintLines() {
    linesEl.innerHTML = lines.length
      ? lines
          .map((l, i) => {
            const p = byId.get(l.product_id);
            return `<div class="pu-form-line" data-i="${i}">
              <span class="pu-form-name">${escapeHtml(p ? `${p.brand ? `${p.brand} ` : ""}${p.name}${p.unit ? ` · ${p.unit}` : ""}` : l.product_name || "")}</span>
              <label class="pu-form-num"><span>${t("pu_packs")}</span><input data-f="qty" inputmode="decimal" value="${l.qty || ""}" /></label>
              <label class="pu-form-num"><span>${t("pu_cost_usd")}</span><input data-f="cost_usd" inputmode="decimal" value="${l.cost_usd || l.cost_usd === 0 ? l.cost_usd : ""}" /></label>
              <button type="button" class="icon-btn icon-btn-danger" data-remove aria-label="${t("pu_remove")}">${icons.trash}</button>
            </div>`;
          })
          .join("")
      : `<p class="muted pu-form-empty">${t("pu_need_lines")}</p>`;
    linesEl.querySelectorAll("[data-i]").forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll("[data-f]").forEach((input) =>
        input.addEventListener("input", () => {
          lines[i][input.dataset.f] = Number(String(input.value).replace(",", ".")) || 0;
          paintTotal();
        })
      );
      row.querySelector("[data-remove]").addEventListener("click", () => {
        lines.splice(i, 1);
        paintLines();
      });
    });
    paintTotal();
  }
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim();
    if (!q) {
      resultsEl.innerHTML = "";
      return;
    }
    const found = searchProducts(products, q).slice(0, 12);
    resultsEl.innerHTML = found
      .map((p) => `<button type="button" class="pu-result" data-pid="${p.id}">${escapeHtml(`${p.brand ? `${p.brand} ` : ""}${p.name}${p.unit ? ` · ${p.unit}` : ""}`)}</button>`)
      .join("");
    resultsEl.querySelectorAll("[data-pid]").forEach((b) =>
      b.addEventListener("click", () => {
        lines.push({ product_id: Number(b.dataset.pid), qty: 0, cost_usd: 0 });
        searchEl.value = "";
        resultsEl.innerHTML = "";
        paintLines();
        linesEl.querySelector(`[data-i="${lines.length - 1}"] [data-f="qty"]`)?.focus();
      })
    );
  });
  paintLines();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const supplierName = select.value === "__new" ? String(data.get("supplier_new") || "").trim() : select.value;
    const say = (key) => {
      errorEl.textContent = t(key);
      errorEl.hidden = false;
    };
    if (!supplierName) return say("pu_need_supplier");
    if (!String(data.get("invoice_no") || "").trim()) return say("pu_need_no");
    const good = lines.filter((l) => l.product_id && Number(l.qty) > 0 && Number(l.cost_usd) >= 0);
    if (!good.length || good.length !== lines.length) return say("pu_need_lines");
    const supplier = suppliers.find((s) => s.name.toLowerCase() === supplierName.toLowerCase());
    const saveBtn = sheet.querySelector("#pu-save");
    saveBtn.disabled = true;
    try {
      await api.savePurchase(editing ? invoice.id : null, {
        invoice_no: String(data.get("invoice_no")).trim(),
        invoice_date: date,
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier ? null : supplierName,
        usd_rate: Number(String(data.get("usd_rate")).replace(",", ".")),
        note: String(data.get("note") || "").trim() || null,
        lines: good.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), cost_usd: Number(l.cost_usd) })),
        client_ref: editing ? undefined : clientRef,
      });
      close();
      onSaved?.();
    } catch (err) {
      saveBtn.disabled = false;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
