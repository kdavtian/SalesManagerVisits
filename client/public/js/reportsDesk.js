// Reports on a desktop window (docs/desktop-roadmap.md, step 6): the list of reports on the left, the chosen report on the
// right, the last one opened remembered. Every report is the same view the phone shows, drawn into the right pane; around it
// this file adds what a wide screen needs:
//  - the filters the reports share (period, month, region, sales channel) travel from one report to the next;
//  - an Export (CSV of what the report shows, for Excel) and a Print button above every report.
// A phone never loads this file (reports.js only imports it on a desktop window).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml } from "./util.js";
import { downloadCsv } from "./deskTable.js";
import { periodLabel, periodKey } from "./periodButtons.js";

const LAST_KEY = "fieldvisits_last_report";
const FILTERS_KEY = "fieldvisits_report_filters";
const SHARED = ["period", "month", "region", "sales_channel"];
let reportsCache = null; // the list of reports this person may open (fetched once per session)

const read = (store, key, fallback) => {
  try {
    return store.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (store, key, value) => {
  try {
    store.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
};

/**
 * root: the page root; reportKey: from #/reports?r=; groups: [{ id, keys }] (reports.js REPORT_GROUPS);
 * renderReport(paneRoot, key): draws one report (reports.js); iconFor(key): the list icon.
 */
export async function renderReportsDesk(root, navigate, reportKey, { groups, renderReport, iconFor }) {
  root.innerHTML = `
    <div class="reports-split">
      <aside class="reports-side" aria-label="${escapeHtml(t("reports"))}">
        <h1 class="reports-side-title">${escapeHtml(t("reports"))}</h1>
        <nav class="reports-side-list"><p class="loading-state" role="status">${t("loading")}</p></nav>
      </aside>
      <section class="reports-pane" id="reports-pane"></section>
    </div>`;
  const side = root.querySelector(".reports-side-list");
  const pane = root.querySelector("#reports-pane");

  let reports;
  try {
    reports = reportsCache ?? (reportsCache = (await api.listReports()).filter((r) => r.key !== "erp_payments"));
  } catch (err) {
    side.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!reports.length) {
    side.innerHTML = `<p class="empty-state">${t("no_reports_available")}</p>`;
    return;
  }
  const allowed = new Set(reports.map((r) => r.key));
  // the report to show: the one in the link, else the last one opened, else the first in the list
  const ordered = [];
  const byKey = new Map(reports.map((r) => [r.key, r]));
  const sections = groups.map((g) => ({ id: g.id, items: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  const placed = new Set(sections.flatMap((g) => g.items.map((r) => r.key)));
  sections.push({ id: "other", items: reports.filter((r) => !placed.has(r.key)) });
  sections.forEach((g) => ordered.push(...g.items));
  const last = read(localStorage, LAST_KEY, "");
  const key = allowed.has(reportKey) ? reportKey : allowed.has(last) ? last : ordered[0].key;
  // #/reports (or a report this person may not open) is renamed to the report it shows (no second drawing), so the address,
  // Back and the app's back-cache (which files a screen under the address it was drawn with) all agree.
  if (reportKey !== key) (navigate.rewrite ?? navigate.replace)(`#/reports?r=${key}`);
  write(localStorage, LAST_KEY, key);

  side.innerHTML = sections
    .filter((g) => g.items.length)
    .map(
      (g) => `<div class="reports-side-group">
        <div class="reports-side-heading">${escapeHtml(t(`reports_group_${g.id}`))}</div>
        ${g.items
          .map(
            (r) => `<button type="button" class="reports-side-item${r.key === key ? " is-active" : ""}" data-report="${r.key}" ${r.key === key ? 'aria-current="page"' : ""} title="${escapeHtml(t(r.descriptionKey))}">
              <span class="reports-side-icon">${iconFor(r.key)}</span><span class="reports-side-name">${escapeHtml(t(r.nameKey))}</span>
            </button>`
          )
          .join("")}
      </div>`
    )
    .join("");
  side.addEventListener("click", (e) => {
    const item = e.target.closest("[data-report]");
    if (item && item.dataset.report !== key) navigate(`#/reports?r=${item.dataset.report}`);
  });
  side.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });

  // remember the shared filters as they are changed in any report
  pane.addEventListener("change", (e) => {
    const name = e.target?.name;
    if (!SHARED.includes(name)) return;
    const saved = savedFilters();
    saved[name] = e.target.value;
    write(sessionStorage, FILTERS_KEY, JSON.stringify(saved));
  });

  await renderReport(pane, key);
  if (!pane.isConnected) return;
  addTools(pane, key, t(byKey.get(key)?.nameKey || "reports"));
  applySharedFilters(pane);
}

function savedFilters() {
  try {
    return JSON.parse(read(sessionStorage, FILTERS_KEY, "{}")) || {};
  } catch {
    return {};
  }
}

// The values chosen in the previous report, where this report has the same filter and the same choice. Set quietly, then
// one "change" makes the report reload once.
function applySharedFilters(pane) {
  const saved = savedFilters();
  let changed = null;
  for (const name of SHARED) {
    const value = saved[name];
    if (value == null) continue;
    const el = pane.querySelector(`[name="${name}"]`);
    if (!el || el.value === value) continue;
    if (el.tagName === "SELECT") {
      if (![...el.options].some((o) => o.value === value)) continue;
      el.value = value;
      changed = el;
    } else if (el.type === "hidden" && el.closest(".report-period-tabs")) {
      const wrap = el.closest(".report-period-tabs");
      const buttons = [...wrap.querySelectorAll("[data-period-value]")];
      const exact = buttons.find((b) => b.dataset.periodValue === value);
      const previous = buttons.find((b) => b.dataset.base && periodKey(b.dataset.base, true) === value);
      const target = exact || previous;
      if (!target) continue;
      el.value = value;
      for (const b of buttons) {
        const on = b === target;
        b.classList.toggle("activity-tab-active", on);
        b.classList.toggle("period-prev", on && Boolean(previous) && !exact);
        b.setAttribute("aria-selected", String(on));
        if (b.dataset.base) b.textContent = periodLabel(b.dataset.base, on && Boolean(previous) && !exact);
      }
      changed = el;
    } else if (el.type === "month" || el.type === "date") {
      el.value = value;
      changed = el;
    }
  }
  changed?.dispatchEvent(new Event("change", { bubbles: true }));
}

/* ---------- Export + Print ---------- */

function addTools(pane, key, title) {
  const header = pane.querySelector(".detail-header") || pane.firstElementChild;
  if (!header) return;
  const tools = document.createElement("div");
  tools.className = "reports-pane-tools";
  tools.innerHTML = `
    <button type="button" class="btn btn-sm reports-tool" data-report-tool="export">${icons.download ?? ""}<span>${escapeHtml(t("desk_export_csv"))}</span></button>
    <button type="button" class="btn btn-sm reports-tool" data-report-tool="print">${icons.printer ?? ""}<span>${escapeHtml(t("print"))}</span></button>`;
  header.appendChild(tools);
  tools.addEventListener("click", (e) => {
    const tool = e.target.closest("[data-report-tool]")?.dataset.reportTool;
    if (tool === "print") window.print();
    else if (tool === "export") downloadCsv(`report-${key}-${new Date().toISOString().slice(0, 10)}.csv`, [title], reportRows(pane));
  });
}

// What the report shows, as rows: a section heading is a row of its own; every card (and every row of a table) is a row whose
// cells are its pieces of text in reading order (name, date, badge, amount...).
export function reportRows(pane) {
  const body = pane.querySelector(".detail-view") || pane;
  const rows = [];
  const text = (el) => (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const walk = (el) => {
    for (const child of el.children) {
      if (child.matches(".detail-header, .report-filter-form, form, .loading-state, button.btn, script, style, [hidden]")) continue;
      if (child.matches("table")) {
        child.querySelectorAll("tr").forEach((tr) => rows.push([...tr.children].map(text)));
        continue;
      }
      if (child.matches("h1, h2, h3, .section-title, .list-group-heading")) {
        const s = text(child);
        if (s) rows.push([s]);
        continue;
      }
      const isRow = child.matches(".card, .report-row, .report-row-multiline, .erp-order-row, .payments-received-row, [class*='-row']") && !child.querySelector(".card");
      if (isRow) {
        const cells = [...child.querySelectorAll("*")].filter((n) => !n.children.length && text(n) && !n.closest("svg")).map(text);
        if (cells.length) rows.push(cells);
        else if (text(child)) rows.push([text(child)]);
        continue;
      }
      if (child.children.length) walk(child);
      else if (text(child)) rows.push([text(child)]);
    }
  };
  walk(body);
  return rows;
}
