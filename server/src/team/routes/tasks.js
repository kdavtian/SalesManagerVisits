// Task management (migrations/093): management gives a staff member a task
// with a checklist, optionally attached to a customer, due on a date (the
// customer's next visit by default). See roles.js canCreateTasks.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canCreateTasks, seesAllTasks, taskAssigneeRoles, sendsRequests, tasksAnyone, taskClosesItself, canCancelSelfClosingTask } from "../../shared/roles.js";
import { notifyUser } from "../../shared/notifications.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const MAX_ITEMS = 30;
// Types a person can give (migration 125): each needs a customer and closes itself when the rep does what it asks.
export const TASK_KINDS = ["collect_debt", "make_order", "check_products", "call_customer", "visit_customer"];
export const CALL_RESULTS = ["spoke", "no_answer", "call_back", "wrong_number"];
const MAX_PROMISE_DAYS = 60;
// A self-closing task (roles.js taskClosesItself) is refused every way of closing it by hand.
const CLOSES_ITSELF_ERROR = { error: "This task closes by itself when the work is recorded (check-in, payment). It cannot be marked done by hand.", code: "closes_itself" };
// What a rep can record on a debt task WITHOUT closing it (only a payment closes it).
const DEBT_RESULTS_OPEN = ["promised", "no_answer", "refused"];
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v) => /^\d+$/.test(String(v));

// User ids of everyone below the user ${me} in the Staff "reports to" tree, direct and indirect (UNION stops at a loop).
const subordinatesSql = (me) => `(WITH RECURSIVE sub AS (
    SELECT s.id, s.user_id FROM staff_members s JOIN staff_members boss ON s.reports_to = boss.id WHERE boss.user_id = ${me}
    UNION SELECT s.id, s.user_id FROM staff_members s JOIN sub ON s.reports_to = sub.id)
  SELECT sub.user_id FROM sub WHERE sub.user_id IS NOT NULL)`;

// Which tasks a user may see at all: management sees all; everyone else their own (given to / created by them) and those of the
// people below them in Staff; a sales director also every sales manager's.
function visibilitySql(user, params) {
  if (seesAllTasks(user.role)) return "TRUE";
  params.push(user.id);
  const me = `$${params.length}`;
  const own = `t.creator_id = ${me} OR t.assignee_id = ${me} OR t.assignee_id IN ${subordinatesSql(me)}`;
  if (user.role === "sales_director") {
    return `(${own} OR EXISTS (SELECT 1 FROM users au WHERE au.id = t.assignee_id AND au.role = 'sales_manager'))`;
  }
  return `(${own})`;
}

// Who the user may give a task to, as a condition on users alias u (owner, 2026-10-28): admin / CEO anyone; another task giver the
// people below them in Staff ("reports to"); the accountant's requests go to the sales director. A task giver without a Staff
// record keeps the old role rule (roles.js taskAssigneeRoles) until they are added there.
async function assigneeSql(user, params) {
  if (tasksAnyone(user.role)) return "TRUE";
  if (!canCreateTasks(user.role)) return "FALSE";
  const conds = [];
  if (sendsRequests(user.role)) conds.push("u.role = 'sales_director'");
  const { rows } = await pool.query("SELECT 1 FROM staff_members WHERE user_id = $1", [user.id]);
  if (rows.length) {
    params.push(user.id);
    conds.push(`u.id IN ${subordinatesSql(`$${params.length}`)}`);
  } else if (!sendsRequests(user.role)) {
    const roles = taskAssigneeRoles(user.role);
    if (roles === null) conds.push("TRUE");
    else if (roles.length) {
      params.push(roles);
      conds.push(`u.role = ANY($${params.length})`);
    }
  }
  return conds.length ? `(${conds.join(" OR ")})` : "FALSE";
}

const TASK_SELECT = `
  SELECT t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, to_char(t.promise_date, 'YYYY-MM-DD') AS promise_date,
         -- automatic tasks are Vaghinak's (owner, 2026-10-14): they show him as the creator
         CASE WHEN t.auto_kind IS NOT NULL THEN 'Վաղինակ' ELSE cu.name END AS creator_name, au.name AS assignee_name, au.role AS assignee_role, c.name AS customer_name, c.phone AS customer_phone,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'text', i.text, 'done', i.done) ORDER BY i.sort_order, i.id)
                   FROM task_items i WHERE i.task_id = t.id), '[]'::json) AS items
  FROM tasks t
  JOIN users cu ON cu.id = t.creator_id
  JOIN users au ON au.id = t.assignee_id
  LEFT JOIN customers c ON c.id = t.customer_id`;

