// Purchases follow-up (owner, 2026-11-26, roadmap PR 4).
//
// 1. LATE PURCHASES: an Ordered / On the way purchase whose expected date has passed gives a task to the person who entered it (when that
//    person still handles purchases), else to every accountant: "Supplier X is late: ask for the new date and change it in the purchase".
//    Once per expected date (purchase_invoices.late_task_for): when the new date passes too, a new task. (A date moved away and back to the
//    one already told about gives no second task for it.) No accountant: the CEO / admin. Hourly, in working time only
//    (Mon-Sat 09:00-18:00 Yerevan), so nobody gets a task at night.
//    (A receiving DIFFERENCE already gives the accountants a task with every line: purchases.js receivePurchase.)
//
// 2. SUPPLIER SCORECARD, last 12 months, per supplier (supplier names compared the way the Purchases list compares them):
//    - deliveries tracked = purchases received in the app that had an expected date (they went through Ordered / On the way);
//    - on time %          = received on or before the expected date;
//    - average lead days  = received day − the day the purchase was entered;
//    - with differences % = received purchases where some line's counted pieces differ from the invoice;
//    - price change %     = per product bought on at least two days from the supplier in the 12 months: (last day's price − first day's
//                           price) / first day's price, a day's price being the average of its lines weighted by the pieces; the products
//                           weighted by the pieces bought; app purchases received and the Excel Purchase_IN (an Excel invoice the app holds
//                           received is counted once).
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { canManagePurchases } from "../shared/roles.js";
import { SQL_SUPPLIER_KEY } from "./purchases.js";
import { isWarehouseWorkingTime } from "../orders/stalePackedReminder.js";

const fmtDay = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** Gives every late purchase its task (once per expected date). Returns the number of tasks made. `force` skips the working-time check. */
export async function checkLatePurchases(now = new Date(), { db = pool, force = false } = {}) {
  if (!force && !isWarehouseWorkingTime(now)) return 0;
  const { rows: late } = await db.query(
    `SELECT i.id, i.invoice_no, to_char(i.expected_date, 'YYYY-MM-DD') AS expected, i.status, s.name AS supplier, i.created_by, u.role AS creator_role, u.status AS creator_status
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN users u ON u.id = i.created_by
      WHERE i.status IN ('ordered', 'in_transit') AND i.expected_date IS NOT NULL
        AND i.expected_date < (now() AT TIME ZONE 'Asia/Yerevan')::date
        AND i.late_task_for IS DISTINCT FROM i.expected_date
      ORDER BY i.expected_date, i.id LIMIT 100`
  );
  let made = 0;
  for (const inv of late) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // claim it first: two servers (or two runs) never make the same task twice; still late at this moment (the date may just have been
      // moved to a later day), and the task names the date claimed
      const { rows: claimed } = await client.query(
        `UPDATE purchase_invoices SET late_task_for = expected_date
          WHERE id = $1 AND late_task_for IS DISTINCT FROM expected_date AND status IN ('ordered', 'in_transit')
            AND expected_date < (now() AT TIME ZONE 'Asia/Yerevan')::date
          RETURNING to_char(expected_date, 'YYYY-MM-DD') AS expected`,
        [inv.id]
      );
      if (!claimed.length) {
        await client.query("ROLLBACK");
        continue;
      }
      inv.expected = claimed[0].expected;
      const creatorOk = inv.created_by && inv.creator_status === "active" && canManagePurchases(inv.creator_role);
      let assignees = creatorOk
        ? [inv.created_by]
        : (await client.query("SELECT id FROM users WHERE role = 'accountant' AND status = 'active' ORDER BY id")).rows.map((r) => r.id);
      // no accountant: the CEO / admin -- a late purchase is never marked done with nobody told (review 2026-11-26)
      if (!assignees.length) {
        assignees = (await client.query("SELECT id FROM users WHERE role IN ('ceo', 'admin') AND status = 'active' ORDER BY CASE role WHEN 'ceo' THEN 0 ELSE 1 END, id LIMIT 1")).rows.map((r) => r.id);
      }
      if (!assignees.length) {
        await client.query("ROLLBACK"); // nobody to give it to: try again next hour
        continue;
      }
      const { rows: lines } = await client.query(
        "SELECT product_name, brand, qty::float8 AS qty FROM purchase_lines WHERE invoice_id = $1 ORDER BY id LIMIT 6",
        [inv.id]
      );
      const title = `Գնումը ուշանում է՝ ${inv.supplier}${inv.invoice_no ? ` № ${inv.invoice_no}` : ""} (սպասվում էր ${fmtDay(inv.expected)})`.slice(0, 120);
      const items = [
        "Զանգել մատակարարին, ճշտել նոր ամսաթիվը և փոխել այն գնման մեջ",
        ...lines.slice(0, 5).map((l) => `${[l.brand, l.product_name].filter(Boolean).join(" ")}: ${l.qty} հատ`),
      ];
      const created = [];
      for (const a of assignees) {
        const { rows: [t] } = await client.query(
          "INSERT INTO tasks (title, creator_id, assignee_id, due_date, auto_kind) VALUES ($1, $2, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date, 'purchase_late') RETURNING id",
          [title, a]
        );
        for (const [k, text] of items.entries()) await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [t.id, text.slice(0, 300), k]);
        created.push([a, t.id]);
      }
      await client.query("COMMIT");
      made += created.length;
      for (const [a, id] of created) {
        notifyUser(a, "task_assigned", { title: `Նոր առաջադրանք՝ ${title}`.slice(0, 120), body: items[0], url: `/#/tasks?open=${id}` }).catch((err) =>
          console.error("Late purchase notification failed:", err.message)
        );
      }
    } catch (err) {
      // one purchase that fails (its claim is rolled back) never stops the others: it is tried again next hour
      await client.query("ROLLBACK").catch(() => {});
      console.error(`Late purchase ${inv.id} failed:`, err.message);
    } finally {
      client.release();
    }
  }
  return made;
}

