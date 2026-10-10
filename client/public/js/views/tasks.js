// Task management: a module page (my tasks / created by me / all), the task
// sheet (checklist, complete, edit, cancel) and the create/edit sheet, which is
// also opened from a customer card (customer pre-attached). Management gives
// tasks (server/src/roles.js canCreateTasks); everyone receives and completes
// them. Deadline: the customer's next visit by default, or a chosen date.
import { openCollectionOutcomeSheet } from "../collectionOutcomeSheet.js";
import { api } from "../api.js";
import { escapeHtml, activateDialog, formatDateDMY, parseDateOnly, labelColon } from "../util.js";
import { FILTER_ICONS } from "../filterIcons.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { state } from "../state.js";

const CREATOR_ROLES = new Set(["admin", "ceo", "operations_director", "sales_director"]);
const SEES_ALL_ROLES = new Set(["admin", "ceo", "operations_director", "sales_director"]);
export const canCreateTasks = () => CREATOR_ROLES.has(state.user?.role);

function notifyTasksChanged() {
  window.dispatchEvent(new Event("tasks-changed"));
}

// "due" = deadline is today or already passed (red); otherwise yellow.
export function taskDueInfo(task, today) {
  if (task.status !== "open") return { cls: "badge-neutral", due: false, label: formatDateDMY(task.due_date) };
  const due = task.due_date <= today;
  const label = task.due_date === today ? t("task_due_today") : task.due_date < today ? `${t("task_overdue")} · ${formatDateDMY(task.due_date)}` : formatDateDMY(task.due_date);
  return { cls: due ? "badge-danger" : "badge-warning", due, label };
}

// Debt collection and reorder follow-ups are created automatically; everything else was
// given by a person.
function taskKindIcon(task) {
  if (task.status === "done") return icons.checkCircle;
  if (task.auto_kind === "debt_collection") return icons.wallet;
  if (task.auto_kind === "reorder_followup") return icons.repeat;
  return icons.tasks;
}

function progressText(task) {
  const total = task.items.length;
  if (!total) return "";
  return `${task.items.filter((i) => i.done).length}/${total}`;
}

export function taskCardHtml(task, today, { showCustomer = true } = {}) {
  const info = taskDueInfo(task, today);
  const mine = task.assignee_id === state.user.id;
  return `
    <button type="button" class="card list-row task-card ${task.status !== "open" ? "task-card-closed" : ""}" data-task-id="${task.id}">
      <span class="list-row-icon list-row-icon-${task.status === "done" ? "success" : info.due ? "danger" : "warning"}" aria-hidden="true">${taskKindIcon(task)}</span>
      <div class="list-row-body">
        <div class="list-row-top">
          <strong>${escapeHtml(task.title)}</strong>
          ${progressText(task) ? `<span class="list-row-trailing-text muted">${progressText(task)}</span>` : ""}
        </div>
        <div class="muted list-row-meta">${[showCustomer && task.customer_name ? escapeHtml(task.customer_name) : "", mine ? "" : escapeHtml(task.assignee_name)].filter(Boolean).join(" · ")}</div>
        <div class="list-row-bottom">
          <span class="badge ${info.cls}">${info.label}</span>
          ${task.status === "done" ? `<span class="badge badge-success">${t("task_status_done")}</span>` : ""}
          ${task.status === "cancelled" ? `<span class="badge badge-neutral">${t("task_status_cancelled")}</span>` : ""}
        </div>
      </div>
      <span class="chevron">&#8250;</span>
    </button>`;
}

// The Tasks page follows the Activity page: status tabs, one pill per person (busiest first,
// tap again to clear), and a search bar with icon filters (who / type / sort). Everything is
// loaded once (open tasks always come first in the 500-row cap) and filtered on the phone, so
// switching tabs, people and filters is instant.
const TASK_KINDS = ["debt_collection", "reorder_followup", "manual"];
const kindOf = (r) => r.auto_kind || "manual";

