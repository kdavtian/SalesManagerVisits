// Stock count (Գույքագրում), owner 2026-10-30: "the system should divide the products into working days so that the warehouse manager
// counts the stock every single day; have planning for him and he should complete plans daily". Decided with the owner:
//  - every ACTIVE product is counted once a month; the month's products are split evenly over its working days (Mon-Sat, company
//    holidays skipped), in shelf order (brand, family, name, size), so a day's list is one walk along the shelves;
//  - a product not counted on its day moves to the next working day, and that day is "not finished";
//  - a counted quantity that differs from the Excel stock is reported to the CEO / admin (and in Vaghinak's evening digest) and becomes
//    ONE task for the accountant per day, one checklist line per product;
//  - the counter counts blind: he does not see the Excel number before the day is closed (seesStockCountExpected).
// A day is closed by "Finish the day" or automatically in the evening (closeOpenDays, from the job scheduler).
// The very first plan (the month the feature is deployed in) leaves out the products whose day has already passed: they are counted
// from the next month on, so the daily amount stays the same instead of piling the whole month into its last days.
import { pool } from "../db/pool.js";
import { yerevanToday, yerevanMonthStart } from "../utils/yerevanDate.js";
import { notifyUser } from "../shared/notifications.js";
import { yerevanMinutesOfDay } from "../team/taskReminders.js";

export const AUTO_CLOSE_MIN = 20 * 60; // 20:00 Yerevan: an unclosed day is closed automatically
const PLAN_RECHECK_MS = 10 * 60 * 1000; // new / reactivated products are added to the plan at most every 10 minutes
const planChecked = new Map(); // month -> time of the last check (per process; the check itself is idempotent)

const monthOf = (day) => `${day.slice(0, 7)}-01`;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dateText = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** The working days ("YYYY-MM-DD") of the month that `month` ("YYYY-MM-01") starts. */
export async function workingDaysOfMonth(db, month) {
  const { rows } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series($1::date, ($1::date + interval '1 month' - interval '1 day')::date, interval '1 day') d
     WHERE extract(isodow FROM d) <> 7 AND NOT EXISTS (SELECT 1 FROM company_holidays h WHERE h.holiday_date = d::date)
     ORDER BY d`,
    [month]
  );
  return rows.map((r) => r.day);
}

/** Pure: product i of n goes to working day floor(i * days / n), so every day gets the same share (+-1) in shelf order. */
export function spreadOverDays(productIds, days) {
  const n = productIds.length;
  return productIds.map((id, i) => ({ product_id: id, planned_date: days[Math.floor((i * days.length) / n)] }));
}

/** The next working day after `day` (looks up to 2 weeks ahead). */
export async function nextWorkingDay(db, day) {
  const { rows } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series($1::date + 1, $1::date + 14, interval '1 day') d
     WHERE extract(isodow FROM d) <> 7 AND NOT EXISTS (SELECT 1 FROM company_holidays h WHERE h.holiday_date = d::date)
     ORDER BY d LIMIT 1`,
    [day]
  );
  return rows[0]?.day ?? addDays(day, 1);
}

