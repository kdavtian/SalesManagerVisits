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
              : `<span class="desk-th-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>`
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
      e.preventDefault();
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
    onChange(input.dataset.col || "");
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
      if (document.querySelector(".sheet-overlay.sheet-docked")) e.preventDefault();
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

/* ---------- One table per page (step 2): head, cells, foot, selection and keys in one object ----------
   A page keeps its phone markup and only adds `table.checkHtml(row)` before the icon and `table.cellsHtml(row)` after the
   body of every row, calls renderHead() when its shell is built and renderFoot(n) + paintSelection() after the list is
   painted. Elements may be given as functions when the page rebuilds its shell (Activity, Tasks). */
const el = (x) => (typeof x === "function" ? x() : x);
// the smallest width of the name cell and of the chips cell (any further lead cell): below that the table scrolls sideways
const LEAD_MIN = [200, 120];
const scrollSynced = new WeakSet();

export function createDeskTable(opts) {
  const {
    pageKey,
    columns,
    defaults,
    lead,
    leadCols,
    leadColsDocked = "minmax(0, 1fr)",
    rowSelector,
    idOf = (r) => r.id,
    rows,
    sort,
    onSort,
    dockedPrefix = "",
    csvName = pageKey,
    csvLead = { header: [], row: () => [] },
    bulkActions = null,
    onBulk = null,
    onColumnsChange = null,
    onEscape = () => document.querySelector(".sheet-overlay.sheet-docked")?.remove(),
    root,
  } = opts;
  const cols = deskColumns(pageKey, columns(), defaults);
  const internal = new Set();
  const selection = opts.selection || {
    isOn: (id) => internal.has(id),
    toggle: (id) => (internal.has(id) ? internal.delete(id) : internal.add(id)),
    selectAll: (list) => list.forEach((r) => internal.add(idOf(r))),
    clear: () => internal.clear(),
    size: () => internal.size,
  };
  const withSelection = Boolean(opts.selection || bulkActions);
  let headEl = null;
  let lastDocked = null;

  const docked = () => Boolean(dockedPrefix) && isWide() && dockedKeyNow().startsWith(dockedPrefix);
  const visibleColumns = () => {
    const d = docked();
    return cols.list().filter((c) => !d || c.narrow);
  };
  // grid column of the first optional cell: [checkbox] | icon | the fixed cells (only the first one beside a docked panel)
  const firstCell = () => 2 + (withSelection ? 1 : 0) + (docked() ? 1 : lead.length);

  function renderHead() {
    const slot = el(opts.headSlot);
    const view = el(opts.view);
    if (!slot || !view) return;
    if (!isDesktop()) {
      slot.innerHTML = "";
      view.classList.remove("desk-view", "desk-docked");
      headEl = null;
      return;
    }
    const d = docked();
    const list = visibleColumns();
    view.classList.add("desk-view");
    view.classList.toggle("desk-docked", d);
    view.classList.toggle("desk-no-select", !withSelection);
    view.dataset.deskCols = list.map((c) => c.key).join(" ");
    // The name and chips cells keep a readable minimum, so with many columns the table grows wider than the window: it then
    // scrolls sideways inside its own box (heading row in step) instead of pushing columns out of sight (owner, 2026-10-29).
    let leadIndex = 0;
    const leadTracks = (d ? leadColsDocked : leadCols).replace(/minmax\(0,/g, () => `minmax(${LEAD_MIN[Math.min(leadIndex++, 1)]}px,`);
    const widths = list.map((c) => (d ? c.narrowWidth || c.width : c.width));
    view.style.setProperty("--desk-cols", `${withSelection ? "24px " : ""}36px ${leadTracks} ${widths.join(" ")} 28px`.replace(/\s+/g, " "));
    const leadMins = LEAD_MIN.slice(0, leadIndex).reduce((a, b) => a + b, 0) + Math.max(0, leadIndex - LEAD_MIN.length) * LEAD_MIN[1];
    const tracks = (withSelection ? 1 : 0) + 2 + leadIndex + widths.length;
    const fixed = (withSelection ? 24 : 0) + 36 + 28 + widths.reduce((sum, w) => sum + (parseFloat(w) || 0), 0) + leadMins;
    const leadCells = (d ? lead.slice(0, 1) : lead).map((c) => ({ align: c.align, items: [c.key ? { label: c.label, key: c.key } : { label: c.label }] }));
    slot.innerHTML = deskHeadHtml(
      `desk-thead-${pageKey}`,
      [...leadCells, ...list.map((c) => ({ align: c.align, items: [c.sort ? { label: c.label, key: c.sort } : { label: c.label }] }))],
      { select: withSelection, picker: true }
    );
    headEl = slot.firstElementChild;
    const gap = parseFloat(getComputedStyle(headEl).columnGap) || 16;
    view.style.setProperty("--desk-min-w", `${Math.ceil(fixed + gap * (tracks - 1))}px`);
    if (!scrollSynced.has(view)) {
      scrollSynced.add(view);
      // scroll does not bubble: caught on the way down, the list's sideways scroll moves its heading row with it
      view.addEventListener(
        "scroll",
        (e) => {
          const head = view.querySelector(".desk-thead");
          if (head && e.target.classList?.contains("card-list")) head.scrollLeft = e.target.scrollLeft;
        },
        { capture: true, passive: true }
      );
    }
    wireDeskHead(headEl, (key) => onSort?.(key));
    headEl.querySelector(".desk-col-gear").addEventListener("click", (e) => {
      openDeskColumnMenu(e.currentTarget, columns(), cols, (changedKey) => {
        if (onColumnsChange?.(changedKey) === false) return;
        renderHead();
        opts.onRepaint?.();
      });
    });
    headEl.querySelector(".desk-select-all")?.addEventListener("click", () => {
      const list = rows();
      const all = list.length > 0 && list.every((r) => selection.isOn(idOf(r)));
      if (all) selection.clear();
      else selection.selectAll(list);
      paintSelection();
    });
    paintSort();
  }

  function paintSort() {
    const s = sort?.();
    if (headEl && s) paintDeskHead(headEl, s.key, s.reversed);
  }

  const cellsHtml = (row) => {
    if (!isDesktop()) return "";
    const first = firstCell();
    return visibleColumns()
      .map((c, i) => {
        const value = c.cell(row);
        return `<span class="desk-cell desk-cell-${c.key}${c.align === "end" ? " desk-cell-end" : ""}" style="grid-column:${first + i}">${c.html ? value : escapeHtml(value ?? "")}</span>`;
      })
      .join("");
  };
  const checkHtml = (row) => (isDesktop() && withSelection ? deskCheckHtml(idOf(row), selection.isOn(idOf(row))) : "");

  function renderFoot(count) {
    const foot = el(opts.footSlot);
    if (!foot) return;
    if (!isDesktop()) {
      foot.innerHTML = "";
      return;
    }
    foot.innerHTML = deskFootHtml(count);
    foot.querySelector("[data-desk-export]").addEventListener("click", () => {
      const list = rows();
      const chosen = withSelection ? list.filter((r) => selection.isOn(idOf(r))) : [];
      exportCsv(chosen.length ? chosen : list);
    });
  }

  function exportCsv(list) {
    const vis = visibleColumns();
    downloadCsv(
      `${csvName}-${new Date().toISOString().slice(0, 10)}.csv`,
      [...csvLead.header, ...vis.map((c) => c.label)],
      list.map((r) => [...csvLead.row(r), ...vis.map((c) => (c.csv ? c.csv(r) : c.html ? String(c.cell(r)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : c.cell(r)))])
    );
  }

  function paintSelection() {
    if (!withSelection || !isDesktop()) return;
    const listEl = el(opts.listEl);
    listEl?.querySelectorAll(".desk-check[data-select]").forEach((box) => {
      const on = selection.isOn(Number(box.dataset.select));
      if (box.classList.contains("desk-check-on") !== on) box.classList.toggle("desk-check-on", on);
      if (box.getAttribute("aria-checked") !== String(on)) box.setAttribute("aria-checked", String(on));
      const row = box.closest(rowSelector);
      if (row && row.classList.contains("row-selected") !== on) row.classList.toggle("row-selected", on);
    });
    const all = headEl?.querySelector(".desk-select-all");
    const list = rows();
    const chosen = list.filter((r) => selection.isOn(idOf(r)));
    if (all) {
      const every = list.length > 0 && chosen.length === list.length;
      const some = chosen.length > 0;
      all.classList.toggle("desk-check-on", every);
      all.classList.toggle("desk-check-some", some && !every);
      all.setAttribute("aria-checked", every ? "true" : some ? "mixed" : "false");
    }
    const bar = el(opts.bulkEl);
    if (bar && bulkActions) {
      paintBulkBar(bar, chosen.length, [...bulkActions(chosen), { key: "export", label: t("desk_export_csv") }]);
    }
  }

  // Delegated on a stable ancestor that holds the list AND the bulk bar (`root`): the list element itself may be rebuilt with the shell.
  const host = root || el(opts.listEl);
  const onClick = (e) => {
    // Inside a <button> row the browser reports the row as the target, so the box is found by where the click landed.
    let check = e.target.closest?.(".desk-check[data-select]");
    if (!check && e.clientX) {
      const row = e.target.closest?.(rowSelector);
      const box = row?.querySelector(".desk-check[data-select]");
      const r = box?.getBoundingClientRect();
      if (r && e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8) check = box;
    }
    if (check) {
      e.stopPropagation();
      e.preventDefault();
      selection.toggle(Number(check.dataset.select));
      paintSelection();
      return;
    }
    const bulk = e.target.closest?.("[data-bulk]");
    if (bulk && el(opts.bulkEl)?.contains(bulk)) {
      const key = bulk.dataset.bulk;
      const chosen = rows().filter((r) => selection.isOn(idOf(r)));
      if (key === "clear") {
        selection.clear();
        paintSelection();
      } else if (key === "export") exportCsv(chosen);
      else onBulk?.(key, chosen);
    }
  };
  host.addEventListener("click", onClick, true);
  const onKey = (e) => {
    if (!isDesktop()) return;
    const row = e.target.closest?.(rowSelector);
    if (e.key === "Escape") {
      if (document.querySelector(".sheet-overlay.sheet-docked")) e.preventDefault();
      onEscape?.();
      return;
    }
    if (!row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...host.querySelectorAll(rowSelector)];
      const next = all[all.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (e.key === " " && withSelection) {
      const box = row.querySelector(".desk-check[data-select]");
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      selection.toggle(Number(box.dataset.select));
      paintSelection();
    }
  };
  host.addEventListener("keydown", onKey, true);
  const onDocked = () => {
    const d = docked();
    if (d === lastDocked) return;
    lastDocked = d;
    renderHead();
    opts.onRepaint?.();
  };
  window.addEventListener("docked-change", onDocked);
  const media = window.matchMedia?.("(min-width: 1024px)");
  const onMedia = () => {
    renderHead();
    opts.onRepaint?.();
  };
  media?.addEventListener?.("change", onMedia);
  applyDensity();

  return {
    cols,
    selection,
    renderHead,
    paintSort,
    cellsHtml,
    checkHtml,
    renderFoot,
    paintSelection,
    exportCsv,
    visibleColumns,
    docked,
    selectedRows: () => rows().filter((r) => selection.isOn(idOf(r))),
    destroy() {
      host.removeEventListener("click", onClick, true);
      host.removeEventListener("keydown", onKey, true);
      window.removeEventListener("docked-change", onDocked);
      media?.removeEventListener?.("change", onMedia);
    },
  };
}

const dockedKeyNow = () => document.body.dataset.docked || "";

/* ---------- Visible filter bar (desktop): labelled buttons, a chip per chosen value, Clear ----------
   groups: [{ key, label, count?, active?, onClick(buttonEl) }]; chips: [{ label, onRemove }] */
export function renderDeskFilters(barEl, { groups, chips = [], onClear }) {
  if (!barEl) return;
  if (!isDesktop()) {
    barEl.innerHTML = "";
    return;
  }
  barEl.innerHTML =
    groups
      .map(
        (g) =>
          `<button type="button" class="desk-filter-btn${g.active || g.count ? " desk-filter-btn-on" : ""}" data-desk-filter="${g.key}">${escapeHtml(g.label)}${
            g.count ? `<span class="desk-filter-count">${g.count}</span>` : ""
          }<span class="desk-filter-caret" aria-hidden="true">▾</span></button>`
      )
      .join("") +
    (chips.length
      ? `<span class="desk-chips">${chips
          .map((c, i) => `<span class="desk-chip">${escapeHtml(c.label)}<button type="button" class="desk-chip-x" data-chip="${i}" aria-label="${escapeHtml(t("remove"))}">×</button></span>`)
          .join("")}<button type="button" class="desk-filters-clear" data-desk-clear>${escapeHtml(t("clear"))}</button></span>`
      : "");
  barEl.querySelectorAll("[data-desk-filter]").forEach((b) => b.addEventListener("click", () => groups.find((g) => g.key === b.dataset.deskFilter)?.onClick(b)));
  barEl.querySelectorAll("[data-chip]").forEach((x) => x.addEventListener("click", () => chips[Number(x.dataset.chip)]?.onRemove()));
  barEl.querySelector("[data-desk-clear]")?.addEventListener("click", () => onClear?.());
}

// A single-choice menu under a filter button: options [{ value, label }]; onPick(value).
export function openDeskMenu(anchor, options, current, onPick) {
  document.querySelector(".desk-col-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "desk-col-menu desk-pick-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = options
    .map(
      (o) =>
        `<button type="button" role="menuitemradio" class="desk-col-menu-item${String(o.value) === String(current) ? " desk-menu-on" : ""}" aria-checked="${String(o.value) === String(current)}" data-value="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</button>`
    )
    .join("");
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, Math.round(rect.left))}px`;
  document.body.appendChild(menu);
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    }
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKeyDown, true);
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-value]");
    if (!b) return;
    close();
    onPick(b.dataset.value);
  });
  menu.querySelector(".desk-menu-on, button")?.focus();
  return close;
}

// Desktop roadmap step 9: a native <select> shown as the tables' dropdown chip ("Kind: Payment slip ▾") on a computer; the select stays in
// the page (hidden) so the view's own code keeps reading .value and listening to "change". Phones keep the native select. Returns
// refresh() for when the view changes the options or the value by code.
export function deskSelectChip(select, label = select?.getAttribute("aria-label") || "", { field = false } = {}) {
  if (!select || !isDesktop() || select.dataset.deskChip === "1") return () => {};
  select.dataset.deskChip = "1";
  select.classList.add("desk-select-hidden");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `desk-filter-btn desk-select-chip${field ? " desk-select-field" : ""}`;
  btn.setAttribute("aria-haspopup", "menu");
  select.insertAdjacentElement("afterend", btn);
  const refresh = () => {
    const opt = select.selectedOptions[0];
    const first = select.options[0];
    const isDefault = !opt || opt === first;
    if (!field) btn.classList.toggle("desk-filter-btn-on", !isDefault); // a form field is not a filter: no "active" colour
    btn.innerHTML = `${escapeHtml(isDefault || field ? (opt ?? first)?.textContent || label : `${label ? `${label}: ` : ""}${opt.textContent}`)}<span class="desk-filter-caret" aria-hidden="true">▾</span>`;
    btn.disabled = select.disabled;
  };
  btn.addEventListener("click", () =>
    openDeskMenu(btn, [...select.options].map((o) => ({ value: o.value, label: o.textContent })), select.value, (value) => {
      if (value === select.value) return;
      select.value = value;
      refresh();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })
  );
  select.addEventListener("change", refresh);
  refresh();
  return refresh;
}

// A dropdown menu (column picker, filter menu, select chip) lives on <body>: leaving the page must close it, or it floats over the next one.
if (typeof window !== "undefined" && !window.__deskMenuRouteClose) {
  window.__deskMenuRouteClose = true;
  window.addEventListener("hashchange", () => document.querySelectorAll(".desk-col-menu").forEach((m) => m.remove()));
}

// Every single-choice <select> inside a form / sheet as a dropdown chip (desktop only). The chip sits where the select was, so the form's
// label stays above it and FormData still reads the hidden select.
export function deskSelectChips(root) {
  if (!root || !isDesktop()) return;
  root.querySelectorAll("select:not([multiple])").forEach((s) => deskSelectChip(s, "", { field: true }));
}
