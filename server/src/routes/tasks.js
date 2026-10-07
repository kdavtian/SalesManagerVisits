// Task management (migrations/093): management gives a staff member a task
// with a checklist, optionally attached to a customer, due on a date (the
// customer's next visit by default). See roles.js canCreateTasks.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canCreateTasks, seesAllTasks, taskAssigneeRoles } from "../roles.js";
import { notifyUser } from "../notifications.js";
import { yerevanToday } from "../utils/yerevanDate.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const MAX_ITEMS = 30;
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isId = (v) => /^\d+$/.test(String(v));

// Which tasks a user may see at all: management sees all; a sales director sees
// the ones they created, got, or that are for a sales manager; everyone else
// only their own (given to / created by them).
function visibilitySql(user, params) {
  if (seesAllTasks(user.role)) return "TRUE";
  params.push(user.id);
  const me = `$${params.length}`;
  if (user.role === "sales_director") {
    return `(t.creator_id = ${me} OR t.assignee_id = ${me} OR EXISTS (SELECT 1 FROM users au WHERE au.id = t.assignee_id AND au.role = 'sales_manager'))`;
  }
  return `(t.creator_id = ${me} OR t.assignee_id = ${me})`;
}

const TASK_SELECT = `
  SELECT t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
         cu.name AS creator_name, au.name AS assignee_name, au.role AS assignee_role, c.name AS customer_name,
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
  const roles = taskAssigneeRoles(creator.role);
  const { rows } = await pool.query("SELECT id, role FROM users WHERE id = $1", [assigneeId]);
  if (!rows[0]) return false;
  return roles === null || roles.includes(rows[0].role);
}

// Who the caller may assign to (for the "assign to" picker).
tasksRouter.get("/assignees", async (req, res) => {
  const roles = taskAssigneeRoles(req.user.role);
  if (roles !== null && !roles.length) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, name, role, position FROM users ${roles === null ? "" : "WHERE role = ANY($1)"} ORDER BY name`,
    roles === null ? [] : [roles]
  );
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
  res.json({ ...task, today: yerevanToday() });
});

tasksRouter.post("/", async (req, res) => {
  if (!canCreateTasks(req.user.role)) return res.status(403).json({ error: "Only management can create tasks" });
  const { title, assignee_id, customer_id, due_date, due_is_next_visit } = req.body ?? {};
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
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [text, req.user.id, Number(assignee_id), customerId, due_date, due_is_next_visit === true]
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
      title: `Նոր առաջադրանք՝ ${text}`,
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
  const mayEdit = task.creator_id === req.user.id || seesAllTasks(req.user.role);
  if (!mayEdit) return res.status(403).json({ error: "Only the creator can edit this task" });

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
      title: `Նոր առաջադրանք՝ ${task.title}`,
      body: `${req.user.name} · ժամկետ՝ ${due_date ?? task.due_date}`,
      url: `/#/tasks?open=${task.id}`,
    }).catch(() => {});
  }
  res.json(await loadTask(task.id, req.user));
});

// Marks a task finished: by the assignee (the normal case), its creator or
// anyone who sees all tasks. The creator is told.
async function finishTask(task, user, note) {
  await pool.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), completed_by = $2, completion_note = $3, updated_at = now() WHERE id = $1`,
    [task.id, user.id, note || null]
  );
  if (task.creator_id !== user.id) {
    notifyUser(task.creator_id, "task_completed", {
      title: `Առաջադրանքը կատարված է՝ ${task.title}`,
      body: `${user.name}${task.customer_name ? ` · ${task.customer_name}` : ""}${note ? ` · ${note}` : ""}`,
      url: `/#/tasks?open=${task.id}`,
    }).catch(() => {});
  }
}

function mayWork(task, user) {
  return task.assignee_id === user.id || task.creator_id === user.id || seesAllTasks(user.role);
}

tasksRouter.post("/:id/complete", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: "Task not found" });
  const task = await loadTask(Number(req.params.id), req.user);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!mayWork(task, req.user)) return res.status(403).json({ error: "Not allowed" });
  if (task.status !== "open") return res.status(409).json({ error: "This task is not open" });
  await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [task.id]);
  await finishTask(task, req.user, String(req.body?.note ?? "").trim().slice(0, 500));
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
  if (task.status === "open" && rows[0].n > 0 && rows[0].all_done) await finishTask(task, req.user, "");
  else if (task.status === "done" && !done) {
    await pool.query(`UPDATE tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = now() WHERE id = $1`, [task.id]);
  }
  res.json(await loadTask(task.id, req.user));
});