export async function renderTasks(root, navigate, openId) {
  const creator = canCreateTasks();
  const sawAll = SEES_ALL_ROLES.has(state.user.role);
  root.innerHTML = `<div class="activity-view tasks-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".tasks-view");

  // Managers see everything they gave or received (a task they just created for someone else
  // must show up); open tasks of any date by default.
  const f = { tab: "open", scope: creator || sawAll ? "all" : "mine", person: "", kind: "", sort: "due", search: "" };
  let rows = [];
  let today = "";
  let openDropdown = null;
  let loaded = false;
  let loadError = "";

  const inTab = (r, tab) => (tab === "today" ? r.status === "open" && r.due_date <= today : tab === "open" ? r.status === "open" : r.status === tab);
  const inScope = (r) => f.scope === "all" || (f.scope === "mine" ? r.assignee_id === state.user.id : r.creator_id === state.user.id);
  const matchesSearch = (r) => {
    const q = f.search.trim().toLowerCase();
    return !q || [r.title, r.customer_name, r.assignee_name, r.creator_name].filter(Boolean).join(" ").toLowerCase().includes(q);
  };
  // `skip` lets the tab counts and person pills ignore their own filter.
  const visible = ({ tab = f.tab, person = f.person } = {}) =>
    rows.filter((r) => inTab(r, tab) && inScope(r) && (!f.kind || kindOf(r) === f.kind) && (!person || String(r.assignee_id) === person) && matchesSearch(r));

  function sorted(list) {
    const byDue = (a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : b.id - a.id);
    const copy = [...list];
    if (f.tab === "done" || f.tab === "cancelled") {
      // Newest result first: when it was closed matters more than when it was due.
      return copy.sort((a, b) => String(b.updated_at || b.due_date).localeCompare(String(a.updated_at || a.due_date)) || b.id - a.id);
    }
    if (f.sort === "newest") return copy.sort((a, b) => b.id - a.id);
    if (f.sort === "person") return copy.sort((a, b) => String(a.assignee_name).localeCompare(String(b.assignee_name)) || byDue(a, b));
    return copy.sort(byDue);
  }

  function dropdownHtml(key, options, current, icon, label, applied) {
    const isOpen = openDropdown === key;
    return `
      <div class="activity-icon-dropdown">
        <button type="button" class="activity-search-filter-btn ${applied ? "activity-search-filter-btn-active" : ""} ${isOpen ? "activity-search-filter-btn-open" : ""}"
          data-dropdown="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-haspopup="menu" aria-expanded="${isOpen}">
          ${icon}${applied ? `<span class="activity-search-filter-dot" aria-hidden="true"></span>` : ""}
        </button>
        <div class="activity-search-menu" role="menu" data-dropdown-menu="${key}" ${isOpen ? "" : "hidden"}>
          ${options.map((o) => `<button type="button" role="menuitemradio" aria-checked="${o.value === current}" data-value="${escapeHtml(o.value)}" class="${o.value === current ? "filter-dropdown-selected" : ""}"><span>${escapeHtml(o.label)}</span>${o.value === current ? `<span class="activity-menu-check" aria-hidden="true">✓</span>` : ""}</button>`).join("")}
        </div>
      </div>`;
  }

  function personPillsHtml() {
    const counts = new Map();
    const names = new Map();
    for (const r of visible({ person: "" })) {
      counts.set(String(r.assignee_id), (counts.get(String(r.assignee_id)) ?? 0) + 1);
      names.set(String(r.assignee_id), r.assignee_name);
    }
    // One person (a plain sales manager, or a filter that leaves one) has nothing to split by.
    if (names.size < 2 && !f.person) return "";
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const pills = [{ value: "", label: t("filter_all"), count: total }, ...[...names.entries()].map(([id, name]) => ({ value: id, label: name, count: counts.get(id) })).sort((a, b) => b.count - a.count)];
    if (f.person && !names.has(f.person)) pills.push({ value: f.person, label: rows.find((r) => String(r.assignee_id) === f.person)?.assignee_name ?? "", count: 0 });
    return `<div class="customer-stats-bar activity-manager-bar" id="task-person-bar" aria-label="${escapeHtml(t("tasks_people"))}">
      ${pills.map((p) => `<button type="button" class="stat-pill ${f.person === p.value ? "stat-pill-active" : ""}" data-person="${escapeHtml(p.value)}" aria-pressed="${f.person === p.value}"><strong>${p.count}</strong><span>${escapeHtml(p.label)}</span></button>`).join("")}
    </div>`;
  }

  function tabHtml(key, label) {
    const active = f.tab === key;
    // Counts only where they help decide what to open (what is waiting); closed tasks just list.
    const count = key === "today" || key === "open" ? `<span class="tasks-tab-count">${visible({ tab: key, person: f.person }).length}</span>` : "";
    return `<button role="tab" aria-selected="${active}" class="activity-tab tasks-tab ${active ? "activity-tab-active" : ""}" data-tab="${key}"><span>${label}</span>${count}</button>`;
  }

  function renderShell() {
    const scopeOptions = [
      { value: "all", label: t("tasks_scope_all") },
      { value: "mine", label: t("tasks_scope_mine") },
      { value: "created", label: t("tasks_scope_created") },
    ];
    const kindOptions = [
      { value: "", label: t("tasks_kind_all") },
      { value: "debt_collection", label: t("tasks_kind_debt") },
      { value: "reorder_followup", label: t("tasks_kind_reorder") },
      { value: "manual", label: t("tasks_kind_manual") },
    ];
    const sortOptions = [
      { value: "due", label: t("tasks_sort_due") },
      { value: "newest", label: t("tasks_sort_newest") },
      { value: "person", label: t("tasks_sort_person") },
    ];
    const closedTab = f.tab === "done" || f.tab === "cancelled";
    container.innerHTML = `
      <div class="list-header">
        <div><h1>${t("tasks_title")}</h1></div>
        ${creator ? `<button type="button" class="icon-btn" id="task-new-btn" aria-label="${t("task_new")}">${icons.plus}</button>` : ""}
      </div>
      <div class="activity-tabs" role="tablist" id="task-tabs"></div>
      <div id="task-people"></div>
      <div class="activity-search-combined" id="task-search-combined">
        <label class="visually-hidden" for="task-search">${t("search")}</label>
        <input type="search" id="task-search" placeholder="${t("search")}" aria-label="${t("search")}" value="${escapeHtml(f.search)}" />
        <div class="activity-search-actions" aria-label="${t("filters")}">
          ${creator || sawAll ? dropdownHtml("scope", scopeOptions, f.scope, FILTER_ICONS.manager, t("tasks_scope_label"), f.scope !== "all") : ""}
          ${dropdownHtml("kind", kindOptions, f.kind, FILTER_ICONS.outcome, t("tasks_kind_label"), Boolean(f.kind))}
          ${closedTab ? "" : dropdownHtml("sort", sortOptions, f.sort, FILTER_ICONS.sort, t("sort"), f.sort !== "due")}
        </div>
      </div>
      <div class="activity-count" id="task-count"></div>
      <div class="card-list" id="task-list"></div>`;

    const searchInput = container.querySelector("#task-search");
    searchInput.addEventListener("input", () => {
      f.search = searchInput.value;
      paintChrome();
      paintList();
    });
    container.querySelector("#task-new-btn")?.addEventListener("click", () => openTaskEditor({ onSaved: load }));
    container.querySelectorAll("[data-dropdown]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDropdown = openDropdown === btn.dataset.dropdown ? null : btn.dataset.dropdown;
        renderShell();
      })
    );
    container.querySelectorAll("[data-dropdown-menu] button").forEach((opt) =>
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = opt.closest("[data-dropdown-menu]").dataset.dropdownMenu;
        f[key] = opt.dataset.value;
        openDropdown = null;
        renderShell();
      })
    );
    paintChrome();
    paintList();
  }

  // The tabs (with their counts) and the person pills depend on every other filter, including the
  // search text, so they are redrawn on their own while typing without touching the input.
  function paintChrome() {
    container.querySelector("#task-tabs").innerHTML = [
      tabHtml("today", t("tasks_filter_today")),
      tabHtml("open", t("tasks_filter_open")),
      tabHtml("done", t("task_status_done")),
      tabHtml("cancelled", t("task_status_cancelled")),
    ].join("");
    container.querySelector("#task-people").innerHTML = personPillsHtml();
    container.querySelectorAll("[data-tab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        f.tab = btn.dataset.tab;
        openDropdown = null;
        renderShell();
      })
    );
    container.querySelectorAll("[data-person]").forEach((btn) =>
      btn.addEventListener("click", () => {
        // Tapping the person that is already on clears it, so "All" is not the only way back.
        f.person = f.person === btn.dataset.person ? "" : btn.dataset.person;
        paintChrome();
        paintList();
      })
    );
  }

  function groupHeading(label, n) {
    return `<h3 class="list-group-heading tasks-group-heading">${escapeHtml(label)} <span class="muted">${n}</span></h3>`;
  }

  function paintList() {
    const listEl = container.querySelector("#task-list");
    const countEl = container.querySelector("#task-count");
    if (!loaded) {
      countEl.textContent = "";
      listEl.innerHTML = loadError ? `<p class="form-error">${escapeHtml(loadError)}</p>` : `<p class="loading-state" role="status">${t("loading")}</p>`;
      return;
    }
    const list = sorted(visible());
    countEl.textContent = `${list.length} ${t("tasks_count")}`;
    if (!list.length) {
      listEl.innerHTML = `<p class="empty-state">${t("tasks_empty")}</p>`;
      return;
    }
    let html;
    if (f.tab !== "done" && f.tab !== "cancelled" && f.sort === "due") {
      // Overdue / today / upcoming, so what needs doing first is the first thing seen.
      const groups = [
        [t("task_overdue"), list.filter((r) => r.due_date < today)],
        [t("task_due_today"), list.filter((r) => r.due_date === today)],
        [t("tasks_group_upcoming"), list.filter((r) => r.due_date > today)],
      ];
      html = groups.filter(([, g]) => g.length).map(([label, g]) => groupHeading(label, g.length) + g.map((r) => taskCardHtml(r, today)).join("")).join("");
    } else {
      html = list.map((r) => taskCardHtml(r, today)).join("");
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll("[data-task-id]").forEach((el) => el.addEventListener("click", () => openTaskSheet(Number(el.dataset.taskId), { onChanged: load, navigate })));
  }

  container.addEventListener("click", (e) => {
    if (openDropdown && !e.target.closest("[data-dropdown]") && !e.target.closest("[data-dropdown-menu]")) {
      openDropdown = null;
      renderShell();
    }
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDropdown) {
      openDropdown = null;
      renderShell();
    }
  });

  // Reloads without blanking the screen: after completing/cancelling/restoring a task the list
  // updates in place.
  async function load() {
    try {
      const result = await api.listTasks({ scope: "all", status: "all" });
      rows = result.rows;
      today = result.today;
      loaded = true;
      loadError = "";
    } catch (err) {
      loadError = err.message;
    }
    renderShell();
  }
  window.addEventListener("tasks-changed", load, { once: true });

  renderShell();
  await load();
  if (openId) openTaskSheet(Number(openId), { onChanged: load, navigate });
}

// ---- Task sheet ------------------------------------------------------------

export async function openTaskSheet(taskId, { onChanged, navigate } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const sheet = overlay.querySelector(".sheet");

  let task;
  let today;
  try {
    task = await api.getTask(taskId);
    today = task.today;
  } catch (err) {
    sheet.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  render();

  function render() {
    const info = taskDueInfo(task, today);
    const isCreator = task.creator_id === state.user.id || ["admin", "ceo", "operations_director"].includes(state.user.role);
    const open = task.status === "open";
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <h2 class="task-sheet-title">${escapeHtml(task.title)}</h2>
      <p>
        <span class="badge ${info.cls}">${info.label}</span>
        ${task.status === "done" ? `<span class="badge badge-success">${t("task_status_done")}</span>` : ""}
        ${task.status === "cancelled" ? `<span class="badge badge-neutral">${t("task_status_cancelled")}</span>` : ""}
        ${task.due_is_next_visit ? `<span class="badge badge-neutral">${t("task_deadline_next_visit")}</span>` : ""}
      </p>
      <div class="detail-facts task-sheet-facts">
        ${task.customer_name ? `<div class="detail-fact"><span class="detail-fact-icon">${icons.store}</span><a href="#/customers/${task.customer_id}" data-customer-link>${escapeHtml(task.customer_name)}</a></div>` : ""}
        <div class="detail-fact"><span class="detail-fact-icon">${icons.customers}</span><span>${t("task_assigned_to")}${labelColon()}${escapeHtml(task.assignee_name)}</span></div>
        <div class="detail-fact"><span class="detail-fact-icon">${icons.note}</span><span>${t("task_created_by")}${labelColon()}${escapeHtml(task.creator_name)}</span></div>
      </div>
      ${
        task.items.length
          ? `<h3 class="list-group-heading">${t("task_checklist")}</h3>
             <div class="task-checklist">
               ${task.items
                 .map(
                   (i) => `<label class="task-check-row ${i.done ? "task-check-done" : ""}">
                     <input type="checkbox" data-item="${i.id}" ${i.done ? "checked" : ""} ${task.status === "cancelled" ? "disabled" : ""} />
                     <span>${escapeHtml(i.text)}</span>
                   </label>`
                 )
                 .join("")}
             </div>`
          : ""
      }
      ${task.outcome ? `<p><span class="badge badge-neutral">${t(`collect_outcome_${task.outcome}`)}${task.promise_date ? ` · ${escapeHtml(task.promise_date)}` : ""}</span></p>` : ""}
      ${task.completion_note ? `<p class="muted">${escapeHtml(task.completion_note)}</p>` : ""}
      ${open && !task.items.length && task.auto_kind !== "debt_collection" ? `<textarea id="task-complete-note" class="task-complete-note" rows="2" maxlength="500" placeholder="${escapeHtml(t("task_note_placeholder"))}" aria-label="${escapeHtml(t("task_note_placeholder"))}"></textarea>` : ""}
      <p class="form-error" id="task-sheet-error" hidden></p>
      <div class="sheet-actions" id="task-sheet-actions" style="flex-wrap:wrap;">
        ${open ? `<button type="button" class="btn btn-primary" data-action="complete">${t("task_mark_complete")}</button>` : ""}
        ${task.status === "done" ? `<button type="button" class="btn" data-action="reopen">${t("task_reopen")}</button>` : ""}
        ${isCreator && task.status !== "cancelled" ? `<button type="button" class="btn" data-action="edit">${t("edit")}</button>` : ""}
        ${isCreator && open ? `<button type="button" class="btn btn-danger" data-action="cancel">${t("task_cancel")}</button>` : ""}
        ${isCreator && task.status === "cancelled" ? `<button type="button" class="btn" data-action="restore">${t("task_restore")}</button>` : ""}
      </div>`;
    const errorEl = sheet.querySelector("#task-sheet-error");
    const fail = (err) => {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    };
    const refresh = async (promise) => {
      try {
        task = await promise;
        notifyTasksChanged();
        onChanged?.();
        render();
      } catch (err) {
        fail(err);
      }
    };
    sheet.querySelector('[data-action="close"]').addEventListener("click", () => overlay.remove());
    sheet.querySelector("[data-customer-link]")?.addEventListener("click", (e) => {
      e.preventDefault();
      overlay.remove();
      (navigate || ((h) => (location.hash = h)))(`#/customers/${task.customer_id}`);
    });
    sheet.querySelectorAll("[data-item]").forEach((box) =>
      box.addEventListener("change", () => refresh(api.setTaskItemDone(task.id, Number(box.dataset.item), box.checked)))
    );
    sheet.querySelector('[data-action="complete"]')?.addEventListener("click", async () => {
      if (task.auto_kind === "debt_collection") {
        // How did the collection go? (a promised payment needs a date)
        const result = await openCollectionOutcomeSheet();
        if (result) refresh(api.completeTask(task.id, result.note, { outcome: result.outcome, promise_date: result.promise_date }));
        return;
      }
      // The optional note is an inline field now (a native prompt() popup blocked the screen).
      const note = sheet.querySelector("#task-complete-note")?.value ?? "";
      refresh(api.completeTask(task.id, note.trim()));
    });
    sheet.querySelector('[data-action="reopen"]')?.addEventListener("click", () => refresh(api.reopenTask(task.id)));
    sheet.querySelector('[data-action="cancel"]')?.addEventListener("click", () => {
      // No confirmation: a cancelled task can be restored with one tap.
      refresh(api.updateTask(task.id, { status: "cancelled" }));
    });
    sheet.querySelector('[data-action="restore"]')?.addEventListener("click", () => refresh(api.updateTask(task.id, { status: "open" })));
    sheet.querySelector('[data-action="edit"]')?.addEventListener("click", () => {
      overlay.remove();
      openTaskEditor({
        task,
        onSaved: () => {
          notifyTasksChanged();
          onChanged?.();
        },
      });
    });
  }
}