async function loadTask(id, user) {
  const params = [id];
  const vis = visibilitySql(user, params);
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND ${vis}`, params);
  return rows[0] ?? null;
}

function cleanItems(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of raw) {
    const text = String(typeof it === "string" ? it : it?.text ?? "").trim().slice(0, 300);
    if (!text) continue;
    items.push({ id: typeof it === "object" && isId(it?.id) ? Number(it.id) : null, text });
  }
  return items;
}

async function assigneeAllowed(creator, assigneeId) {
  const params = [assigneeId];
  const where = await assigneeSql(creator, params);
  const { rows } = await pool.query(`SELECT 1 FROM users u WHERE u.id = $1 AND ${where}`, params);
  return rows.length > 0;
}

// Who the caller may assign to (for the "assign to" picker).
tasksRouter.get("/assignees", async (req, res) => {
  const params = [];
  const where = await assigneeSql(req.user, params);
  if (where === "FALSE") return res.json([]);
  const { rows } = await pool.query(`SELECT u.id, u.name, u.role, u.position FROM users u WHERE u.status = 'active' AND ${where} ORDER BY u.name`, params);
  res.json(rows);
});

// Customers that currently have an open task visible to the caller, for the
// Map pin marker: yellow = not due yet, red = due today or overdue.
tasksRouter.get("/customer-flags", async (req, res) => {
  const params = [yerevanToday()];
  const vis = visibilitySql(req.user, params);
  const { rows } = await pool.query(
    `SELECT t.customer_id, bool_or(t.due_date <= $1::date) AS due, count(*)::int AS task_count
     FROM tasks t WHERE t.status = 'open' AND t.customer_id IS NOT NULL AND ${vis}
     GROUP BY t.customer_id`,
    params
  );
  res.json(rows);
});

// scope: mine (assigned to me, default) | created (by me) | all (everything I may see)
// status: open (default) | done | cancelled | all;   due=today -> due today or earlier
tasksRouter.get("/", async (req, res) => {
  const { scope = "mine", status = "open", due, customer_id } = req.query;
  const params = [];
  const conditions = [visibilitySql(req.user, params)];
  if (scope === "mine") {
    params.push(req.user.id);
    conditions.push(`t.assignee_id = $${params.length}`);
  } else if (scope === "created") {
    params.push(req.user.id);
    conditions.push(`t.creator_id = $${params.length}`);
  }
  if (["open", "done", "cancelled"].includes(status)) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (due === "today") {
    params.push(yerevanToday());
    conditions.push(`t.due_date <= $${params.length}::date`);
  }
  if (customer_id && isId(customer_id)) {
    params.push(Number(customer_id));
    conditions.push(`t.customer_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${TASK_SELECT} WHERE ${conditions.join(" AND ")}
     ORDER BY (t.status = 'open') DESC, t.due_date ASC, t.id DESC LIMIT 500`,
    params
  );
  res.json({ rows, today: yerevanToday() });
});

tasksRouter.get("/:id", async (req, res, next) => {
  if (!isId(req.params.id)) return next();
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  // A call task also shows how the earlier calls to this customer went.
  let calls = [];
  if (task.customer_id && (task.task_kind === "call_customer" || task.auto_kind)) {
    ({ rows: calls } = await pool.query(
      `SELECT cc.id, cc.result, cc.note, to_char(cc.callback_date, 'YYYY-MM-DD') AS callback_date, cc.created_at, u.name AS user_name
       FROM customer_calls cc LEFT JOIN users u ON u.id = cc.user_id WHERE cc.customer_id = $1 ORDER BY cc.created_at DESC LIMIT 5`,
      [task.customer_id]
    ));
  }
  res.json({ ...task, calls, today: yerevanToday() });
});

tasksRouter.post("/", async (req, res) => {
  if (!canCreateTasks(req.user.role)) return res.status(403).json({ error: "Only management can create tasks" });
  const { title, assignee_id, customer_id, due_date, due_is_next_visit } = req.body ?? {};
  const taskKind = req.body?.task_kind === undefined || req.body.task_kind === null || req.body.task_kind === "" ? null : String(req.body.task_kind);
  if (taskKind !== null && !TASK_KINDS.includes(taskKind)) return res.status(400).json({ error: "Unknown task type" });
  if (taskKind !== null && (customer_id === undefined || customer_id === null || customer_id === "")) {
    return res.status(400).json({ error: "This type of task needs a customer" });
  }
  const items = cleanItems(req.body?.items);
  const text = String(title ?? "").trim().slice(0, 160);
  if (!text) return res.status(400).json({ error: "A task title is required" });
  if (!isId(assignee_id)) return res.status(400).json({ error: "Choose who the task is for" });
  if (!isDate(due_date)) return res.status(400).json({ error: "A deadline (YYYY-MM-DD) is required" });
  if (items === null) return res.status(400).json({ error: `At most ${MAX_ITEMS} checklist items` });
  if (!(await assigneeAllowed(req.user, Number(assignee_id)))) {
    return res.status(403).json({ error: "You cannot give a task to this person" });
  }
  let customerId = null;
  let customerName = null;
  if (customer_id !== undefined && customer_id !== null && customer_id !== "") {
    if (!isId(customer_id)) return res.status(400).json({ error: "Invalid customer" });
    const { rows } = await pool.query("SELECT id, name FROM customers WHERE id = $1", [Number(customer_id)]);
    if (!rows[0]) return res.status(400).json({ error: "Customer not found" });
    customerId = rows[0].id;
    customerName = rows[0].name;
  }

  const client = await pool.connect();
  let taskId;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, task_kind, is_request)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [text, req.user.id, Number(assignee_id), customerId, due_date, due_is_next_visit === true, taskKind, sendsRequests(req.user.role)]
    );
    taskId = rows[0].id;
    let order = 0;
    for (const it of items ?? []) {
      await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [taskId, it.text, order++]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (Number(assignee_id) !== req.user.id) {
    notifyUser(Number(assignee_id), "task_assigned", {
      title: `${sendsRequests(req.user.role) ? "Նոր խնդրանք" : "Նոր առաջադրանք"}՝ ${text}`,
      body: `${req.user.name}${customerName ? ` · ${customerName}` : ""} · ժամկետ՝ ${due_date}`,
      url: `/#/tasks?open=${taskId}`,
    }).catch((err) => console.error("Task notification failed:", err.message));
  }
  res.status(201).json(await loadTask(taskId, req.user));
});

