// Automatic tasks close themselves when the rep does what they ask (owner, 2026-10-12):
//  - "Հավաքագրիր պարտքը" (debt_collection): money was collected for that customer (a check-in with
//    "payment collected", a payment recorded in the Payments tab, or a bank / card payment of Bank & cash desks). The payments since the
//    task was made must reach MIN(20,000 AMD, the debt before them) (taskPaymentRule.js, owner 2026-11-08): the outcome is `paid` when nothing is left on the live debt, else `partial` (the 14-day cooldown / next ERP sync decides
//    whether a new task is needed for the rest);
//  - "call or visit, he stopped ordering" (reorder_followup): an order was made for that customer.
// The assignee is told ("task completed automatically"), also when they did it themselves.
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { liveDebtMap } from "../money/liveDebt.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { paymentCountsForTask } from "./taskPaymentRule.js";

const amd = (n) => `${Math.round(Number(n)).toLocaleString("en-US")} դր`;

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
  // paid = nothing is left on the LIVE debt (release 5): the payment just recorded is already in it (an app payment the Excel does not
  // have yet); with no Excel figure, the Excel rule (the amount against the debt)
  const { rows } = await pool.query(
    `SELECT c.id, c.erp_customer_id, erp.debt_amd, COALESCE(c.credit_term_days, 45) AS credit_term_days
     FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id WHERE c.id = $1`,
    [customerId]
  );
  const row = rows[0];
  const live = row?.erp_customer_id && row.debt_amd != null ? (await liveDebtMap(pool, [row], yerevanToday())).get(row.id) : null;
  const debt = Number(row?.debt_amd ?? 0);
  // a tiny payment does not close the task (taskPaymentRule.js): at least MIN(20,000, what was owed before this payment). The live debt
  // already contains the payment just recorded, so what was owed before is that plus the payment.
  // Together, not one by one: the customer's app payments since the oldest open collection task was made (two 15,000 payments are 30,000).
  const { rows: sumRows } = await pool.query(
    `SELECT COALESCE(sum(p.amount_amd), 0)::float8 AS paid
     FROM payments p
     WHERE p.customer_id = $1 AND p.status IN ('pending', 'approved') AND NOT COALESCE(p.approved_from_erp, false)
       AND p.created_at >= COALESCE((SELECT min(t.created_at) FROM tasks t
                                       WHERE t.customer_id = $1 AND t.status = 'open' AND (t.auto_kind = 'debt_collection' OR t.task_kind = 'collect_debt')), now())`,
    [customerId]
  );
  const together = Math.max(amount, Number(sumRows[0]?.paid ?? 0));
  const owedBefore = live ? live.debt_amd + together : debt;
  if (!paymentCountsForTask(together, owedBefore)) return 0;
  const outcome = live ? (live.debt_amd > 1 ? "partial" : "paid") : debt > 0 && amount < debt - 1 ? "partial" : "paid";
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

// The rep checked in AT the customer and said why there was no order (stock full / no money / shop closed / other): the visit closes the
// customer's order tasks (the one a person gave and the automatic "stopped ordering"). Order tasks are self-closing: this and a real order
// are the only ways (owner, 2026-11-08).
const NO_ORDER_REASONS = { stock_full: "Պահեստը լիքն է", no_money: "Փող չկա", closed: "Խանութը փակ է", other: "Այլ" };
export async function autoCompleteOrderTasksNoOrder({ customerId, actorId, reason }) {
  const label = NO_ORDER_REASONS[reason];
  if (!label) return 0;
  return closeTasks("reorder_followup", "make_order", {
    customerId,
    actorId,
    onlyAssignee: actorId, // a reason given by one rep says nothing about another rep's task at the same customer
    note: `Ավտոմատ՝ այցի ժամանակ պատվեր չի եղել՝ ${label}`,
    body: `այցի ժամանակ պատվեր չի եղել՝ ${label}`,
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
