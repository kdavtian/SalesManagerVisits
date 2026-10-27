// The desktop table engine (docs/desktop-roadmap.md, step 1). A page's list stays the same markup the phone shows; on a
// desktop window (>= 1024 px) the rows become a grid and this file adds what a table on a wide screen needs: sortable
// headings, a column picker remembered per page, a density toggle, a row count with CSV export, a checkbox column with a
// bulk bar, and arrow / Enter / Esc keys. Every function here is inert on a phone: the markup is hidden by desktop.css
// and the page only calls the rest behind isDesktop().
import { escapeHtml } from "./util.js";
import { t } from "./i18n.js";

export const isDesktop = () => Boolean(window.matchMedia?.("(min-width: 1024px)").matches);
// Three panes (sidebar | list | docked panel) need this much; dockSheet.js uses the same limit.
export const isWide = () => Boolean(window.matchMedia?.("(min-width: 1400px)").matches);

// cells: one entry per grid cell after the icon column -- { align?: "end", items: [{ label, key? }] }
// opts.select adds the select-all checkbox cell in front of the icon cell; opts.picker puts the column gear in the last cell.
export function deskHeadHtml(extraClass, cells, opts = {}) {
  return `<div class="desk-thead ${extraClass}" role="presentation">
    ${opts.select ? `<span class="desk-th-check"><button type="button" class="desk-check desk-select-all" role="checkbox" aria-checked="false" aria-label="${escapeHtml(t("desk_select_all"))}" title="${escapeHtml(t("desk_select_all"))}"></button></span>` : ""}
    <span></span>
    ${cells
      .map(
        (cell) => `<div class="desk-th${cell.align === "end" ? " desk-th-end" : ""}${cell.extraClass ? ` ${cell.extraClass}` : ""}">${cell.items
          .map((i) =>
            i.key
              ? `<button type="button" class="desk-sort" data-sort-key="${i.key}" title="${escapeHtml(t("desk_col_sort_hint"))}">${escapeHtml(i.label)}<span class="desk-sort-arrow" aria-hidden="true"></span></button>`
              : `<span class="desk-th-label">${escapeHtml(i.label)}</span>`
          )
          .join("")}</div>`
      )
      .join("")}
    ${opts.picker ? `<button type="button" class="desk-col-gear" aria-label="${escapeHtml(t("desk_columns"))}" title="${escapeHtml(t("desk_columns"))}" aria-haspopup="menu">${GEAR}</button>` : "<span></span>"}
  </div>`;
}

const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.2 4.5v15M14.8 4.5v15"/></svg>`;

export function wireDeskHead(headEl, onPick) {
  headEl?.addEventListener("click", (e) => {
    const button = e.target.closest("[data-sort-key]");
    if (button) onPick(button.dataset.sortKey);
  });
}

// Only writes what changed -- an unchanged write would still wake every page-wide observer (see idle-dom.spec.mjs).
export function paintDeskHead(headEl, key, reversed) {
  headEl?.querySelectorAll("[data-sort-key]").forEach((button) => {
    const on = button.dataset.sortKey === key;
    const arrow = button.querySelector(".desk-sort-arrow");
    const text = on ? (reversed ? "▲" : "▼") : "";
    if (arrow.textContent !== text) arrow.textContent = text;
    if (button.classList.contains("desk-sort-on") !== on) button.classList.toggle("desk-sort-on", on);
    const aria = on ? (reversed ? "ascending" : "descending") : "none";
    if (button.getAttribute("aria-sort") !== aria) button.setAttribute("aria-sort", aria);
  });
}

/* ---------- Column picker + density (remembered on this device) ---------- */

const DENSITY_KEY = "fieldvisits_desk_density";
const readPref = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
};

export const isCompact = () => readPref(DENSITY_KEY) === "compact";
// One density for every desktop table: the class sits on <body>, desktop.css tightens the rows under it.
export function applyDensity() {
  document.body.classList.toggle("desk-compact", isCompact());
}

