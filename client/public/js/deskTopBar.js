// The desktop top bar (docs/desktop-roadmap.md, step 4): a global search (customers, orders, tasks) and quick actions
// (New order, New task, New customer), with keyboard shortcuts -- "/" focuses the search, "n" then "o" / "t" / "c" start a new
// order / task / customer. All of it is hidden on a phone (desktop.css) and the keys only work on a desktop window.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml, formatAmd, formatDateDMY } from "./util.js";
import { canCreateTasks } from "./state.js";
import { isDesktop } from "./deskTable.js";

const MAX_PER_GROUP = 5;
let navigateRef = null;
let keysInstalled = false;
let tasksCache = { at: 0, rows: null };

/** Fills the search box and the quick actions into the top bar (called every time the bar is drawn). */
export function installDeskTopBar(topBar, navigate, { allowed = true } = {}) {
  navigateRef = navigate;
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

  async function run(query) {
    const mine = ++seq;
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    box.innerHTML = `<p class="topbar-search-note">${t("loading")}</p>`;
    const [customers, orders, tasks] = await Promise.all([
      api.listCustomers({ search: query, limit: MAX_PER_GROUP }).catch(() => []),
      api.listOrders({ q: query, limit: MAX_PER_GROUP }, { fresh: true }).then((r) => r.rows ?? []).catch(() => []),
      searchTasks(query).catch(() => []),
    ]);
    if (mine !== seq || input.value.trim() !== query) return;
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
    const html =
      group(t("nav_customers"), customers.slice(0, MAX_PER_GROUP), (c) =>
        itemHtml(escapeHtml(c.name), escapeHtml([c.erp_customer_id ? `ID ${c.erp_customer_id}` : "", c.assigned_manager_name || ""].filter(Boolean).join(" · ")), "", () => nav(`#/customers/${c.id}`))
      ) +
      group(t("nav_orders"), orders.slice(0, MAX_PER_GROUP), (o) =>
        itemHtml(escapeHtml(o.order_code || `#${o.id}`), escapeHtml([o.customer_name, formatDateDMY(o.created_at)].filter(Boolean).join(" · ")), formatAmd(Number(o.total_amd)), () => nav(`#/orders?open=${o.id}`))
      ) +
      group(t("qa_tasks"), tasks.slice(0, MAX_PER_GROUP), (r) =>
        itemHtml(escapeHtml(r.title), escapeHtml([r.customer_name, r.assignee_name].filter(Boolean).join(" · ")), escapeHtml(formatDateDMY(r.due_date)), () => nav(`#/tasks?open=${r.id}`))
      );
    box.innerHTML = html || `<p class="topbar-search-note">${t("desk_search_none")}</p>`;
    active = 0;
    paintActive();
    box.querySelectorAll("[data-result]").forEach((el) => {
      el.addEventListener("mousedown", (e) => e.preventDefault()); // keep the focus in the input until the click opens it
      el.addEventListener("click", () => openItem(Number(el.dataset.result)));
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) {
      seq++;
      close();
      return;
    }
    timer = setTimeout(() => run(query), 220);
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
  input.addEventListener("focus", () => input.value.trim().length >= 2 && run(input.value.trim()));
}

// Open tasks are loaded once a minute at most and searched here (the task list already carries everything visible to this person).
async function searchTasks(query) {
  if (!tasksCache.rows || Date.now() - tasksCache.at > 60000) {
    const result = await api.listTasks({ scope: "all", status: "open" });
    tasksCache = { at: Date.now(), rows: result.rows ?? [] };
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tasksCache.rows.filter((r) => {
    const text = [r.title, r.customer_name, r.assignee_name].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
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
