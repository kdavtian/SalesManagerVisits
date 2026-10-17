// Automatic tasks close themselves when the rep does what they ask (owner, 2026-10-12):
//  - "Հավաքագրիր պարտքը" (debt_collection): money was collected for that customer (a check-in with
//    "payment collected", or a payment recorded in the Payments tab). Any amount counts: the outcome is
//    `paid` when it covers the Excel debt, else `partial` (the 14-day cooldown / next ERP sync decides
//    whether a new task is needed for the rest);
//  - "call or visit, he stopped ordering" (reorder_followup): an order was made for that customer.
// The assignee is told ("task completed automatically"), also when they did it themselves.
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";

const amd = (n) => `${Math.round(Number(n)).toLocaleString("en-US")} դր.`;

// `kind` = the automatic task kind; `taskKind` = the matching type a person can give (migration 125) -- both close.
async function closeTasks(kind, taskKind, { customerId, actorId, note, outcome = null, body, onlyAssignee = null }) {
  const { rows } = await pool.query(
    `UPDATE tasks t SET status = 'done', completed_at = now(), completed_by = $3, completion_note = $4, outcome = $5, updated_at = now()
     FROM customers c
     WHERE t.customer_id = $1 AND (t.auto_kind = $2 OR t.task_kind = $6) AND t.status = 'open' AND c.id = t.customer_id
       AND ($7::int IS NULL OR t.assignee_id = $7)
     RETURNING t.id, t.title, t.assignee_id, t.creator_id, t.auto_kind, c.name AS customer_name`,
    [customerId, kind, actorId, note, outcome, taskKind, onlyAssignee]
  );
  for (const task of rows) {
    // The person who gave the task hears that it is done (automatic tasks have no person behind them).
    if (!task.auto_kind && task.creator_id !== actorId && task.creator_id !== task.assignee_id) {
      await notifyUser(task.creator_id, "task_completed", {
        title: `Առաջադրանքը կատարված է՝ ${task.title}`,
        body: `${task.customer_name} · ${body}`,
        url: `/#/tasks?open=${task.id}`,
      }).catch((err) => console.error("Auto-complete creator notification failed:", err.message));
    }
    await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [task.id]);
    await notifyUser(task.assignee_id, "task_completed", {
      title: "Առաջադրանքը ավտոմատ կատարվեց",
      body: `${task.customer_name} · ${body}`,
      url: `/#/tasks?open=${task.id}`,
    }).catch((err) => console.error("Auto-complete notification failed:", err.message));
  }
  return rows.length;
}

// Money was collected from the customer: closes their open debt-collection task.
export async function autoCompleteCollectionTasks({ customerId, actorId, amountAmd }) {
  const amount = Number(amountAmd);
  if (!(amount > 0)) return 0;
  const { rows } = await pool.query(
    "SELECT COALESCE(erp.debt_amd, 0) AS debt FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id WHERE c.id = $1",
    [customerId]
  );
  const debt = Number(rows[0]?.debt ?? 0);
  const outcome = debt > 0 && amount < debt - 1 ? "partial" : "paid";
  return closeTasks("debt_collection", "collect_debt", {
    customerId,
    actorId,
    outcome,
    note: `Ավտոմատ՝ հավաքագրվել է ${amd(amount)}`,
    body: `հավաքագրվել է ${amd(amount)}${outcome === "partial" ? " (մասնակի)" : ""}`,
  });
}

// An order (not a draft) was made for the customer: closes their open "stopped ordering" task.
export async function autoCompleteReorderTasks({ customerId, actorId, orderCode }) {
  return closeTasks("reorder_followup", "make_order", {
    customerId,
    actorId,
    note: `Ավտոմատ՝ պատվեր է ձևակերպվել${orderCode ? ` (${orderCode})` : ""}`,
    body: `պատվեր է ձևակերպվել${orderCode ? ` (${orderCode})` : ""}`,
  });
}

// A check-in recorded which brands the shop has (the "products at this shop" chips or the available products): closes the
// customer's open "check products" task. (No automatic kind behind it: the type exists only as a person's task.)
export async function autoCompleteProductCheckTasks({ customerId, actorId }) {
  return closeTasks(null, "check_products", {
    customerId,
    actorId,
    note: "Ավտոմատ՝ այցի ժամանակ ապրանքները ստուգվել են",
    body: "այցի ժամանակ ապրանքները ստուգվել են",
  });
}

// The rep checked in at the customer: closes the "Visit" task given to THAT rep.
export async function autoCompleteVisitTasks({ customerId, actorId }) {
  return closeTasks(null, "visit_customer", {
    customerId,
    actorId,
    onlyAssignee: actorId,
    note: "Ավտոմատ՝ այցը կատարվել է",
    body: "այցը կատարվել է",
  });
}