// ---- Create / edit ----------------------------------------------------------

function addDaysISO(dateISO, n) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Where the task's deadline falls when it is "the customer's next visit".
async function nextVisitDate(customerId) {
  try {
    const s = await api.getVisitSchedule(customerId);
    return s?.planned?.[0]?.date ?? s?.cadence?.planned_date ?? s?.cadence?.due_by ?? null;
  } catch {
    return null;
  }
}

// `customer` (optional): { id, name, assigned_manager_id } pre-attaches the task
// (opened from a customer card). `task`: edit an existing one.
export async function openTaskEditor({ customer = null, task = null, onSaved } = {}) {
  let assignees = [];
  try {
    assignees = await api.listTaskAssignees();
  } catch {
    assignees = [];
  }
  const todayISO = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  let customerId = task?.customer_id ?? customer?.id ?? null;
  let customerName = task?.customer_name ?? customer?.name ?? "";
  let deadlineMode = task ? (task.due_is_next_visit ? "next" : "date") : customerId ? "next" : "date";
  let dueDate = task?.due_date ?? todayISO;
  let assigneeId = task?.assignee_id ?? null;

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet task-editor">
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <h2>${task ? t("task_edit") : t("task_new")}</h2>
      <form id="task-form">
        <div class="task-two-col">
          <div class="task-col">
            <span class="task-label">${t("task_customer")}</span>
            <div id="task-customer-box"></div>
          </div>
          <div class="task-col">
            <span class="task-label">${t("task_assigned_to")}</span>
            <div class="task-select-wrap">
              <select class="task-control" id="task-assignee" aria-label="${t("task_assigned_to")}"></select>
            </div>
          </div>
        </div>
        <div class="card-list task-customer-results" id="task-customer-results" hidden></div>

        <div class="task-field">
          <span class="task-label">${t("task_deadline")}</span>
          <div class="task-deadline-row">
            <input type="date" class="task-control" id="task-due" value="${dueDate}" aria-label="${t("task_deadline")}" />
            <button type="button" class="task-toggle-btn" data-mode="next">${t("task_deadline_next_visit")}</button>
            <button type="button" class="task-toggle-btn" data-mode="date">${t("task_deadline_date")}</button>
          </div>
          <p class="muted task-hint" id="task-due-hint" hidden></p>
        </div>

        <div class="task-field">
          <label class="task-label" for="task-title-input">${t("task_title_label")}</label>
          <input class="task-control" id="task-title-input" name="title" maxlength="160" required value="${escapeHtml(task?.title ?? "")}" />
        </div>

        <div class="task-field">
          <span class="task-label">${t("task_checklist")}</span>
          <div id="task-items"></div>
        </div>
        <p class="form-error" id="task-form-error" hidden></p>
      </form>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="close">${t("cancel")}</button>
        <button type="submit" form="task-form" class="btn btn-primary" id="task-save">${t("save")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));

  const form = overlay.querySelector("#task-form");
  const errorEl = overlay.querySelector("#task-form-error");
  const assigneeSel = overlay.querySelector("#task-assignee");
  const dueInput = overlay.querySelector("#task-due");
  const dueHint = overlay.querySelector("#task-due-hint");
  const itemsEl = overlay.querySelector("#task-items");
  const customerBox = overlay.querySelector("#task-customer-box");

  function paintAssignees() {
    assigneeSel.innerHTML = [`<option value="">${t("task_choose_person")}</option>`, ...assignees.map((u) => `<option value="${u.id}" ${u.id === assigneeId ? "selected" : ""}>${escapeHtml(u.name)}</option>`)].join("");
  }
  assigneeSel.addEventListener("change", () => (assigneeId = Number(assigneeSel.value) || null));

  function paintDeadline() {
    overlay.querySelectorAll("[data-mode]").forEach((b) => {
      const isNext = b.dataset.mode === "next";
      b.disabled = isNext && !customerId;
      b.classList.toggle("task-toggle-active", b.dataset.mode === deadlineMode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === deadlineMode));
    });
    dueInput.value = dueDate;
    dueInput.disabled = deadlineMode === "next";
    dueHint.hidden = deadlineMode !== "next";
    dueHint.textContent = deadlineMode === "next" ? `${t("task_deadline_next_visit")}${labelColon()}${dueDate ? formatDateDMY(dueDate) : "—"}` : "";
  }
  async function applyNextVisit() {
    if (deadlineMode !== "next" || !customerId) return;
    const d = await nextVisitDate(customerId);
    dueDate = d || todayISO;
    paintDeadline();
  }
  overlay.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      deadlineMode = b.dataset.mode;
      paintDeadline();
      applyNextVisit();
    })
  );
  dueInput.addEventListener("change", () => (dueDate = dueInput.value || dueDate));

  function paintCustomer() {
    if (customerId) {
      overlay.querySelector("#task-customer-results").hidden = true;
      customerBox.innerHTML = `<div class="task-control task-customer-chip"><strong>${escapeHtml(customerName)}</strong>${customer?.locked ? "" : `<button type="button" class="task-chip-x" id="task-customer-clear" aria-label="${t("task_change_customer")}">${icons.close}</button>`}</div>`;
      customerBox.querySelector("#task-customer-clear")?.addEventListener("click", () => {
        customerId = null;
        customerName = "";
        if (deadlineMode === "next") deadlineMode = "date";
        paintCustomer();
        paintDeadline();
      });
      return;
    }
    customerBox.innerHTML = `<input type="search" class="task-control" id="task-customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" />`;
    const search = customerBox.querySelector("#task-customer-search");
    const results = overlay.querySelector("#task-customer-results");
    results.hidden = true;
    let timer;
    let seq = 0;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = search.value.trim();
        if (q.length < 2) {
          results.hidden = true;
          return;
        }
        const mine = ++seq;
        try {
          const found = (await api.listCustomers({ search: q })).slice(0, 8);
          if (mine !== seq) return;
          results.hidden = false;
          results.innerHTML = found.length
            ? found.map((c) => `<button type="button" class="card" style="text-align:left;width:100%;" data-cid="${c.id}">${escapeHtml(c.name)}</button>`).join("")
            : `<p class="empty-state">${t("no_customers_found")}</p>`;
          results.querySelectorAll("[data-cid]").forEach((btn) =>
            btn.addEventListener("click", async () => {
              const c = found.find((x) => String(x.id) === btn.dataset.cid);
              customerId = c.id;
              customerName = c.name;
              // The customer's own assigned manager (or director) is the default person.
              if (c.assigned_manager_id && assignees.some((u) => u.id === c.assigned_manager_id)) {
                assigneeId = c.assigned_manager_id;
                paintAssignees();
              }
              deadlineMode = "next";
              paintCustomer();
              paintDeadline();
              applyNextVisit();
            })
          );
        } catch {
          results.hidden = true;
        }
      }, 300);
    });
  }

  let items = (task?.items ?? []).map((i) => ({ id: i.id, text: i.text }));
  // One row per item: [+] [text] [x]. The + (add another item) sits on the
  // last row only; earlier rows keep an empty spacer so the fields line up.
  const MAX_TASK_ITEMS = 30;
  function paintItems() {
    itemsEl.innerHTML = items
      .map((it, idx) => {
        const isLast = idx === items.length - 1;
        const plus =
          isLast && items.length < MAX_TASK_ITEMS
            ? `<button type="button" class="task-icon-btn" data-add aria-label="${t("task_add_item")}">${icons.plus}</button>`
            : `<span class="task-icon-btn task-icon-spacer" aria-hidden="true"></span>`;
        return `<div class="task-item-row">${plus}<input class="task-control" data-idx="${idx}" value="${escapeHtml(it.text)}" maxlength="300" placeholder="${t("task_item_placeholder")}" /><button type="button" class="task-icon-btn" data-remove="${idx}" aria-label="${t("delete")}">${icons.close}</button></div>`;
      })
      .join("");
    itemsEl.querySelectorAll("input[data-idx]").forEach((inp) => inp.addEventListener("input", () => (items[Number(inp.dataset.idx)].text = inp.value)));
    itemsEl.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        const idx = Number(b.dataset.remove);
        if (items.length === 1) items[0] = { id: null, text: "" };
        else items.splice(idx, 1);
        paintItems();
      })
    );
    itemsEl.querySelector("[data-add]")?.addEventListener("click", () => {
      items.push({ id: null, text: "" });
      paintItems();
      itemsEl.querySelector(`input[data-idx="${items.length - 1}"]`)?.focus();
    });
  }
  if (!items.length) items.push({ id: null, text: "" });

  // Default person for a customer opened from its card (customer.assigned_manager_id).
  if (!task && customer?.assigned_manager_id && assignees.some((u) => u.id === customer.assigned_manager_id)) assigneeId = customer.assigned_manager_id;

  paintAssignees();
  paintCustomer();
  paintItems();
  paintDeadline();
  applyNextVisit();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const saveBtn = overlay.querySelector("#task-save");
    saveBtn.disabled = true;
    const payload = {
      title: form.querySelector("#task-title-input").value.trim(),
      assignee_id: assigneeId,
      customer_id: customerId,
      due_date: dueDate,
      due_is_next_visit: deadlineMode === "next",
      items: items.filter((i) => i.text.trim()).map((i) => ({ id: i.id ?? undefined, text: i.text.trim() })),
    };
    try {
      if (!assigneeId) throw new Error(t("task_choose_person"));
      if (task) await api.updateTask(task.id, payload);
      else await api.createTask(payload);
      overlay.remove();
      notifyTasksChanged();
      onSaved?.();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

// Open tasks of one customer for its card / check-in (rows from the API).
export async function loadCustomerTasks(customerId) {
  try {
    const result = await api.listTasks({ scope: "all", status: "open", customer_id: customerId });
    return result;
  } catch {
    return { rows: [], today: "" };
  }
}

// Home tab card: my open tasks, "Today" (due today or overdue) by default with a
// toggle to all open ones. Hidden entirely when there is nothing open.
export async function renderHomeTasks(slot, navigate) {
  if (!slot) return;
  let mode = "today";
  let data = null;

  function paintBadge() {
    const badge = document.getElementById("qa-tasks-badge");
    if (!badge || !data) return;
    const n = data.rows.filter((r) => r.due_date <= data.today).length;
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.hidden = n === 0;
  }
  function paint() {
    if (!data) return;
    paintBadge();
    if (!data.rows.length) {
      slot.innerHTML = "";
      return;
    }
    const shown = mode === "today" ? data.rows.filter((r) => r.due_date <= data.today) : data.rows;
    const max = 5;
    slot.innerHTML = `
      <div class="tasks-block">
        <div class="tasks-home-head">
          <h2 class="section-title section-title-inline">${t("tasks_home_title")}</h2>
          <div class="segmented" role="group">
            <button type="button" class="chip ${mode === "today" ? "chip-active" : ""}" data-mode="today">${t("tasks_filter_today")}</button>
            <button type="button" class="chip ${mode === "all" ? "chip-active" : ""}" data-mode="all">${t("tasks_filter_open")}</button>
          </div>
        </div>
        <div class="card-list">
          ${shown.length ? shown.slice(0, max).map((r) => taskCardHtml(r, data.today)).join("") : `<p class="empty-state">${t("tasks_empty")}</p>`}
        </div>
        ${shown.length > max || data.rows.length ? `<button type="button" class="link-btn" id="tasks-home-all">${t("tasks_view_all")} (${data.rows.length})</button>` : ""}
      </div>`;
    slot.querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        paint();
      })
    );
    slot.querySelectorAll("[data-task-id]").forEach((el) => el.addEventListener("click", () => openTaskSheet(Number(el.dataset.taskId), { onChanged: load, navigate })));
    slot.querySelector("#tasks-home-all")?.addEventListener("click", () => navigate("#/tasks"));
  }
  async function load() {
    try {
      data = await api.listTasks({ scope: "mine", status: "open" });
      paint();
    } catch {
      /* optional card */
    }
  }
  await load();
}
