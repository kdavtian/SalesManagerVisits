// Column heading row of a desktop table (Orders, Customers). Hidden on a phone (desktop.css); on a desktop window each
// heading with a `key` is a sort button: click sorts, a second click reverses (arrow down = the natural direction).
import { escapeHtml } from "./util.js";
import { t } from "./i18n.js";

// cells: one entry per grid cell after the icon column -- { align?: "end", items: [{ label, key? }] }
export function deskHeadHtml(extraClass, cells) {
  return `<div class="desk-thead ${extraClass}" role="presentation">
    <span></span>
    ${cells
      .map(
        (cell) => `<div class="desk-th${cell.align === "end" ? " desk-th-end" : ""}">${cell.items
          .map((i) =>
            i.key
              ? `<button type="button" class="desk-sort" data-sort-key="${i.key}" title="${escapeHtml(t("desk_col_sort_hint"))}">${escapeHtml(i.label)}<span class="desk-sort-arrow" aria-hidden="true"></span></button>`
              : `<span class="desk-th-label">${escapeHtml(i.label)}</span>`
          )
          .join("")}</div>`
      )
      .join("")}
    <span></span>
  </div>`;
}

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