// Creator (or anyone who sees all tasks) edits / cancels / reopens; checklist
// items can be added, renamed or removed (items sent with an id keep their
// done state).
tasksRouter.patch("/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  const locked = taskClosesItself(task);
  const cancelling = req.body?.status === "cancelled";
  // A self-closing task: management above the sales manager may cancel it (reason required), whoever gave it, and only that
  const mayCancelLocked = locked && cancelling && canCancelSelfClosingTask(req.user.role) && Object.keys(req.body).every((k) => k === "status" || k === "reason");
  const mayEdit = task.creator_id === req.user.id || seesAllTasks(req.user.role) || mayCancelLocked;
  if (!mayEdit) return res.status(403).json({ error: "Only the creator can edit this task" });
  if (locked && cancelling && !canCancelSelfClosingTask(req.user.role)) return res.status(403).json({ error: "Only management can cancel this task" });
  const cancelReason = String(req.body?.reason ?? "").trim().slice(0, 300);
  if (locked && cancelling && task.status === "open" && cancelReason.length < 3) return res.status(400).json({ error: "A reason is required to cancel this task", code: "reason_required" });

  const { title, assignee_id, customer_id, due_date, status, due_is_next_visit } = req.body ?? {};
  const items = cleanItems(req.body?.items);
  const sets = [];
  const params = [task.id];
  const add = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (title !== undefined) {
    const text = String(title).trim().slice(0, 160);
    if (!text) return res.status(400).json({ error: "A task title is required" });
    add("title", text);
  }
  if (due_date !== undefined) {
    if (!isDate(due_date)) return res.status(400).json({ error: "Invalid deadline" });
    add("due_date", due_date);
    add("deadline_reminder_sent_on", null);
  }
  if (due_is_next_visit !== undefined) add("due_is_next_visit", due_is_next_visit === true);
  let newAssignee = null;
  if (assignee_id !== undefined && Number(assignee_id) !== task.assignee_id) {
    if (!isId(assignee_id) || !(await assigneeAllowed(req.user, Number(assignee_id)))) {
      return res.status(403).json({ error: "You cannot give a task to this person" });
    }
    add("assignee_id", Number(assignee_id));
    add("deadline_reminder_sent_on", null);
    newAssignee = Number(assignee_id);
  }
  if (customer_id !== undefined) {
    if (customer_id === null || customer_id === "") add("customer_id", null);
    else {
      const { rows } = await pool.query("SELECT id FROM customers WHERE id = $1", [Number(customer_id)]);
      if (!rows[0]) return res.status(400).json({ error: "Customer not found" });
      add("customer_id", rows[0].id);
    }
  }
  if (status !== undefined) {
    if (!["open", "cancelled"].includes(status)) return res.status(400).json({ error: "Status can be set to open or cancelled" });
    add("status", status);
    if (locked && status === "cancelled") add("completion_note", `Չեղարկված է՝ ${cancelReason}`);
    if (status === "open") {
      add("completed_at", null);
      add("completed_by", null);
    }
  }
  if (items === null) return res.status(400).json({ error: `At most ${MAX_ITEMS} checklist items` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (sets.length) await client.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
    if (items !== undefined) {
      const keep = items.filter((i) => i.id).map((i) => i.id);
      await client.query("DELETE FROM task_items WHERE task_id = $1 AND NOT (id = ANY($2::int[]))", [task.id, keep]);
      let order = 0;
      for (const it of items) {
        if (it.id) await client.query("UPDATE task_items SET text = $3, sort_order = $4 WHERE id = $1 AND task_id = $2", [it.id, task.id, it.text, order++]);
        else await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [task.id, it.text, order++]);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (newAssignee && newAssignee !== req.user.id) {
    notifyUser(newAssignee, "task_assigned", {
      title: `${task.is_request ? "Նոր խնդրանք" : "Նոր առաջադրանք"}՝ ${task.title}`,
      body: `${req.user.name} · ժամկետ՝ ${due_date ?? task.due_date}`,
      url: `/#/tasks?open=${task.id}`,
    }).catch(() => {});
  }
  res.json(await loadTask(task.id, req.user));
});

// Marks a task finished: by the assignee (the normal case), its creator or
// anyone who sees all tasks. The creator is told.
async function finishTask(task, user, note, outcome = null, promiseDate = null) {
  await pool.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), completed_by = $2, completion_note = $3, outcome = $4, promise_date = $5, updated_at = now() WHERE id = $1`,
    [task.id, user.id, note || null, outcome, promiseDate]
  );
  if (task.creator_id !== user.id && !task.auto_kind) {
    notifyUser(task.creator_id, "task_completed", {
      title: `${task.is_request ? "Խնդրանքը կատարված է" : "Առաջադրանքը կատարված է"}՝ ${task.title}`,
      body: `${user.name}${task.customer_name ? ` · ${task.customer_name}` : ""}${note ? ` · ${note}` : ""}`,
      url: `/#/tasks?open=${task.id}`,
    }).catch(() => {});
  }
}