// columns: [{ key, label, width, sort?, align?, narrow?, cell(row) -> text, csv?(row) -> text }]
// Returns the visible set for this page: the saved choice, or `defaults` the first time.
export function deskColumns(pageKey, columns, defaults) {
  const storageKey = `fieldvisits_desk_cols_${pageKey}`;
  const known = new Set(columns.map((c) => c.key));
  let visible;
  const saved = readPref(storageKey);
  if (saved) {
    try {
      visible = new Set(JSON.parse(saved).filter((k) => known.has(k)));
    } catch {
      visible = null;
    }
  }
  if (!visible) visible = new Set(defaults);
  const api = {
    isOn: (key) => visible.has(key),
    // the columns in their fixed order, only the visible ones
    list: () => columns.filter((c) => visible.has(c.key)),
    set(key, on) {
      if (on) visible.add(key);
      else visible.delete(key);
      writePref(storageKey, JSON.stringify([...visible]));
    },
    toggle(key) {
      api.set(key, !visible.has(key));
    },
  };
  return api;
}

// The gear menu: one checkbox per column, then the density switch. Closes on an outside click or Esc.
export function openDeskColumnMenu(anchor, columns, cols, onChange) {
  document.querySelector(".desk-col-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "desk-col-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <div class="desk-col-menu-title">${escapeHtml(t("desk_columns"))}</div>
    ${columns
      .map(
        (c) => `<label class="desk-col-menu-item"><input type="checkbox" data-col="${c.key}" ${cols.isOn(c.key) ? "checked" : ""} /><span>${escapeHtml(c.label)}</span></label>`
      )
      .join("")}
    <div class="desk-col-menu-sep"></div>
    <label class="desk-col-menu-item"><input type="checkbox" data-density ${isCompact() ? "checked" : ""} /><span>${escapeHtml(t("desk_density_compact"))}</span></label>`;
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      anchor.focus();
    }
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  menu.addEventListener("change", (e) => {
    const input = e.target;
    if (input.dataset.col) cols.set(input.dataset.col, input.checked);
    else if (input.hasAttribute("data-density")) {
      writePref(DENSITY_KEY, input.checked ? "compact" : "comfortable");
      applyDensity();
    }
    onChange();
  });
  menu.querySelector("input")?.focus();
  return close;
}

/* ---------- Row count + CSV ---------- */

export function deskFootHtml(count, { exportable = true } = {}) {
  return `<div class="desk-foot"><span class="desk-foot-count">${escapeHtml(t("desk_rows_count").replace("{n}", count.toLocaleString("en-US")))}</span>${
    exportable ? `<button type="button" class="desk-foot-export" data-desk-export>${escapeHtml(t("desk_export_csv"))}</button>` : ""
  }</div>`;
}

// UTF-8 BOM so Excel on Windows opens Armenian text; CRLF rows; every cell quoted.
export function downloadCsv(filename, header, rows) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Selection + bulk bar ---------- */

// A row's checkbox (not an <input>: the row itself is a <button>, which must not contain another control).
export const deskCheckHtml = (id, selected) =>
  `<span class="desk-check${selected ? " desk-check-on" : ""}" role="checkbox" aria-checked="${selected}" data-select="${id}" aria-label="${escapeHtml(t("desk_select_row"))}"></span>`;

// bar: the .desk-bulk element; actions: [{ key, label, primary? }]
export function paintBulkBar(bar, count, actions) {
  if (!bar) return;
  if (!count) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `<span class="desk-bulk-count">${escapeHtml(t("desk_selected").replace("{n}", count))}</span>
    ${actions.map((a) => `<button type="button" class="btn btn-sm${a.primary ? " btn-primary" : ""}" data-bulk="${a.key}">${escapeHtml(a.label)}</button>`).join("")}
    <button type="button" class="desk-bulk-clear" data-bulk="clear">${escapeHtml(t("desk_clear_selection"))}</button>`;
}

/* ---------- Keyboard ---------- */

// Arrow keys move between rows (they are buttons, so Enter is a click already), Space toggles the row's checkbox,
// Esc closes the docked panel. Only wired on a desktop window.
export function wireDeskKeys(listEl, { rowSelector, onToggle, onEscape } = {}) {
  listEl.addEventListener("keydown", (e) => {
    if (!isDesktop()) return;
    const row = e.target.closest?.(rowSelector);
    if (e.key === "Escape") {
      onEscape?.();
      return;
    }
    if (!row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...listEl.querySelectorAll(rowSelector)];
      const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (e.key === " " && onToggle) {
      e.preventDefault();
      onToggle(row);
    }
  });
}
