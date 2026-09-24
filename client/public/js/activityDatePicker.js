import { getLang } from "./i18n.js";

const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M7.5 3v4M16.5 3v4M3.5 9h17"/></svg>`;

// Must match the wheel item row height in activity-date-picker.css --
// scroll position <-> selected index math below depends on this exact value.
const ITEM_HEIGHT = 44;
const YEAR_MIN_OFFSET = -10;
const YEAR_MAX_OFFSET = 2;

let activeInput = null;
let draftYear = null;
let draftMonth = null; // 1-based
let draftDay = null; // 1-based
let overlay = null;

function isArmenian() {
  return getLang() === "hy";
}

function text() {
  return isArmenian()
    ? { start: "Սկիզբ", end: "Ավարտ", reset: "Մաքրել", today: "Այսօր", done: "Պատրաստ", select: "Ընտրել" }
    : { start: "Start date", end: "End date", reset: "Clear", today: "Today", done: "Done", select: "Select" };
}

function localDateFromIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoFromLocalDate(date) {
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Structural "from"/"to" check (DOM order within the shared range
// container) instead of hardcoded ids -- this module enhances any
// .activity-custom-range date pair, not just Activity's own "custom-from"/
// "custom-to" (e.g. Sales' from/to reuses it too), and a fixed id pair
// would only ever match one of them.
function isFromInput(input) {
  const counterpart = [...(input.closest(".activity-custom-range")?.querySelectorAll('input[type="date"]') ?? [])].find(
    (el) => el !== input
  );
  return Boolean(counterpart && input.compareDocumentPosition(counterpart) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthShortNames() {
  const fmt = new Intl.DateTimeFormat(isArmenian() ? "hy-AM" : "en-US", { month: "short" });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2020, i, 1)));
}

function yearsRange() {
  const current = new Date().getFullYear();
  const years = [];
  for (let y = current + YEAR_MIN_OFFSET; y <= current + YEAR_MAX_OFFSET; y++) years.push(y);
  return years;
}

function formatFieldDate(value) {
  const date = localDateFromIso(value);
  if (!date) return "";
  return new Intl.DateTimeFormat(isArmenian() ? "hy-AM" : "en-US", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function updateFieldButton(input) {
  const button = input.parentElement?.querySelector(`.activity-date-field[data-for="${input.id}"]`);
  if (!button) return;
  const label = button.querySelector(".activity-date-field-label");
  const value = button.querySelector(".activity-date-field-value");
  if (value) {
    value.textContent = formatFieldDate(input.value) || text().select;
    value.classList.toggle("activity-date-field-placeholder", !input.value);
  }
  if (label) label.textContent = isFromInput(input) ? text().start : text().end;
  button.classList.toggle("activity-date-field-filled", Boolean(input.value));
}

// The "From"/"To" caption now lives INSIDE the button itself (stacked above
// the date value), not as separate label text floating above/outside it --
// the <label> wrapper stays only for click-target/accessibility association.
function enhanceInput(input) {
  if (!(input instanceof HTMLInputElement) || input.dataset.customDateEnhanced === "1") return;
  if (!input.closest(".activity-custom-range")) return;

  input.dataset.customDateEnhanced = "1";
  input.classList.add("activity-native-date-input");
  const label = input.closest("label");
  if (!label) return;
  label.classList.add("activity-date-label");
  // The label's own text node ("From"/"To" from the view's markup) is
  // redundant now that the button shows its own caption -- clear it rather
  // than leaving it to show twice.
  for (const node of [...label.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) node.remove();
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "activity-date-field";
  button.dataset.for = input.id;
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `
    <span class="activity-date-field-text">
      <span class="activity-date-field-label">${isFromInput(input) ? text().start : text().end}</span>
      <span class="activity-date-field-value ${input.value ? "" : "activity-date-field-placeholder"}">${formatFieldDate(input.value) || text().select}</span>
    </span>
    <span class="activity-date-field-icon">${CALENDAR_ICON}</span>
  `;
  label.insertBefore(button, input);
  button.classList.toggle("activity-date-field-filled", Boolean(input.value));
  button.addEventListener("click", () => openPicker(input));
}

function enhanceVisibleActivityDates() {
  document.querySelectorAll('.activity-custom-range input[type="date"]').forEach(enhanceInput);
}

// --- Wheel picker -----------------------------------------------------

function clampedDay() {
  return Math.min(draftDay, daysInMonth(draftYear, draftMonth));
}

function draftIso() {
  return isoFromLocalDate(new Date(draftYear, draftMonth - 1, clampedDay()));
}

function columnItems(col) {
  if (col === "day") return Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
  if (col === "month") return monthShortNames().map((label, i) => ({ value: i + 1, label }));
  return yearsRange().map((y) => ({ value: y, label: String(y) }));
}

function selectedIndexFor(col) {
  const items = columnItems(col);
  const value = col === "day" ? draftDay : col === "month" ? draftMonth : draftYear;
  const idx = items.findIndex((item) => item.value === value);
  return idx === -1 ? 0 : idx;
}

function columnHtml(col) {
  const items = columnItems(col);
  const selectedIdx = selectedIndexFor(col);
  return `
    <div class="wheel-col" data-col="${col}">
      <div class="wheel-col-list" data-col-list="${col}" tabindex="0" role="listbox" aria-label="${col}">
        ${items
          .map(
            (item, i) => `<div class="wheel-item ${i === selectedIdx ? "wheel-item-selected" : ""}" data-index="${i}" data-value="${item.value}" role="option" aria-selected="${i === selectedIdx}">${escapeText(item.label)}</div>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function applyDimming(listEl, selectedIdx) {
  listEl.querySelectorAll(".wheel-item").forEach((el, i) => {
    const dist = Math.abs(i - selectedIdx);
    const opacity = dist === 0 ? 1 : dist === 1 ? 0.55 : dist === 2 ? 0.28 : 0.14;
    el.style.opacity = String(opacity);
    el.classList.toggle("wheel-item-selected", dist === 0);
    el.setAttribute("aria-selected", String(dist === 0));
  });
}

function scrollListTo(col, idx, animate) {
  const listEl = overlay?.querySelector(`[data-col-list="${col}"]`);
  if (!listEl) return;
  listEl.scrollTo({ top: idx * ITEM_HEIGHT, behavior: animate ? "smooth" : "instant" });
  applyDimming(listEl, idx);
}

function updateSelectedSummary() {
  const summaryEl = overlay?.querySelector(".activity-date-picker-selected");
  if (summaryEl) summaryEl.textContent = formatFieldDate(draftIso());
}

function wireColumn(col) {
  const listEl = overlay?.querySelector(`[data-col-list="${col}"]`);
  if (!listEl) return;
  const initialIdx = selectedIndexFor(col);
  listEl.scrollTop = initialIdx * ITEM_HEIGHT;
  applyDimming(listEl, initialIdx);

  let raf = null;
  let settleTimer = null;
  listEl.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const items = columnItems(col);
      const idx = Math.min(items.length - 1, Math.max(0, Math.round(listEl.scrollTop / ITEM_HEIGHT)));
      applyDimming(listEl, idx);
      const value = items[idx].value;
      if (col === "day") draftDay = value;
      else if (col === "month") draftMonth = value;
      else draftYear = value;
      updateSelectedSummary();
      // Snap fully to the resting index once scrolling has settled --
      // scroll-snap on most browsers already does this on release, but a
      // fast flick can leave the native snap resolving to a neighboring
      // cell after our own index math already read the pre-snap position.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        listEl.scrollTo({ top: idx * ITEM_HEIGHT, behavior: "instant" });
      }, 120);
    });
  });

  listEl.querySelectorAll(".wheel-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.index);
      listEl.scrollTo({ top: idx * ITEM_HEIGHT, behavior: "smooth" });
    });
  });
}

