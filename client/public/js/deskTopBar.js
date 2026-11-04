// The desktop top bar (docs/desktop-roadmap.md, step 4): a global search (customers, orders, tasks) and quick actions
// (New order, New task, New customer), with keyboard shortcuts -- "/" focuses the search, "n" then "o" / "t" / "c" start a new
// order / task / customer. All of it is hidden on a phone (desktop.css) and the keys only work on a desktop window.
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml, formatAmd, formatDateDMY } from "./util.js";
import { canCreateTasks } from "./state.js";
import { isDesktop } from "./deskTable.js";
import { MAX_PER_GROUP, localResults, recent, recordResults } from "./searchSources.js";
import { state } from "./state.js";

let navigateRef = null;
let settingsRef = null; // () => the admin settings app.js holds (tile visibility for the screens found)
let keysInstalled = false;

/** Fills the search box and the quick actions into the top bar (called every time the bar is drawn). */
export function installDeskTopBar(topBar, navigate, { allowed = true, settings = null } = {}) {
  navigateRef = navigate;
  settingsRef = settings;
  if (!allowed) return;
  const right = topBar.querySelector(".topbar-right");
  if (!right || topBar.querySelector(".topbar-search")) return;
  const search = document.createElement("div");
  search.className = "topbar-search";
  search.innerHTML = `
    <span class="topbar-search-icon" aria-hidden="true">${icons.search ?? ""}</span>
    <input type="search" id="topbar-search-input" autocomplete="off" placeholder="${escapeHtml(t("desk_search_placeholder"))}" aria-label="${escapeHtml(t("desk_search_placeholder"))}" aria-controls="topbar-search-results" aria-expanded="false" />
    <kbd class="topbar-kbd" aria-hidden="true">/</kbd>
    <div class="topbar-search-results" id="topbar-search-results" role="listbox" hidden></div>`;
  const actions = document.createElement("div");
  actions.className = "topbar-actions";
  const action = (key, label, icon, hint) =>
    `<button type="button" class="topbar-action" data-quick="${key}" title="${escapeHtml(`${label} (${hint})`)}">${icon}<span>${escapeHtml(label)}</span><kbd class="topbar-kbd" aria-hidden="true">${hint}</kbd></button>`;
  actions.innerHTML = [
    action("order", t("new_order"), icons.cart, "n o"),
    canCreateTasks() ? action("task", t("task_new"), icons.tasks, "n t") : "",
    action("customer", t("add_customer"), icons.mapPinPlus, "n c"),
  ].join("");
  topBar.insertBefore(search, right);
  right.insertBefore(actions, right.firstChild);
  actions.addEventListener("click", (e) => {
    const key = e.target.closest("[data-quick]")?.dataset.quick;
    if (key) runQuick(key);
  });
  wireSearch(search);
  installKeys();
}

function runQuick(key) {
  const navigate = navigateRef;
  if (!navigate) return;
  if (key === "order") navigate("#/orders?new=1");
  else if (key === "customer") navigate("#/map?add=1");
  else if (key === "task" && canCreateTasks()) {
    import("./views/tasks.js").then((m) => m.openTaskEditor({ onSaved: () => window.dispatchEvent(new Event("tasks-changed")) }));
  }
}

/* ---------- Search ---------- */

