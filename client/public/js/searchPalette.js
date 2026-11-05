// The search sheet (owner, 2026-11-04: "one search for everything"): the Search button of the phone's top bar opens it. One box finds
// screens ("Cash", "Debts"), actions ("New order") and records (customers, orders, open tasks); before anything is typed it shows what was
// opened recently. Screens can be pinned from here. On a computer the same search lives in the top bar (deskTopBar.js, Ctrl K or /).
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml, formatAmd, formatDateDMY, activateDialog } from "./util.js";
import { localResults, recent, recordResults, suggestions } from "./searchSources.js";
import { bindPinButtons, pinButtonHtml } from "./pins.js";
import { pinnableIds } from "./screenCatalog.js";

let openOverlay = null;

export function openSearch({ navigate, settings }) {
  if (openOverlay?.isConnected) {
    openOverlay.querySelector("input")?.focus();
    return openOverlay;
  }
  const pinnable = new Set(pinnableIds(settings));
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay search-overlay";
  overlay.innerHTML = `
    <div class="sheet search-sheet" role="dialog" aria-label="${escapeHtml(t("search_title"))}">
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="search-sheet-bar">
        <div class="search-sheet-field">
          <span class="search-sheet-icon" aria-hidden="true">${icons.search}</span>
          <input type="search" id="search-sheet-input" class="search-sheet-input" autocomplete="off" enterkeyhint="go"
            placeholder="${escapeHtml(t("search_placeholder_all"))}" aria-label="${escapeHtml(t("search_placeholder_all"))}" aria-controls="search-sheet-results" />
          <button type="button" class="search-sheet-clear" aria-label="${escapeHtml(t("clear_search"))}" hidden>${icons.close}</button>
        </div>
        <button type="button" class="btn btn-ghost search-sheet-cancel" data-action="close">${escapeHtml(t("cancel"))}</button>
      </div>
      <div class="search-sheet-results" id="search-sheet-results" role="listbox"></div>
    </div>`;
  document.body.appendChild(overlay);
  openOverlay = overlay;
  activateDialog(overlay);
  const input = overlay.querySelector("input");
  const clear = overlay.querySelector(".search-sheet-clear");
  const box = overlay.querySelector(".search-sheet-results");
  let items = [];
  let active = 0;
  let seq = 0;
  let timer = 0;

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector('[data-action="close"]').addEventListener("click", close);
  bindPinButtons(box);

  const open = (i) => {
    const item = items[i];
    if (!item) return;
    if (item.hash) recent.add({ kind: item.kind, id: item.id, label: item.label, hint: item.hint, hash: item.hash });
    close();
    // the sheet's own Back step is given back first (sheetNav.js), then the screen opens
    if (item.run) item.run(navigate);
    else if (item.hash) navigate(item.hash);
  };

  const rowHtml = (item) => {
    const i = items.push(item) - 1;
    const pin = item.kind === "screen" && pinnable.has(item.id) ? pinButtonHtml(item.id) : "";
    return `<div class="search-row${i === active ? " is-active" : ""}" data-row="${i}">
      <button type="button" class="search-row-main" role="option" data-result="${i}" aria-selected="${i === active}">
        <span class="search-row-icon ${item.colorClass ? `quick-action-icon ${item.colorClass}` : ""}">${item.icon || icons.search}</span>
        <span class="search-row-text"><span class="search-row-label">${escapeHtml(item.label)}</span>${item.hint ? `<span class="search-row-hint">${escapeHtml(item.hint)}</span>` : ""}</span>
        ${item.trailing ? `<span class="search-row-trailing">${escapeHtml(item.trailing)}</span>` : ""}
      </button>${pin}
    </div>`;
  };
  const group = (title, list) => (list.length ? `<div class="search-group"><div class="search-group-title">${escapeHtml(title)}</div>${list.map(rowHtml).join("")}</div>` : "");

  function paintStatic(query) {
    items = [];
    active = query ? 0 : -1; // an empty box is a menu: Enter does nothing until a row is chosen with the arrows
    if (!query) {
      const recents = recent.all();
      const { actions, screens } = suggestions(settings);
      // an empty box is a menu: what was opened last, the quick actions, then the pinned / main screens, and a line saying what can be typed
      box.innerHTML =
        group(t("search_recent"), recents.map((r) => ({ ...r, icon: icons.history }))) +
        group(t("search_actions"), actions) +
        group(t("search_screens"), screens) +
        `<p class="search-note">${escapeHtml(t("search_hint_all"))}</p>`;
      return;
    }
    const local = localResults(query, settings);
    box.innerHTML =
      group(t("search_screens"), local.filter((x) => x.kind === "screen")) +
      group(t("search_actions"), local.filter((x) => x.kind === "action")) +
      (query.length >= 2 ? `<div class="search-records" aria-live="polite"><p class="search-note">${escapeHtml(t("loading"))}</p></div>` : "");
    if (!local.length && query.length < 2) box.innerHTML = `<p class="search-note">${escapeHtml(t("desk_search_none"))}</p>`;
  }

  async function paintRecords(query) {
    const mine = ++seq;
    const { customers, orders, tasks, products } = await recordResults(query);
    if (mine !== seq || !overlay.isConnected || input.value.trim() !== query) return;
    const slot = box.querySelector(".search-records");
    if (!slot) return;
    const html =
      group(
        t("nav_customers"),
        customers.map((c) => ({ kind: "record", id: `c${c.id}`, label: c.name, hint: [c.erp_customer_id ? `ID ${c.erp_customer_id}` : "", c.assigned_manager_name || ""].filter(Boolean).join(" · "), icon: icons.customers, hash: `#/customers/${c.id}` }))
      ) +
      group(
        t("nav_orders"),
        orders.map((o) => ({ kind: "record", id: `o${o.id}`, label: o.order_code || `#${o.id}`, hint: [o.customer_name, formatDateDMY(o.created_at)].filter(Boolean).join(" · "), trailing: formatAmd(Number(o.total_amd)), icon: icons.cart, hash: `#/orders?open=${o.id}` }))
      ) +
      group(
        t("qa_pricelist"),
        products.map((p) => ({ kind: "record", id: `p${p.id}`, label: p.name, hint: [p.brand, p.unit].filter(Boolean).join(" · "), icon: icons.box, hash: `#/product/${p.id}` }))
      ) +
      group(
        t("qa_tasks"),
        tasks.map((r) => ({ kind: "record", id: `t${r.id}`, label: r.title, hint: [r.customer_name, r.assignee_name].filter(Boolean).join(" · "), trailing: formatDateDMY(r.due_date), icon: icons.tasks, hash: `#/tasks?open=${r.id}` }))
      );
    slot.outerHTML = html || (items.length ? "" : `<p class="search-note">${escapeHtml(t("desk_search_none"))}</p>`);
  }

  const paintActive = () => {
    box.querySelectorAll("[data-row]").forEach((el) => {
      const on = Number(el.dataset.row) === active;
      el.classList.toggle("is-active", on);
      el.querySelector("[data-result]")?.setAttribute("aria-selected", String(on));
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  };

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clear.hidden = !input.value;
    clearTimeout(timer);
    seq++;
    paintStatic(query);
    if (query.length >= 2) timer = setTimeout(() => paintRecords(query), 220);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      active = active < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paintActive();
    } else if (e.key === "Enter" && items.length && active >= 0) {
      e.preventDefault();
      open(active);
    }
  });
  box.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-result]");
    if (btn) open(Number(btn.dataset.result));
  });
  paintStatic("");
  requestAnimationFrame(() => input.focus());
  return overlay;
}
