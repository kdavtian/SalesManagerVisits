// Purchases (owner, 2026-11-07: "add new module Purchases, it should replace Purchase_IN in Excel"; side by side first). The supplier
// invoices of a period, from the app and from the Excel Purchase_IN sheet, each marked: matches Excel / differs / only in the app / only in
// the Excel. A tap opens the invoice with the app lines beside the Excel lines; an Excel-only invoice is copied into the app in one tap.
// Server: server/src/products/routes/purchases.js. Who: admin, CEO, operations director, accountant (canManagePurchases).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY, groupDigits, openInfoPopup, showToast } from "../util.js";
import { state } from "../state.js";
import { canDeletePurchases } from "../shared/roles.js";
import { sinceText } from "../purchaseNumbers.js";
import { openPurchaseForm } from "./purchases/form.js";
import { openImportSheet } from "./purchases/importSheet.js";

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
// whole dollars for the summary cards (a figure to read at a glance); the rows and the form keep the cents
const usd0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const liters = (n) => `${groupDigits(Math.round(Number(n) || 0))} L`;
const monthTitle = (iso) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00`);
  return d.toLocaleDateString(document.documentElement.lang === "hy" ? "hy-AM" : "en-US", { month: "long", year: "numeric" });
};

export function renderPurchases(root) {
  let period = "3m";
  let status = "";
  let supplier = ""; // lower-case supplier name; "" = all
  let query = "";
  let rows = [];
  let excel = null; // GET /purchases/status
  root.innerHTML = `
    <div class="detail-view purchases-view">
      <div class="pu-head">
        <h1 class="pu-title">${t("pu_title")}<button type="button" class="settings-hint-icon" id="pu-hint" aria-label="${t("more_info")}">!</button></h1>
        <div class="pu-head-actions">
          <button type="button" class="btn pu-import-btn" id="pu-import"><span class="pu-icon-up" aria-hidden="true">${icons.download}</span><span>${t("pu_import")}</span></button>
          <button type="button" class="btn btn-primary pu-new-btn" id="pu-new">${icons.plus}<span>${t("pu_new")}</span></button>
        </div>
      </div>
      <div id="pu-excel"></div>
      <div class="pu-chips" id="pu-periods" role="group">${PERIODS.map((p) => `<button type="button" class="map-filter-chip ${p === period ? "chip-active" : ""}" data-period="${p}" aria-pressed="${p === period}">${t(`pu_period_${p}`)}</button>`).join("")}</div>
      <div class="pu-kpis" id="pu-kpis"></div>
      <div class="pu-suppliers" id="pu-suppliers"></div>
      <div class="pu-toolbar">
        <div class="pu-search"><input type="search" id="pu-list-search" placeholder="${t("pu_search_list")}" aria-label="${t("pu_search_list")}" autocomplete="off" /></div>
        <div class="pu-chips pu-chips-inline" id="pu-statuses" role="group"></div>
      </div>
      <div class="card-list" id="pu-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  const listEl = root.querySelector("#pu-list");
  // an invoice by its id (the form's "Open it" of a duplicate warning)
  const openInvoice = (id) => {
    const r = rows.find((x) => x.id === id);
    openPurchaseSheet({ id, invoiceNo: r?.invoice_no, date: r?.invoice_date, row: r }, { onSaved: load, rows, openInvoice });
  };
  root.querySelector("#pu-hint").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("pu_hint"))}</p>`));
  root.querySelector("#pu-new").addEventListener("click", () => openPurchaseForm(null, { onSaved: load, rows, openInvoice }));
  root.querySelector("#pu-import").addEventListener("click", () => openImportSheet({ onDone: load }));
  root.querySelector("#pu-list-search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    paint();
  });
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

  // What the Excel copy holds, or -- while it holds nothing -- a card that says why and offers the file import
  function paintExcel() {
    const el = root.querySelector("#pu-excel");
    if (!excel) {
      el.innerHTML = "";
      return;
    }
    if (!excel.excel_lines) {
      el.innerHTML = `<div class="card pu-excel-empty" role="status">
          <strong>${t("pu_excel_none_title")}</strong>
          <p class="muted">${t("pu_excel_none_body")}</p>
          <button type="button" class="btn btn-primary" id="pu-excel-import"><span class="pu-icon-up" aria-hidden="true">${icons.download}</span><span>${t("pu_import")}</span></button>
        </div>`;
      el.querySelector("#pu-excel-import").addEventListener("click", () => openImportSheet({ onDone: load }));
      return;
    }
    const text = t("pu_excel_status")
      .replace("{lines}", groupDigits(excel.excel_lines))
      .replace("{invoices}", groupDigits(excel.excel_invoices))
      .replace("{from}", formatDateDMY(excel.from))
      .replace("{to}", formatDateDMY(excel.to))
      .replace("{when}", `${sinceText(excel.synced_at, Date.now(), { min: t("pu_unit_min"), h: t("pu_unit_h"), d: t("pu_unit_d") })} ${t("pu_ago")}`);
    el.innerHTML = `<p class="pu-excel-line muted">${escapeHtml(text)}</p>`;
  }

  const bySupplier = (list) => {
    const map = new Map();
    for (const r of list) {
      const key = String(r.supplier || "—").toLowerCase();
      const g = map.get(key) ?? { key, name: r.supplier || "—", usd: 0, liters: 0, invoices: 0 };
      g.usd += r.usd;
      g.liters += r.liters;
      g.invoices += 1;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.usd - a.usd);
  };
  const matches = (r) => {
    if (status && r.status !== status) return false;
    if (query && !`${r.supplier ?? ""} ${r.invoice_no}`.toLowerCase().includes(query)) return false;
    return true;
  };

  function paint() {
    const base = rows.filter(matches); // before the supplier filter: the supplier cards show every supplier's share
    const shown = supplier ? base.filter((r) => String(r.supplier || "—").toLowerCase() === supplier) : base;
    const statusBase = rows.filter((r) => (!query || `${r.supplier ?? ""} ${r.invoice_no}`.toLowerCase().includes(query)) && (!supplier || String(r.supplier || "—").toLowerCase() === supplier));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, s ? statusBase.filter((r) => r.status === s).length : statusBase.length]));
    root.querySelector("#pu-statuses").innerHTML = STATUSES.map(
      (s) => `<button type="button" class="map-filter-chip ${s === status ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === status}">${t(STATUS_LABEL[s])} <span class="pu-count">${counts[s]}</span></button>`
    ).join("");
    root.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", () => {
        status = b.dataset.status;
        paint();
      })
    );
    // KPI cards of what is shown
    const sum = (k) => shown.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const usdTotal = sum("usd");
    const litersTotal = sum("liters");
    root.querySelector("#pu-kpis").innerHTML = shown.length
      ? [
          [t("pu_kpi_invoices"), groupDigits(shown.length), ""],
          [t("pu_kpi_liters"), liters(litersTotal), ""],
          [t("pu_kpi_usd"), usd0(usdTotal), formatAmd(sum("amd"))],
          [t("pu_kpi_per_l"), litersTotal > 0 ? usd(usdTotal / litersTotal) : "—", ""],
        ]
          .map(([label, value, sub]) => `<div class="pu-kpi"><span class="pu-kpi-label">${label}</span><strong class="pu-kpi-value">${value}</strong>${sub ? `<span class="pu-kpi-sub muted">${sub}</span>` : ""}</div>`)
          .join("")
      : "";
    // supplier cards: share of the spend; a tap filters by that supplier (a second tap clears it)
    const groups = bySupplier(base);
    const topUsd = groups.reduce((a, g) => a + g.usd, 0) || 1;
    root.querySelector("#pu-suppliers").innerHTML =
      groups.length > 1 || supplier
        ? groups
            .map(
              (g) => `<button type="button" class="pu-supplier ${g.key === supplier ? "pu-supplier-active" : ""}" data-supplier="${escapeHtml(g.key)}" aria-pressed="${g.key === supplier}">
                <span class="pu-supplier-name">${escapeHtml(g.name)}</span>
                <span class="pu-supplier-usd">${usd0(g.usd)}</span>
                <span class="pu-supplier-bar" aria-hidden="true"><i style="width:${Math.max(3, Math.round((g.usd / topUsd) * 100))}%"></i></span>
                <span class="pu-supplier-meta muted">${Math.round((g.usd / topUsd) * 100)}% · ${liters(g.liters)}${g.liters > 0 ? ` · ${usd(g.usd / g.liters)}/L` : ""}</span>
              </button>`
            )
            .join("")
        : "";
    root.querySelectorAll("[data-supplier]").forEach((b) =>
      b.addEventListener("click", () => {
        supplier = supplier === b.dataset.supplier ? "" : b.dataset.supplier;
        paint();
      })
    );
    if (!shown.length) {
      const anyRows = rows.length > 0;
      listEl.innerHTML = `<div class="empty-state pu-empty"><p>${t(anyRows ? "pu_none_search" : "pu_none")}</p>${!anyRows && period !== "all" ? `<button type="button" class="btn" id="pu-all-time">${t("pu_show_all")}</button>` : ""}</div>`;
      listEl.querySelector("#pu-all-time")?.addEventListener("click", () => root.querySelector('[data-period="all"]').click());
      return;
    }
    // grouped by month, newest first, each month with its USD total
    const months = new Map();
    for (const r of shown) {
      const k = r.invoice_date.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(r);
    }
    const rowKey = (r) => `${r.id ?? ""}|${r.invoice_no}|${r.invoice_date}`;
    listEl.innerHTML = [...months.entries()]
      .map(
        ([k, list]) => `
      <div class="pu-month"><strong>${escapeHtml(monthTitle(`${k}-01`))}</strong><span>${list.length} · ${usd(list.reduce((a, r) => a + r.usd, 0))}</span></div>
      <div class="card pu-group">${list
        .map(
          (r) => `<button type="button" class="pu-row" data-key="${escapeHtml(rowKey(r))}">
            <span class="pu-row-main"><strong>${escapeHtml(r.supplier || "—")}</strong><span class="muted">${escapeHtml(formatDateDMY(r.invoice_date))} · № ${escapeHtml(r.invoice_no)} · ${liters(r.liters)}</span></span>
            <span class="pu-row-cols">
              <span class="pu-col-date">${escapeHtml(formatDateDMY(r.invoice_date))}</span>
              <span class="pu-col-no">№ ${escapeHtml(r.invoice_no)}</span>
              <span class="pu-col-liters">${liters(r.liters)}</span>
              <span class="pu-col-perl">${r.liters > 0 ? `${usd(r.usd / r.liters)}/L` : "—"}</span>
              <span class="pu-col-amd muted">${formatAmd(r.amd)}</span>
            </span>
            <span class="pu-row-side"><strong>${usd(r.usd)}</strong><span class="badge ${STATUS_BADGE[r.status]}">${t(STATUS_LABEL[r.status])}</span></span>
          </button>`
        )
        .join("")}</div>`
      )
      .join("");
    listEl.querySelectorAll("[data-key]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const [id, invoiceNo, date] = btn.dataset.key.split("|");
        openPurchaseSheet({ id: id ? Number(id) : null, invoiceNo, date, row: shown.find((r) => rowKey(r) === btn.dataset.key) }, { onSaved: load, rows, openInvoice });
      })
    );
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const [list, st] = await Promise.all([api.listPurchases({ from: periodFrom(period) }), api.getPurchasesStatus().catch(() => null)]);
      rows = list;
      excel = st;
      paintExcel();
      paint();
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  load();
}

// One invoice: the app lines beside the Excel lines. An app invoice can be edited (and deleted by admin / CEO); an Excel-only one copied in.
async function openPurchaseSheet({ id, invoiceNo, date, row }, { onSaved, rows = [], openInvoice }) {
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
    const sumOf = (lines) => lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost_usd) || 0), 0);
    const litersOf = (lines) => lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.size_l) || 0), 0);
    const lineRow = (l, side) => `<div class="pu-line">
        <span class="pu-line-name">${escapeHtml(l.app_product_name || l.product_name || l.erp_product_id || "")}${l.size_l ? ` <span class="muted">· ${groupDigits(l.size_l)} L</span>` : ""}${side === "excel" && !l.product_id && !app ? ` <span class="muted">(${t("pu_unknown_product")})</span>` : ""}</span>
        <span class="pu-line-qty">${groupDigits(l.qty)} × ${usd(l.cost_usd)}</span>
        <span class="pu-line-sum">${usd((Number(l.qty) || 0) * (Number(l.cost_usd) || 0))}</span>
      </div>`;
    const block = (title, lines, side) =>
      lines?.length
        ? `<h3 class="section-title section-title-tight">${title}</h3><div class="card pu-lines">${lines.map((l) => lineRow(l, side)).join("")}
            <div class="pu-line pu-line-total"><span>${t("total")} · ${groupDigits(lines.reduce((a, l) => a + (Number(l.qty) || 0), 0))} ${t("pu_total_packs").toLowerCase()}${litersOf(lines) > 0 ? ` · ${liters(litersOf(lines))}` : ""}</span><span></span><span>${usd(sumOf(lines))}</span></div></div>`
        : "";
    const head = app ?? { supplier: row?.supplier, invoice_no: invoiceNo, invoice_date: date };
    const canDelete = app && canDeletePurchases(state.user.role);
    // the Excel's own notes of this invoice ("Total: 8441.08$ Paid: 8441.08$"): shown once each
    const notes = [...new Set((excel ?? []).map((l) => l.info).filter(Boolean))];
    const rate = app?.usd_rate;
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>
      <h2>${escapeHtml(head.supplier || "—")}</h2>
      <p class="muted">№ ${escapeHtml(head.invoice_no)} · ${escapeHtml(formatDateDMY(head.invoice_date))}${app ? ` · ${t("pu_rate")} ${groupDigits(app.usd_rate)}${app.created_by_name ? ` · ${t("pu_by")} ${escapeHtml(app.created_by_name)}` : ""}` : ""}</p>
      ${row ? `<p class="pu-sheet-status"><span class="badge ${STATUS_BADGE[row.status]}">${t(STATUS_LABEL[row.status])}</span>${rate ? ` <span class="muted">${formatAmd(Math.round(sumOf(app.lines) * rate))} · ${liters(litersOf(app.lines))}</span>` : ""}</p>` : ""}
      ${app?.note ? `<p class="muted">${escapeHtml(app.note)}</p>` : ""}
      ${notes.length ? `<p class="pu-excel-notes"><span class="muted">${t("pu_excel_notes")}:</span> ${notes.map(escapeHtml).join(" · ")}</p>` : ""}
      ${block(t("pu_app_side"), app?.lines, "app")}
      ${block(t("pu_excel_side"), excel, "excel")}
      <p class="form-error" id="pu-sheet-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating">
        ${canDelete ? `<button type="button" class="btn btn-danger" id="pu-del">${t("pu_delete")}</button>` : ""}
        <button type="button" class="btn" id="pu-repeat">${t("pu_repeat")}</button>
        ${app ? `<button type="button" class="btn btn-primary" id="pu-edit">${t("pu_edit")}</button>` : `<button type="button" class="btn btn-primary" id="pu-copy">${t("pu_copy_from_excel")}</button>`}
      </div>`;
    sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
    sheet.querySelector("#pu-edit")?.addEventListener("click", () => {
      close();
      openPurchaseForm(app, { onSaved, rows, openInvoice });
    });
    // Repeat (owner, 2026-11-07): a new invoice with the same supplier, products, packs and prices; today's date, a new number to type
    sheet.querySelector("#pu-repeat").addEventListener("click", () => {
      close();
      const from = app ? app.lines : excel.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, product_name: l.app_product_name, qty: l.qty, cost_usd: l.cost_usd }));
      openPurchaseForm({ supplier: head.supplier ?? "", usd_rate: app?.usd_rate, lines: from }, { onSaved, rows, openInvoice });
    });
    sheet.querySelector("#pu-copy")?.addEventListener("click", () => {
      close();
      // the Excel invoice as a filled form: supplier, number, date, and every line whose product the app knows
      openPurchaseForm(
        { invoice_no: invoiceNo, invoice_date: date, supplier: excel[0]?.supplier ?? row?.supplier ?? "", lines: excel.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id, product_name: l.app_product_name, qty: l.qty, cost_usd: l.cost_usd })) },
        { onSaved, rows, openInvoice }
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
