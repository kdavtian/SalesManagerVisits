import { getLang } from "./i18n.js";

const CALENDAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M7.5 3v4M16.5 3v4M3.5 9h17"/></svg>`;

let activeInput = null;
let draftDate = null;
let visibleMonth = null;
let overlay = null;

function isArmenian() {
  return getLang() === "hy";
}

function text() {
  return isArmenian()
    ? {
        choose: "Ընտրել",
        start: "Սկիզբ",
        end: "Ավարտ",
        reset: "Վերակայել",
        today: "Այսօր",
        done: "Պատրաստ",
        previousMonth: "Նախորդ ամիս",
        nextMonth: "Հաջորդ ամիս",
        weekdays: ["Երկ", "Երք", "Չրք", "Հնգ", "Ուրբ", "Շբթ", "Կիր"],
      }
    : {
        choose: "Select",
        start: "Start date",
        end: "End date",
        reset: "Reset",
        today: "Today",
        done: "Done",
        previousMonth: "Previous month",
        nextMonth: "Next month",
        weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      };
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

function sameDay(a, b) {
  return Boolean(a && b)
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatFieldDate(value) {
  const date = localDateFromIso(value);
  if (!date) return text().choose;
  return new Intl.DateTimeFormat(isArmenian() ? "hy-AM" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatMonth(date) {
  return new Intl.DateTimeFormat(isArmenian() ? "hy-AM" : "en-US", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function updateFieldButton(input) {
  const button = input.parentElement?.querySelector(`.activity-date-field[data-for="${input.id}"]`);
  if (!button) return;
  const value = button.querySelector(".activity-date-field-value");
  if (value) {
    value.textContent = formatFieldDate(input.value);
    value.classList.toggle("activity-date-field-placeholder", !input.value);
  }
  button.classList.toggle("activity-date-field-filled", Boolean(input.value));
}

function enhanceInput(input) {
  if (!(input instanceof HTMLInputElement) || input.dataset.customDateEnhanced === "1") return;
  if (!input.closest(".activity-custom-range")) return;

  input.dataset.customDateEnhanced = "1";
  input.classList.add("activity-native-date-input");
  const label = input.closest("label");
  if (!label) return;
  label.classList.add("activity-date-label");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "activity-date-field";
  button.dataset.for = input.id;
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `
    <span class="activity-date-field-value ${input.value ? "" : "activity-date-field-placeholder"}">${formatFieldDate(input.value)}</span>
    <span class="activity-date-field-icon">${CALENDAR_ICON}</span>
  `;
  label.insertBefore(button, input);
  button.classList.toggle("activity-date-field-filled", Boolean(input.value));
  button.addEventListener("click", () => openPicker(input));
}

function enhanceVisibleActivityDates() {
  document.querySelectorAll('.activity-custom-range input[type="date"]').forEach(enhanceInput);
}

function getDaysForMonth(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = [];

  for (let i = mondayOffset; i > 0; i -= 1) {
    cells.push({ date: new Date(year, month, 1 - i), outside: true });
  }
  for (let day = 1; day <= last.getDate(); day += 1) {
    cells.push({ date: new Date(year, month, day), outside: false });
  }
  while (cells.length % 7 !== 0) {
    const day = cells.length - mondayOffset - last.getDate() + 1;
    cells.push({ date: new Date(year, month + 1, day), outside: true });
  }
  return cells;
}

function renderPicker() {
  if (!overlay || !activeInput) return;
  const copy = text();
  const today = new Date();
  const month = visibleMonth || draftDate || today;
  const selectedIso = isoFromLocalDate(draftDate);
  const targetLabel = activeInput.id === "custom-from" ? copy.start : copy.end;
  const cells = getDaysForMonth(month);

  overlay.innerHTML = `
    <div class="activity-date-picker-backdrop" data-date-dismiss></div>
    <section class="activity-date-picker" role="dialog" aria-modal="true" aria-label="${targetLabel}">
      <div class="activity-date-picker-grabber" aria-hidden="true"></div>
      <div class="activity-date-picker-topline">
        <div>
          <div class="activity-date-picker-target">${targetLabel}</div>
          <div class="activity-date-picker-selected">${draftDate ? formatFieldDate(selectedIso) : copy.choose}</div>
        </div>
        <button type="button" class="activity-date-picker-close" data-date-dismiss aria-label="Close">×</button>
      </div>
      <div class="activity-date-picker-monthbar">
        <button type="button" class="activity-date-nav" data-date-prev aria-label="${copy.previousMonth}">‹</button>
        <strong>${formatMonth(month)}</strong>
        <button type="button" class="activity-date-nav" data-date-next aria-label="${copy.nextMonth}">›</button>
      </div>
      <div class="activity-date-weekdays" aria-hidden="true">
        ${copy.weekdays.map((day) => `<span>${day}</span>`).join("")}
      </div>
      <div class="activity-date-grid">
        ${cells.map(({ date, outside }) => {
          const iso = isoFromLocalDate(date);
          const isSelected = selectedIso === iso;
          const isToday = sameDay(date, today);
          return `<button type="button" class="activity-date-day ${outside ? "activity-date-day-outside" : ""} ${isSelected ? "activity-date-day-selected" : ""} ${isToday ? "activity-date-day-today" : ""}" data-date-value="${iso}" aria-pressed="${isSelected}">${date.getDate()}</button>`;
        }).join("")}
      </div>
      <div class="activity-date-picker-actions">
        <button type="button" class="activity-date-action activity-date-reset" data-date-reset>${copy.reset}</button>
        <button type="button" class="activity-date-action activity-date-today" data-date-today>${copy.today}</button>
        <button type="button" class="activity-date-action activity-date-done" data-date-done>${copy.done}</button>
      </div>
    </section>
  `;

  overlay.querySelectorAll("[data-date-dismiss]").forEach((el) => el.addEventListener("click", closePicker));
  overlay.querySelector("[data-date-prev]")?.addEventListener("click", () => {
    visibleMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    renderPicker();
  });
  overlay.querySelector("[data-date-next]")?.addEventListener("click", () => {
    visibleMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    renderPicker();
  });
  overlay.querySelectorAll("[data-date-value]").forEach((button) => {
    button.addEventListener("click", () => {
      draftDate = localDateFromIso(button.dataset.dateValue);
      visibleMonth = new Date(draftDate.getFullYear(), draftDate.getMonth(), 1);
      renderPicker();
    });
  });
  overlay.querySelector("[data-date-reset]")?.addEventListener("click", () => {
    draftDate = null;
    visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderPicker();
  });
  overlay.querySelector("[data-date-today]")?.addEventListener("click", () => {
    draftDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderPicker();
  });
  overlay.querySelector("[data-date-done]")?.addEventListener("click", commitPicker);
}

function openPicker(input) {
  activeInput = input;
  draftDate = localDateFromIso(input.value) || new Date();
  visibleMonth = new Date(draftDate.getFullYear(), draftDate.getMonth(), 1);
  overlay = document.createElement("div");
  overlay.className = "activity-date-picker-overlay";
  document.body.appendChild(overlay);
  document.documentElement.classList.add("activity-date-picker-open");
  renderPicker();
  requestAnimationFrame(() => overlay?.querySelector("[data-date-done]")?.focus());
}

function closePicker() {
  overlay?.remove();
  overlay = null;
  activeInput = null;
  draftDate = null;
  visibleMonth = null;
  document.documentElement.classList.remove("activity-date-picker-open");
}

function commitPicker() {
  if (!activeInput) return;
  const value = isoFromLocalDate(draftDate);
  const currentInput = activeInput;
  const counterpartId = currentInput.id === "custom-from" ? "custom-to" : "custom-from";
  const counterpart = document.getElementById(counterpartId);

  currentInput.value = value;

  // Keep the range valid without forcing the user through an error state.
  // If a chosen boundary crosses the other boundary, move the other side to
  // the same day; the existing Activity change handler then performs one load.
  if (value && counterpart?.value) {
    if (currentInput.id === "custom-from" && value > counterpart.value) counterpart.value = value;
    if (currentInput.id === "custom-to" && value < counterpart.value) counterpart.value = value;
    updateFieldButton(counterpart);
  }

  updateFieldButton(currentInput);
  closePicker();
  currentInput.dispatchEvent(new Event("change", { bubbles: true }));
}

const observer = new MutationObserver(() => enhanceVisibleActivityDates());
observer.observe(document.documentElement, { childList: true, subtree: true });
enhanceVisibleActivityDates();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && overlay) closePicker();
});