function renderPicker() {
  if (!overlay || !activeInput) return;
  const copy = text();
  const targetLabel = isFromInput(activeInput) ? copy.start : copy.end;

  overlay.innerHTML = `
    <div class="activity-date-picker-backdrop" data-date-dismiss></div>
    <section class="activity-date-picker wheel-date-picker" role="dialog" aria-modal="true" aria-label="${targetLabel}">
      <div class="activity-date-picker-grabber" aria-hidden="true"></div>
      <div class="activity-date-picker-topline">
        <div>
          <div class="activity-date-picker-target">${targetLabel}</div>
          <div class="activity-date-picker-selected">${formatFieldDate(draftIso())}</div>
        </div>
        <button type="button" class="activity-date-picker-close" data-date-dismiss aria-label="Close">×</button>
      </div>
      <div class="wheel-picker-wrap">
        <div class="wheel-selection-band" aria-hidden="true"></div>
        ${columnHtml("day")}
        ${columnHtml("month")}
        ${columnHtml("year")}
      </div>
      <div class="activity-date-picker-actions">
        <button type="button" class="activity-date-action activity-date-reset" data-date-reset>${copy.reset}</button>
        <button type="button" class="activity-date-action activity-date-today" data-date-today>${copy.today}</button>
        <button type="button" class="activity-date-action activity-date-done" data-date-done>${copy.done}</button>
      </div>
    </section>
  `;

  wireColumn("day");
  wireColumn("month");
  wireColumn("year");

  overlay.querySelectorAll("[data-date-dismiss]").forEach((el) => el.addEventListener("click", closePicker));
  overlay.querySelector("[data-date-today]")?.addEventListener("click", () => {
    const today = new Date();
    draftYear = today.getFullYear();
    draftMonth = today.getMonth() + 1;
    draftDay = today.getDate();
    scrollListTo("day", selectedIndexFor("day"), true);
    scrollListTo("month", selectedIndexFor("month"), true);
    scrollListTo("year", selectedIndexFor("year"), true);
    updateSelectedSummary();
  });
  overlay.querySelector("[data-date-reset]")?.addEventListener("click", () => {
    if (!activeInput) return;
    const input = activeInput;
    input.value = "";
    updateFieldButton(input);
    closePicker();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  overlay.querySelector("[data-date-done]")?.addEventListener("click", commitPicker);
}

function openPicker(input) {
  activeInput = input;
  const initial = localDateFromIso(input.value) || new Date();
  draftYear = initial.getFullYear();
  draftMonth = initial.getMonth() + 1;
  draftDay = initial.getDate();
  overlay = document.createElement("div");
  overlay.className = "activity-date-picker-overlay";
  document.body.appendChild(overlay);
  document.documentElement.classList.add("activity-date-picker-open");
  renderPicker();
}

function closePicker() {
  overlay?.remove();
  overlay = null;
  activeInput = null;
  draftYear = null;
  draftMonth = null;
  draftDay = null;
}

function commitPicker() {
  if (!activeInput) return;
  const value = draftIso();
  const currentInput = activeInput;
  const counterpart = [...currentInput.closest(".activity-custom-range").querySelectorAll('input[type="date"]')].find(
    (el) => el !== currentInput
  );
  const isFrom = isFromInput(currentInput);

  currentInput.value = value;

  // Keep the range valid without forcing the user through an error state.
  // If a chosen boundary crosses the other boundary, move the other side to
  // the same day; the existing change handler then performs one load.
  if (value && counterpart?.value) {
    if (isFrom && value > counterpart.value) counterpart.value = value;
    if (!isFrom && value < counterpart.value) counterpart.value = value;
    updateFieldButton(counterpart);
  }

  updateFieldButton(currentInput);
  closePicker();
  currentInput.dispatchEvent(new Event("change", { bubbles: true }));
}

// Coalesced to one rAF-deferred pass per frame instead of running
// enhanceVisibleActivityDates() synchronously for every mutation batch --
// this observer watches the whole document, so any view's re-render
// (search debounce settling, a list repainting) triggered it repeatedly
// even though only views with a .activity-custom-range ever match.
let scheduled = false;
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    enhanceVisibleActivityDates();
  });
});
observer.observe(document.documentElement, { childList: true, subtree: true });
enhanceVisibleActivityDates();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && overlay) closePicker();
});
