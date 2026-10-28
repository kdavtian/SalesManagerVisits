// The shared pieces of every list screen's search bar: the clear "x", the inline "x" of a plain search box, the check mark
// of a chosen menu option, the open / active state of a filter button. Each screen builds its own bar with these right after
// it renders (docs/architecture-roadmap.md, step 7a; they used to be added by page-wide observers).
import { FILTER_ICONS } from "./filterIcons.js";
import { getLang } from "./i18n.js";

// One visual language for every search/filter surface. These are the exact
// 24px / 1.9px-stroke forms used by Activity, so moving between tabs does
// not feel like moving between different apps.
export const SEARCH_ICONS = {
  ...FILTER_ICONS,
  clear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  orderAdd: `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="15" height="19" rx="3"/><path d="M9 9h7M9 13h5M9 17h4"/><circle cx="20.5" cy="19.5" r="5" fill="var(--accent)" stroke="var(--bg-card)" stroke-width="2"/><path d="M20.5 17v5M18 19.5h5" stroke="white" stroke-width="1.8"/></svg>`,
};

// Writes that change nothing still queue a mutation record (classList.add of a class already there, innerHTML with the same
// markup), and the observers at the bottom of this file watch the whole page: a no-op write here re-ran every enhancer on the
// next frame, forever (60 re-runs a second on Orders, Customers and Products even when idle -- battery and jank). So every write
// below is guarded: add classes only when missing, rebuild a button only when what it should show changed.
export function addClasses(el, ...names) {
  for (const n of names) if (!el.classList.contains(n)) el.classList.add(n);
}

export function setClass(el, name, on) {
  if (el.classList.contains(name) !== Boolean(on)) el.classList.toggle(name, Boolean(on));
}

export function clearLabel() {
  return getLang() === "hy" ? "Մաքրել որոնումը" : "Clear search";
}

export function installClearButton(input, container, actions) {
  if (!input || !container || container.querySelector(`[data-search-clear-for="${input.id}"]`)) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "unified-search-clear";
  button.dataset.searchClearFor = input.id;
  button.setAttribute("aria-label", clearLabel());
  button.setAttribute("title", clearLabel());
  button.innerHTML = SEARCH_ICONS.clear;
  container.insertBefore(button, actions || null);

  const sync = () => {
    button.hidden = input.value.length === 0;
  };
  input.addEventListener("input", sync);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!input.value) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
    sync();
  });
  sync();
}

// Every remaining bare <input type="search"> in the app -- Pricelist,
// Order creation's product search, Warehouse Inventory, Payments, Cash
// Expenses, and every "pick a customer/product" sheet -- gets the same
// tap-to-clear X Activity/Orders/Customers/Map already have. Those four
// screens merge the X into a shared multi-icon toolbar pill
// (installClearButton above); most of these don't have one, so this
// inlines the X into the search input's own box instead via a thin
// wrapper, which works the same regardless of whether the input's actual
// parent is a flex row (list-toolbar, inventory-search-row, ...) or a
// plain block stack (a sheet's own vertical layout).
export function installInlineClearButton(input) {
  if (!input || input.dataset.inlineClearInstalled) return;
  input.dataset.inlineClearInstalled = "true";
  const wrap = document.createElement("div");
  wrap.className = "search-input-clear-wrap";
  input.replaceWith(wrap);
  wrap.appendChild(input);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "unified-search-clear";
  button.setAttribute("aria-label", clearLabel());
  button.setAttribute("title", clearLabel());
  button.innerHTML = SEARCH_ICONS.clear;
  wrap.appendChild(button);

  const sync = () => {
    button.hidden = input.value.length === 0;
  };
  input.addEventListener("input", sync);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!input.value) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
    sync();
  });
  sync();
}

export function ensureSelectedCheck(menu, selector) {
  if (!menu) return;
  menu.querySelectorAll(selector).forEach((option) => {
    const selected = option.getAttribute("aria-checked") === "true" || option.classList.contains("chip-active");
    option.classList.toggle("filter-dropdown-selected", selected);
    let check = option.querySelector(".activity-menu-check");
    if (selected && !check) {
      check = document.createElement("span");
      check.className = "activity-menu-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      option.appendChild(check);
    } else if (!selected && check) {
      check.remove();
    }
  });
}

export function syncDropdownButton(button, menu, applied) {
  if (!button) return;
  const open = button.getAttribute("aria-expanded") === "true" || !menu?.hidden;
  button.classList.toggle("activity-search-filter-btn-open", open);
  button.classList.toggle("activity-search-filter-btn-active", Boolean(applied));
  let dot = button.querySelector(".activity-search-filter-dot");
  if (applied && !dot) {
    dot = document.createElement("span");
    dot.className = "activity-search-filter-dot";
    dot.setAttribute("aria-hidden", "true");
    button.appendChild(dot);
  } else if (!applied && dot) {
    dot.remove();
  }
}