function mayWork(task, user) {
  return task.assignee_id === user.id || task.creator_id === user.id || seesAllTasks(user.role);
}

// What the customer said about paying: { outcome, promiseDate } or { outcome: null, promiseDate: "bad_date" | null } when it is not valid.
function parseDebtResult(body, allowed) {
  const outcome = String(body?.outcome ?? "");
  if (!allowed.includes(outcome)) return { outcome: null, promiseDate: null };
  if (outcome !== "promised") return { outcome, promiseDate: null };
  const promiseDate = String(body?.promise_date ?? "");
  const limit = new Date(`${yerevanToday()}T00:00:00Z`).getTime() + MAX_PROMISE_DAYS * 86400000;
  if (!isDate(promiseDate) || promiseDate <= yerevanToday() || new Date(`${promiseDate}T00:00:00Z`).getTime() > limit) return { outcome: null, promiseDate: "bad_date" };
  return { outcome, promiseDate };
}

// The result is kept on the OPEN task (a promise moves its deadline to the promised date and keeps new reminders away until it passes).
async function saveDebtResult(task, outcome, promiseDate, note) {
  await pool.query(
    `UPDATE tasks SET outcome = $2, promise_date = $3, completion_note = $4,
       due_date = COALESCE($3::date, due_date), due_is_next_visit = CASE WHEN $3::date IS NULL THEN due_is_next_visit ELSE false END,
       deadline_reminder_sent_on = CASE WHEN $3::date IS NULL THEN deadline_reminder_sent_on ELSE NULL END, updated_at = now() WHERE id = $1`,
    [task.id, outcome, promiseDate, note || null]
  );
}

// "Record result" on a collect-the-debt task (owner, 2026-11-05): the customer promised a date / did not answer / refused. The task
// stays open: only a recorded payment closes it (taskAutoComplete.js).
tasksRouter.post("/:id/record-result", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status !== "open") return res.status(409).json({ error: "This task is not open" });
  if (!(task.auto_kind === "debt_collection" || task.task_kind === "collect_debt")) return res.status(400).json({ error: "Only a collect-the-debt task takes a collection result" });
  const { outcome, promiseDate } = parseDebtResult(req.body, DEBT_RESULTS_OPEN);
  if (!outcome) return res.status(400).json({ error: promiseDate === "bad_date" ? `A promised date after today (within ${MAX_PROMISE_DAYS} days) is required` : "Choose how the collection went" });
  await saveDebtResult(task, outcome, promiseDate, String(req.body?.note ?? "").trim().slice(0, 500));
  res.json(await loadTask(task.id, req.user));
});

