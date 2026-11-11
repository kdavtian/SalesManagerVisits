// "Not in Excel" (owner, 2026-11-11): a delivered app order the Excel still does not show MATCH_WINDOW_DAYS after delivery -- on the Excel's own
// clock (its newest order), so a stopped upload does not flag everything -- stops holding stock (appStock.js) and is flagged, but STAYS
// delivered. The accountant gets one open task listing the flagged orders (enter them in the Excel, or fix the order); the flag and the list
// clear by themselves when the sync finds the order (erp_matched_order_id) or the accountant marks it recorded. Runs with the ops jobs.
import { pool } from "../db/pool.js";
import { createOpsTask, closeOpsTasks, usersWithRole } from "../team/opsTasks.js";
import { DELIVERED_AT, EXCEL_NOW_SQL, MATCH_WINDOW_DAYS } from "./appStock.js";

const KIND = "order_not_in_excel";
const MAX_ITEMS = 60;
const LOOK_BACK_DAYS = 90; // older unmatched deliveries are history (pre-matcher data, closed months): never flagged
const amd = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-US")} դր`;

export async function flagOrdersNotInExcel(db = pool) {
  // the sync found it, the accountant recorded it, or it is no longer a delivery: not a problem any more
  const cleared = await db.query(
    `UPDATE orders SET not_in_excel_at = NULL
     WHERE not_in_excel_at IS NOT NULL AND (erp_matched_order_id IS NOT NULL OR delivered_from_erp OR recorded OR status <> 'delivered' OR cancelled_at IS NOT NULL)`
  );
  const flagged = await db.query(
    `UPDATE orders o SET not_in_excel_at = now()
     WHERE o.not_in_excel_at IS NULL AND o.status = 'delivered' AND o.cancelled_at IS NULL AND NOT o.recorded
       AND o.updated_at > now() - interval '${LOOK_BACK_DAYS} days' -- (a delivery is never later than the order's last change: a cheap pre-filter)
       AND o.erp_matched_order_id IS NULL AND NOT o.delivered_from_erp
       AND ${DELIVERED_AT} <= ${EXCEL_NOW_SQL} - interval '${MATCH_WINDOW_DAYS} days'
       AND ${DELIVERED_AT} > now() - interval '${LOOK_BACK_DAYS} days'`
  );
  const { rows } = await db.query(
    `SELECT o.id, o.order_code, o.total_amd, c.name AS customer_name, to_char(${DELIVERED_AT} AT TIME ZONE 'Asia/Yerevan', 'DD.MM') AS delivered,
            count(*) OVER ()::int AS total
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.not_in_excel_at IS NOT NULL ORDER BY o.not_in_excel_at, o.id LIMIT ${MAX_ITEMS}`
  );
  if (!rows.length) {
    await closeOpsTasks(KIND, "Բոլոր պատվերները Excel-ում են", db);
    return { flagged: flagged.rowCount, cleared: cleared.rowCount, open: 0 };
  }
  const total = rows[0].total;
  const items = rows.map((r) => `${r.order_code ?? `#${r.id}`} · ${r.customer_name ?? ""} · ${r.delivered} · ${amd(r.total_amd)}`);
  if (total > rows.length) items.push(`… և ևս ${total - rows.length}`);
  const title = `Excel-ում չգտնված պատվերներ՝ ${total}․ մուտքագրիր առաքման ամսաթվով կամ նշիր «Գրանցված»`;
  let ids = await usersWithRole("accountant", db);
  if (!ids.length) ids = await usersWithRole("admin", db);
  for (const id of ids) {
    if (await createOpsTask({ kind: KIND, title, assigneeId: id, items, db })) continue;
    // the open task keeps its place; its list follows the flagged orders -- rewritten only when it changed, the ticks of lines still there are
    // kept, in one transaction (a reader never sees an empty list)
    const { rows: open } = await db.query("SELECT id FROM tasks WHERE auto_kind = $1 AND assignee_id = $2 AND status = 'open' LIMIT 1", [KIND, id]);
    if (!open[0]) continue;
    const { rows: current } = await db.query("SELECT text, done FROM task_items WHERE task_id = $1 ORDER BY sort_order, id", [open[0].id]);
    if (current.length === items.length && current.every((c, i) => c.text === items[i].slice(0, 300))) continue;
    const ticked = new Set(current.filter((c) => c.done).map((c) => c.text));
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE tasks SET title = $2, updated_at = now() WHERE id = $1", [open[0].id, title]);
      await client.query("DELETE FROM task_items WHERE task_id = $1", [open[0].id]);
      for (const [i, text] of items.entries()) {
        const line = text.slice(0, 300);
        await client.query("INSERT INTO task_items (task_id, text, sort_order, done, done_at) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END)", [open[0].id, line, i, ticked.has(line)]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return { flagged: flagged.rowCount, cleared: cleared.rowCount, open: total };
}