// Puts every active product that has no row this month into the plan. A fresh month is spread over all its working days; a product that
// turns up mid-month (new in Excel, made active again) goes to the remaining working day with the fewest products.
export async function ensurePlan(db, today = yerevanToday(), { force = false } = {}) {
  const month = monthOf(today);
  const last = planChecked.get(month);
  if (!force && last && Date.now() - last < PLAN_RECHECK_MS) return 0;
  planChecked.set(month, Date.now());
  const { rows: missing } = await db.query(
    `SELECT p.id FROM products p
     WHERE p.active AND NOT EXISTS (SELECT 1 FROM stock_counts s WHERE s.month = $1 AND s.product_id = p.id)
     ORDER BY lower(COALESCE(p.brand, '')), lower(COALESCE(p.family, '')), lower(p.name), lower(COALESCE(p.unit, '')), p.id`,
    [month]
  );
  if (!missing.length) return 0;
  const days = await workingDaysOfMonth(db, month);
  if (!days.length) return 0;
  const { rows: [state] } = await db.query(
    "SELECT EXISTS (SELECT 1 FROM stock_counts WHERE month = $1) AS has_month, EXISTS (SELECT 1 FROM stock_counts WHERE month < $1) AS has_earlier",
    [month]
  );
  let plan;
  if (!state.has_month) {
    plan = spreadOverDays(missing.map((r) => r.id), days);
    // the very first plan: the days already gone are not piled onto the rest of the month
    if (!state.has_earlier) plan = plan.filter((p) => p.planned_date >= today);
  } else {
    const remaining = days.filter((d) => d >= today);
    if (!remaining.length) return 0;
    const { rows: load } = await db.query(
      "SELECT to_char(planned_date, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM stock_counts WHERE month = $1 AND planned_date >= $2 GROUP BY planned_date",
      [month, today]
    );
    const count = new Map(remaining.map((d) => [d, 0]));
    for (const r of load) if (count.has(r.day)) count.set(r.day, r.n);
    plan = missing.map((r) => {
      let best = remaining[0];
      for (const d of remaining) if (count.get(d) < count.get(best)) best = d;
      count.set(best, count.get(best) + 1);
      return { product_id: r.id, planned_date: best };
    });
  }
  if (!plan.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO stock_counts (month, product_id, planned_date)
     SELECT $1, x.product_id, x.planned_date FROM unnest($2::int[], $3::date[]) AS x(product_id, planned_date)
     ON CONFLICT (month, product_id) DO NOTHING`,
    [month, plan.map((p) => p.product_id), plan.map((p) => p.planned_date)]
  );
  return rowCount;
}

async function closedDay(db, day) {
  const { rows } = await db.query("SELECT day, planned, counted, differences, left_over, finished_at, finished_by, task_id FROM stock_count_days WHERE day = $1", [day]);
  return rows[0] ?? null;
}

/** The numbers of `day`: due (its plan + carried over to it, minus what was counted earlier), counted that day, left, differences. */
export async function dayNumbers(db, day) {
  const { rows: [n] } = await db.query(
    `SELECT count(*) FILTER (WHERE s.planned_date <= $2 AND (s.counted_at IS NULL OR s.counted_day = $2))::int AS due,
            count(*) FILTER (WHERE s.planned_date = $2)::int AS own,
            count(*) FILTER (WHERE s.planned_date < $2 AND (s.counted_at IS NULL OR s.counted_day = $2))::int AS carried,
            count(*) FILTER (WHERE s.counted_day = $2)::int AS counted,
            count(*) FILTER (WHERE s.counted_day = $2 AND s.counted_qty <> COALESCE(s.expected_qty, 0))::int AS differences,
            count(*) FILTER (WHERE s.planned_date <= $2 AND s.counted_at IS NULL)::int AS left_over,
            count(*)::int AS month_total,
            count(*) FILTER (WHERE s.counted_at IS NOT NULL)::int AS month_counted
     FROM stock_counts s JOIN products p ON p.id = s.product_id
     WHERE s.month = $1 AND (p.active OR s.counted_at IS NOT NULL)`,
    [monthOf(day), day]
  );
  return n;
}

/** For the warehouse Home and the digest: today's progress (no product list). */
export async function stockCountToday(db = pool, today = yerevanToday()) {
  await ensurePlan(db, today);
  const [n, closed] = await Promise.all([dayNumbers(db, today), closedDay(db, today)]);
  return { day: today, ...n, finished: Boolean(closed), not_finished: Boolean(closed && closed.left_over > 0) };
}

/** The counting list of `day`: what is due (carried over first) and what was counted that day. */
export async function dayList(db, day, { showExpected }) {
  if (day >= yerevanToday()) await ensurePlan(db, day); // an earlier day is only looked at: new products never go into the past

  const closed = await closedDay(db, day);
  const reveal = showExpected || Boolean(closed);
  const { rows } = await db.query(
    `SELECT s.product_id, p.name, p.brand, p.unit AS size, p.family, to_char(s.planned_date, 'YYYY-MM-DD') AS planned_date,
            s.counted_qty, s.expected_qty, s.counted_at, s.note, s.planned_date < $2 AS carried, p.stock_qty
     FROM stock_counts s JOIN products p ON p.id = s.product_id
     WHERE s.month = $1 AND s.planned_date <= $2 AND (s.counted_day = $2 OR (s.counted_at IS NULL AND p.active))
     ORDER BY s.planned_date, lower(COALESCE(p.brand, '')), lower(COALESCE(p.family, '')), lower(p.name), lower(COALESCE(p.unit, '')), p.id`,
    [monthOf(day), day]
  );
  const items = rows.map((r) => {
    const counted = r.counted_at != null;
    const item = { product_id: r.product_id, name: r.name, brand: r.brand, size: r.size, family: r.family, planned_date: r.planned_date, carried: r.carried, counted, counted_qty: r.counted_qty, note: r.note };
    if (reveal) {
      item.expected_qty = counted ? r.expected_qty : r.stock_qty;
      item.difference = counted ? r.counted_qty - (r.expected_qty ?? 0) : null;
    }
    return item;
  });
  return { day, items, numbers: await dayNumbers(db, day), finished: closed, shows_expected: reveal };
}

/** One product counted (or counted again the same day). The Excel stock of that moment is kept next to it. */
export async function saveCount(db, user, { productId, qty, note }, today = yerevanToday()) {
  if (!Number.isInteger(qty) || qty < 0 || qty > 1_000_000) return { status: 400, error: "Enter a whole number, 0 or more" };
  if (await closedDay(db, today)) return { status: 409, error: "Today's count is already finished" };
  const { rows } = await db.query(
    `UPDATE stock_counts s SET counted_qty = $3, expected_qty = p.stock_qty, counted_at = now(), counted_day = $4, counted_by = $5,
            note = NULLIF(btrim($6), '')
     FROM products p
     WHERE p.id = s.product_id AND s.month = $1 AND s.product_id = $2 AND (s.counted_at IS NULL OR s.counted_day = $4)
     RETURNING s.product_id, s.counted_qty, s.expected_qty`,
    [monthOf(today), productId, qty, today, user.id, String(note ?? "")]
  );
  if (!rows.length) return { status: 404, error: "This product is not in this month's count, or it was counted on an earlier day" };
  return { item: rows[0] };
}

/** Taking a count back (a wrong tap) while the day is open. */
export async function clearCount(db, productId, today = yerevanToday()) {
  if (await closedDay(db, today)) return { status: 409, error: "Today's count is already finished" };
  const { rowCount } = await db.query(
    `UPDATE stock_counts SET counted_qty = NULL, expected_qty = NULL, counted_at = NULL, counted_day = NULL, counted_by = NULL, note = NULL
     WHERE month = $1 AND product_id = $2 AND counted_day = $3`,
    [monthOf(today), productId, today]
  );
  return rowCount ? { ok: true } : { status: 404, error: "Not counted today" };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

// Closes `day`: its numbers are kept, the differences become one task for the accountant and a notice to the CEO / admin.
// `userId` null = closed automatically in the evening. Safe to call twice (the second call does nothing).
export async function closeDay(db, day, userId = null) {
  const before = await closedDay(db, day);
  if (before) return { already: true, day: before };
  const n = await dayNumbers(db, day);
  if (!n.due && !n.counted) return { empty: true };
  const { rows: diffs } = await db.query(
    `SELECT s.id, p.name, p.brand, p.unit AS size, s.counted_qty, COALESCE(s.expected_qty, 0) AS expected_qty, s.note, s.counted_by
     FROM stock_counts s JOIN products p ON p.id = s.product_id
     WHERE s.counted_day = $1 AND s.counted_qty <> COALESCE(s.expected_qty, 0) AND s.reported_at IS NULL
     ORDER BY lower(COALESCE(p.brand, '')), lower(p.name)`,
    [day]
  );
  let taskId = null;
  const notices = []; // sent after the commit, never for a rolled-back close
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: inserted } = await client.query(
      `INSERT INTO stock_count_days (day, planned, counted, differences, left_over, finished_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (day) DO NOTHING RETURNING day`,
      [day, n.due, n.counted, n.differences, n.left_over, userId]
    );
    if (!inserted.length) {
      await client.query("ROLLBACK");
      return { already: true };
    }
    if (diffs.length) {
      const { rows: [accountant] } = await client.query(
        "SELECT id FROM users WHERE role = 'accountant' AND status = 'active' ORDER BY (role_title IS NULL) DESC, id LIMIT 1"
      );
      if (accountant) {
        const creator = userId ?? diffs.find((d) => d.counted_by)?.counted_by ?? accountant.id;
        const due = await nextWorkingDay(client, day);
        const { rows: [task] } = await client.query(
          `INSERT INTO tasks (title, creator_id, assignee_id, due_date) VALUES ($1, $2, $3, $4) RETURNING id`,
          [`Գույքագրում ${dateText(day)}․ ${diffs.length} ապրանքի տարբերություն Excel-ի հետ`, creator, accountant.id, due]
        );
        taskId = task.id;
        let order = 0;
        for (const d of diffs) {
          const text = `${d.name}${d.size ? ` ${d.size}` : ""}․ Excel ${d.expected_qty}, հաշվվել է ${d.counted_qty} (${signed(d.counted_qty - d.expected_qty)})${d.note ? ` — ${d.note}` : ""}`;
          await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [taskId, text, order++]);
        }
        await client.query("UPDATE stock_count_days SET task_id = $2 WHERE day = $1", [day, taskId]);
        notices.push(() =>
          notifyUser(accountant.id, "task_assigned", { title: `Նոր առաջադրանք՝ Գույքագրում ${dateText(day)}`, body: `${diffs.length} ապրանքի տարբերություն`, url: `/#/tasks?open=${taskId}` })
        );
      }
      await client.query("UPDATE stock_counts SET reported_at = now() WHERE id = ANY($1)", [diffs.map((d) => d.id)]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const { rows: bosses } = await db.query("SELECT id FROM users WHERE role IN ('ceo', 'admin') AND status = 'active'");
  const lines = diffs.slice(0, 5).map((d) => `${d.name}${d.size ? ` ${d.size}` : ""} ${signed(d.counted_qty - d.expected_qty)}`);
  const body = [
    `Հաշվվել է ${n.counted}/${n.due}${n.left_over ? ` · ${n.left_over}-ը տեղափոխվեց հաջորդ օր (օրը չի ավարտվել)` : ""}`,
    diffs.length ? `Տարբերություններ՝ ${diffs.length}. ${lines.join(", ")}${diffs.length > 5 ? "…" : ""}` : "Տարբերություններ չկան",
  ].join("\n");
  if (diffs.length || n.left_over) {
    for (const b of bosses) {
      notices.push(() => notifyUser(b.id, "stock_count_diff", { title: `Գույքագրում ${dateText(day)}`, body, url: `/#/stock-count?day=${day}` }));
    }
  }
  for (const send of notices) send().catch((err) => console.error("Stock count notification failed:", err.message));
  return { day: await closedDay(db, day), differences: diffs.length, task_id: taskId };
}

// The evening job: today (after AUTO_CLOSE_MIN) and any earlier working day of the last week that was left open is closed.
export async function closeOpenDays(now = new Date(), db = pool) {
  const today = yerevanToday(now);
  const minutes = yerevanMinutesOfDay(now);
  const { rows } = await db.query(
    `SELECT DISTINCT to_char(s.planned_date, 'YYYY-MM-DD') AS day FROM stock_counts s
     WHERE s.planned_date >= $1::date - 7 AND s.planned_date <= $1 AND NOT EXISTS (SELECT 1 FROM stock_count_days d WHERE d.day = s.planned_date)
     ORDER BY 1`,
    [today]
  );
  let closed = 0;
  for (const { day } of rows) {
    if (day === today && minutes < AUTO_CLOSE_MIN) continue;
    const r = await closeDay(db, day, null);
    if (r.day && !r.already) closed++;
  }
  return { closed };
}

/** The month for management: every working day so far with its numbers, and every difference found. */
export async function monthReport(db, month = yerevanMonthStart(), today = yerevanToday()) {
  const [days, { rows: closed }, { rows: diffs }, totals] = await Promise.all([
    workingDaysOfMonth(db, month),
    db.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, planned, counted, differences, left_over, finished_by IS NULL AS auto, task_id FROM stock_count_days WHERE day >= $1 AND day < ($1::date + interval '1 month')", [month]),
    db.query(
      `SELECT to_char(s.counted_day, 'YYYY-MM-DD') AS day, s.product_id, p.name, p.brand, p.unit AS size, s.counted_qty, COALESCE(s.expected_qty, 0) AS expected_qty,
              s.counted_qty - COALESCE(s.expected_qty, 0) AS difference, s.note, u.name AS counted_by
       FROM stock_counts s JOIN products p ON p.id = s.product_id LEFT JOIN users u ON u.id = s.counted_by
       WHERE s.month = $1 AND s.counted_at IS NOT NULL AND s.counted_qty <> COALESCE(s.expected_qty, 0)
       ORDER BY s.counted_day DESC, lower(p.name)`,
      [month]
    ),
    db.query(
      `SELECT count(*)::int AS total, count(s.counted_at)::int AS counted FROM stock_counts s JOIN products p ON p.id = s.product_id
       WHERE s.month = $1 AND (p.active OR s.counted_at IS NOT NULL)`,
      [month]
    ).then((r) => r.rows[0]),
  ]);
  const byDay = new Map(closed.map((d) => [d.day, d]));
  const { rows: planned } = await db.query("SELECT to_char(planned_date, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM stock_counts WHERE month = $1 GROUP BY planned_date", [month]);
  const plannedBy = new Map(planned.map((r) => [r.day, r.n]));
  const list = [];
  for (const day of days) {
    if (day > today) {
      list.push({ day, state: "future", planned: plannedBy.get(day) ?? 0 });
      continue;
    }
    const c = byDay.get(day);
    if (c) list.push({ day, state: c.left_over ? "not_finished" : "finished", ...c });
    else if (!plannedBy.get(day) && day !== today) list.push({ day, state: "none", planned: 0 }); // before the count started
    else list.push({ day, state: "open", planned: plannedBy.get(day) ?? 0, ...(day === today ? await dayNumbers(db, day) : {}) });
  }
  return { month, totals, days: list, differences: diffs };
}