tasksRouter.post("/:id/complete", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status !== "open") return res.status(409).json({ error: "This task is not open" });
  if (taskClosesItself(task)) return res.status(409).json(CLOSES_ITSELF_ERROR);
  // (A collect-the-debt task never gets here: it closes by itself when a payment is recorded; see recordDebtResult below.)
  await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [task.id]);
  await finishTask(task, req.user, String(req.body?.note ?? "").trim().slice(0, 500));
  res.json(await loadTask(task.id, req.user));
});

// The result of a call made from a call task (owner, 2026-10-18): spoke (closes the task; a debt task also needs how the
// collection went), no answer / wrong number (the task stays open), call back later (the task moves to that date).
// Every result is also a history line on the customer (customer_calls).
tasksRouter.post("/:id/call-result", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status !== "open") return res.status(409).json({ error: "This task is not open" });
  if (!task.customer_id) return res.status(400).json({ error: "This task has no customer" });
  const result = String(req.body?.result ?? "");
  if (!CALL_RESULTS.includes(result)) return res.status(400).json({ error: "Choose how the call went" });
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  let callbackDate = null;
  if (result === "call_back") {
    callbackDate = String(req.body?.callback_date ?? "");
    if (!isDate(callbackDate) || callbackDate < yerevanToday()) return res.status(400).json({ error: "A call-back date (today or later) is required" });
  }
  let outcome = null;
  let promiseDate = null;
  const isDebtTask = task.auto_kind === "debt_collection" || task.task_kind === "collect_debt";
  if (result === "spoke" && isDebtTask) {
    // He spoke to the customer: what the customer said is recorded, the task stays open until a payment closes it
    ({ outcome, promiseDate } = parseDebtResult(req.body, ["promised", "refused"]));
    if (!outcome) return res.status(400).json({ error: promiseDate === "bad_date" ? `A promised date after today (within ${MAX_PROMISE_DAYS} days) is required` : "Choose how the collection went" });
  }
  await pool.query("INSERT INTO customer_calls (customer_id, task_id, user_id, result, note, callback_date) VALUES ($1, $2, $3, $4, $5, $6)", [
    task.customer_id, task.id, req.user.id, result, note || null, callbackDate,
  ]);
  if (result === "spoke" && isDebtTask) {
    await saveDebtResult(task, outcome, promiseDate, note ? `Խոսել է հաճախորդի հետ · ${note}` : "Խոսել է հաճախորդի հետ");
  } else if (result === "spoke") {
    await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [task.id]);
    await finishTask(task, req.user, note ? `Խոսել է հաճախորդի հետ · ${note}` : "Խոսել է հաճախորդի հետ");
  } else if (result === "call_back") {
    await pool.query("UPDATE tasks SET due_date = $2, due_is_next_visit = false, deadline_reminder_sent_on = NULL, updated_at = now() WHERE id = $1", [task.id, callbackDate]);
  }
  res.json(await loadTask(task.id, req.user));
});

tasksRouter.post("/:id/reopen", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status !== "done") return res.status(409).json({ error: "Only a finished task can be reopened" });
  await pool.query(`UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = now() WHERE id = $1`, [task.id]);
  res.json(await loadTask(task.id, req.user));
});

// Tick / untick one checklist item. Ticking the last open item completes the
// task; unticking an item of a finished task reopens it.
tasksRouter.post("/:id/items/:itemId", async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.itemId)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status === "cancelled") return res.status(409).json({ error: "This task was cancelled" });
  const done = req.body?.done !== false;
  const { rowCount } = await pool.query(
    "UPDATE task_items SET done = $3, done_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND task_id = $2",
    [Number(req.params.itemId), task.id, done]
  );
  if (!rowCount) return res.status(404).json({ error: "Item not found" });
  const { rows } = await pool.query("SELECT bool_and(done) AS all_done, count(*)::int AS n FROM task_items WHERE task_id = $1", [task.id]);
  // a self-closing task is never finished by its checklist: only the work itself closes it
  if (task.status === "open" && rows[0].n > 0 && rows[0].all_done && !taskClosesItself(task)) await finishTask(task, req.user, "");
  else if (task.status === "done" && !done) {
    await pool.query(`UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = now() WHERE id = $1`, [task.id]);
  }
  res.json(await loadTask(task.id, req.user));
});
