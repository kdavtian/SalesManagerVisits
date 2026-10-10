// "Deadline today" reminder for open tasks: at 09:30 Yerevan time on the day a
// task is due, its assignee gets one more notification (the first one went out
// when the task was created). Same setInterval-in-the-one-process pattern as
// overdueReminders.js; the "already sent today" marker lives in the database
// (tasks.deadline_reminder_sent_on) so a restart never double-notifies.
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { runAutoTasks } from "./debtCollectionTasks.js";

const CHECK_INTERVAL_MS = 60 * 1000;
const REMINDER_MINUTES = 9 * 60 + 30; // 09:30
const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;

export function yerevanMinutesOfDay(now = new Date()) {
  const d = new Date(now.getTime() + YEREVAN_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export async function sendDeadlineReminders(now = new Date()) {
  if (yerevanMinutesOfDay(now) < REMINDER_MINUTES) return 0;
  const today = yerevanToday(now);
  // Claim first (UPDATE ... RETURNING) so two overlapping runs can't both notify.
  const { rows } = await pool.query(
    `UPDATE tasks SET deadline_reminder_sent_on = $1
     WHERE status = 'open' AND due_date = $1 AND deadline_reminder_sent_on IS DISTINCT FROM $1
     RETURNING id, title, assignee_id, customer_id`,
    [today]
  );
  for (const task of rows) {
    await notifyUser(task.assignee_id, "task_deadline", {
      title: `Այսօր ժամկետն է՝ ${task.title}`,
      body: "Առաջադրանքի վերջնաժամկետը այսօր է։",
      url: `/#/tasks?open=${task.id}`,
    });
  }
  return rows.length;
}

// Automatic tasks (debt collection, reorder follow-up) also run once a day at 09:05 so a
// payment promise that has passed is followed up even when no ERP sync happened that day.
const AUTO_TASKS_MINUTES = 9 * 60 + 5;
let autoTasksDay = null;

export function startTaskReminders() {
  setInterval(() => {
    sendDeadlineReminders().catch((err) => console.error("Task reminder check failed:", err.message));
    const now = new Date();
    const today = yerevanToday(now);
    if (yerevanMinutesOfDay(now) >= AUTO_TASKS_MINUTES && autoTasksDay !== today) {
      autoTasksDay = today;
      runAutoTasks(now).catch((err) => console.error("Automatic tasks failed:", err.message));
    }
  }, CHECK_INTERVAL_MS);
}