function wireSearch(root) {
  const input = root.querySelector("input");
  const box = root.querySelector(".topbar-search-results");
  let timer = null;
  let seq = 0;
  let items = []; // [{ open() }] in the order shown
  let active = 0;

  const close = () => {
    box.hidden = true;
    box.innerHTML = "";
    items = [];
    input.setAttribute("aria-expanded", "false");
  };
  const paintActive = () => {
    box.querySelectorAll("[data-result]").forEach((el) => {
      const on = Number(el.dataset.result) === active;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-selected", String(on));
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  };
  const openItem = (i) => {
    const item = items[i];
    if (!item) return;
    close();
    input.value = "";
    input.blur();
    item.open();
  };

  // One search for everything (owner, 2026-11-04; searchSources.js): screens and actions at once (no network), records after 2 letters,
  // what was opened recently before anything is typed.
  async function run(query, { records = true } = {}) {
    const mine = ++seq;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    items = [];
    const group = (title, rows, row) =>
      rows.length
        ? `<div class="topbar-search-group"><div class="topbar-search-heading">${escapeHtml(title)}</div>${rows.map(row).join("")}</div>`
        : "";
    const itemHtml = (main, sub, trailing, open) => {
      const i = items.push({ open }) - 1;
      return `<button type="button" class="topbar-search-item" role="option" data-result="${i}">
        <span class="topbar-search-main">${main}</span>
        ${sub ? `<span class="topbar-search-sub">${sub}</span>` : ""}
        ${trailing ? `<span class="topbar-search-trailing">${trailing}</span>` : ""}
      </button>`;
    };
    const nav = navigateRef;
    const remember = (entry) => entry.hash && recent.add(entry);
    const go = (entry) => () => {
      remember(entry);
      if (entry.run) entry.run(nav);
      else nav(entry.hash);
    };
    const settings = settingsRef?.() ?? null;
    let html = "";
    if (!query) {
      html = group(t("search_recent"), recent.all(), (r) => itemHtml(escapeHtml(r.label), escapeHtml(r.hint || ""), "", go(r)));
    } else {
      const local = localResults(query, settings);
      html =
        group(t("search_screens"), local.filter((x) => x.kind === "screen"), (x) => itemHtml(escapeHtml(x.label), "", "", go(x))) +
        group(t("search_actions"), local.filter((x) => x.kind === "action"), (x) => itemHtml(escapeHtml(x.label), "", "", go(x)));
    }
    const paint = (extra, loadingMore) => {
      box.innerHTML = html + extra + (loadingMore ? `<p class="topbar-search-note">${t("loading")}</p>` : "") || `<p class="topbar-search-note">${query ? t("desk_search_none") : t("search_hint_all")}</p>`;
      active = 0;
      paintActive();
      box.querySelectorAll("[data-result]").forEach((el) => {
        el.addEventListener("mousedown", (e) => e.preventDefault()); // keep the focus in the input until the click opens it
        el.addEventListener("click", () => openItem(Number(el.dataset.result)));
      });
    };
    if (query.length < 2 || !records) {
      paint("", query.length >= 2);
      return;
    }
    paint("", true);
    const { customers, orders, tasks } = await recordResults(query);
    if (mine !== seq || input.value.trim() !== query) return;
    const rec = (hash, label, hint) => ({ kind: "record", id: hash, hash, label, hint });
    items = items.slice(0, (html.match(/data-result=/g) || []).length);
    const extra =
      group(t("nav_customers"), customers.slice(0, MAX_PER_GROUP), (c) => {
        const hint = [c.erp_customer_id ? `ID ${c.erp_customer_id}` : "", c.assigned_manager_name || ""].filter(Boolean).join(" · ");
        return itemHtml(escapeHtml(c.name), escapeHtml(hint), "", go(rec(`#/customers/${c.id}`, c.name, hint)));
      }) +
      group(t("nav_orders"), orders.slice(0, MAX_PER_GROUP), (o) => {
        const hint = [o.customer_name, formatDateDMY(o.created_at)].filter(Boolean).join(" · ");
        return itemHtml(escapeHtml(o.order_code || `#${o.id}`), escapeHtml(hint), formatAmd(Number(o.total_amd)), go(rec(`#/orders?open=${o.id}`, o.order_code || `#${o.id}`, hint)));
      }) +
      group(t("qa_tasks"), tasks.slice(0, MAX_PER_GROUP), (r) => {
        const hint = [r.customer_name, r.assignee_name].filter(Boolean).join(" · ");
        return itemHtml(escapeHtml(r.title), escapeHtml(hint), escapeHtml(formatDateDMY(r.due_date)), go(rec(`#/tasks?open=${r.id}`, r.title, hint)));
      });
    paint(extra, false);
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    // screens and actions at once (Enter right after typing opens the best one), records a moment later
    run(query, { records: false });
    if (query.length >= 2) timer = setTimeout(() => run(query), 220);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!box.hidden) close();
      else {
        input.value = "";
        input.blur();
      }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paintActive();
    } else if (e.key === "Enter" && items.length) {
      e.preventDefault();
      openItem(active);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && close(), 150));
  input.addEventListener("focus", () => run(input.value.trim()));
}

/* ---------- Keyboard ---------- */

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// a dialog on top of the page (not a panel docked beside it) owns the keyboard
const dialogOpen = () => Boolean(document.querySelector(".sheet-overlay:not(.sheet-docked)"));

function installKeys() {
  if (keysInstalled) return;
  keysInstalled = true;
  let chordAt = 0;
  document.addEventListener("keydown", (e) => {
    // Ctrl K / Cmd K: the search, from anywhere (even while typing in another field), like every modern app
    if (isDesktop() && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k" && state.user) {
      const box = document.getElementById("topbar-search-input");
      if (box) {
        e.preventDefault();
        box.focus();
        box.select();
        return;
      }
    }
    if (!isDesktop() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target) || dialogOpen()) return;
    const input = document.getElementById("topbar-search-input");
    if (!input) return;
    if (e.key === "/") {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "n") {
      chordAt = Date.now();
      return;
    }
    if (chordAt && Date.now() - chordAt < 1200) {
      const quick = { o: "order", t: "task", c: "customer" }[key];
      chordAt = 0;
      if (quick && (quick !== "task" || canCreateTasks())) {
        e.preventDefault();
        runQuick(quick);
      }
    } else chordAt = 0;
  });
}