/** The scorecard of every supplier of the last 12 months: { [supplier key]: { name, tracked, on_time_pct, avg_lead_days, received, diff_pct, price_change_pct } }. */
export async function supplierScorecard(db = pool) {
  const [{ rows: delivery }, { rows: prices }] = await Promise.all([
    db.query(
      `WITH rec AS (
         SELECT ${SQL_SUPPLIER_KEY("s.name")} AS sk, min(s.name) OVER (PARTITION BY ${SQL_SUPPLIER_KEY("s.name")}) AS name, i.id, i.expected_date,
                (i.arrived_at AT TIME ZONE 'Asia/Yerevan')::date AS arrived_day, (i.created_at AT TIME ZONE 'Asia/Yerevan')::date AS entered_day,
                EXISTS (SELECT 1 FROM purchase_lines l WHERE l.invoice_id = i.id AND l.received_qty IS NOT NULL AND abs(l.received_qty - l.qty) > 0.0005) AS differs,
                EXISTS (SELECT 1 FROM purchase_lines l WHERE l.invoice_id = i.id AND l.received_qty IS NOT NULL) AS counted
           FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.status = 'arrived' AND i.arrived_at IS NOT NULL AND i.arrived_at > now() - interval '365 days')
       SELECT sk, min(name) AS name,
              count(*) FILTER (WHERE expected_date IS NOT NULL)::int AS tracked,
              count(*) FILTER (WHERE expected_date IS NOT NULL AND arrived_day <= expected_date)::int AS on_time,
              avg(arrived_day - entered_day) FILTER (WHERE expected_date IS NOT NULL)::float8 AS avg_lead_days,
              count(*) FILTER (WHERE counted)::int AS received,
              count(*) FILTER (WHERE counted AND differs)::int AS differing
         FROM rec GROUP BY sk`
    ),
    db.query(
      `WITH lines AS (
         SELECT ${SQL_SUPPLIER_KEY("s.name")} AS sk, l.product_id::text AS pk, i.invoice_date AS d, l.cost_usd::float8 AS c, l.qty::float8 AS q
           FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.status = 'arrived' AND l.product_id IS NOT NULL AND l.cost_usd > 0 AND l.qty > 0 AND i.invoice_date > CURRENT_DATE - 365
         UNION ALL
         SELECT ${SQL_SUPPLIER_KEY("e.supplier")}, COALESCE(p.id::text, 'erp:' || e.erp_product_id), e.invoice_date, e.cost_usd::float8, e.qty::float8
           FROM erp_purchase_lines e LEFT JOIN products p ON p.erp_product_id = e.erp_product_id
          WHERE e.erp_product_id IS NOT NULL AND e.cost_usd > 0 AND e.qty > 0 AND e.invoice_date > CURRENT_DATE - 365
            AND NOT EXISTS (SELECT 1 FROM purchase_invoices x WHERE x.status = 'arrived' AND x.invoice_date = e.invoice_date
                             AND lower(regexp_replace(trim(x.invoice_no), '\\s+', ' ', 'g')) = lower(regexp_replace(trim(e.invoice_no), '\\s+', ' ', 'g')))
       ), daily AS (
         -- one price a day per product: the average of that day's lines, weighted by the pieces
         SELECT sk, pk, d, sum(c * q) / sum(q) AS c, sum(q) AS q FROM lines GROUP BY sk, pk, d
       ), per AS (
         SELECT sk, pk, (array_agg(c ORDER BY d))[1] AS first_c, (array_agg(c ORDER BY d DESC))[1] AS last_c, sum(q) AS q, count(*) AS days
           FROM daily GROUP BY sk, pk
       )
       SELECT sk, (sum(q * (last_c - first_c) / first_c) / nullif(sum(q), 0) * 100)::float8 AS price_change_pct, count(*)::int AS products
         FROM per WHERE days >= 2 AND first_c > 0 GROUP BY sk`
    ),
  ]);
  const out = {};
  for (const r of delivery) {
    out[r.sk] = {
      name: r.name,
      tracked: r.tracked,
      on_time_pct: r.tracked ? Math.round((r.on_time / r.tracked) * 100) : null,
      avg_lead_days: r.avg_lead_days == null ? null : Math.round(r.avg_lead_days),
      received: r.received,
      diff_pct: r.received ? Math.round((r.differing / r.received) * 100) : null,
      price_change_pct: null,
      price_products: 0,
    };
  }
  for (const r of prices) {
    out[r.sk] ??= { name: r.sk, tracked: 0, on_time_pct: null, avg_lead_days: null, received: 0, diff_pct: null, price_change_pct: null, price_products: 0 };
    out[r.sk].price_change_pct = r.price_change_pct == null ? null : Math.round(r.price_change_pct * 10) / 10;
    out[r.sk].price_products = r.products;
  }
  return out;
}
