// FULL DAILY DIGEST (owner, 2026-10-29: "start 24/7 analyze what is doing each user and give recommendations and insights from
// Vaghinak" -- "prepare the full digestion and tell it only to CEO and admin"). Every working evening, after the day's wrap-up,
// Vaghinak sends the CEO and the admin ONE message: the company's day in numbers next to its usual level, then every active person
// with what they did today (by what their job is), and what he recommends -- the most important first. Facts only from what the
// app already records (visits, orders and their status changes, payments, cash on hand, tasks, delivery stops, last use of the app).
import { pool } from "../../db/pool.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { getVaghinakSettings } from "./settings.js";
import { createMessage, isWorkingDay, minuteOfDay } from "./engine.js";
import { durationHy } from "./phrases.js";
import { humanDelayPassed } from "./humanDelay.js";
import { bullets } from "../../utils/bullets.js";

export const DIGEST_ROLES = ["ceo", "admin"]; // who receives it (owner: "only to CEO and admin")
// after the end of the work day and the wrap-up (+5 min) and management brief: the day's facts are in
const AFTER_WORK_END_MIN = 20;

const ROLE_HY = {
  ceo: "տնօրեն",
  operations_director: "օպերացիոն տնօրեն",
  sales_director: "վաճառքի տնօրեն",
  financial_director: "ֆինանսական տնօրեն",
  sales_manager: "վաճառքի մենեջեր",
  warehouse_manager: "պահեստապետ",
  delivery_manager: "առաքիչ",
  accountant: "հաշվապահ",
};
const amd = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-US")} դր`;
const firstName = (u) => String(u.name_hy || u.name || "").trim().split(/\s+/)[0] || String(u.name || "");
const local = (col) => `(${col} AT TIME ZONE 'Asia/Yerevan')::date`;

// Everything one person did on `day` (Yerevan date), one row per active person (the CEO and the admins are who it is for: left out).
export async function dayFacts(db, day) {
  const by = (rows) => new Map(rows.map((r) => [r.user_id, r]));
  const q = (sql, params = [day]) => db.query(sql, params).then((r) => by(r.rows));
  const [users, visits, plans, orders, pays, cash, done, overdue, packed, confirmed, stops, approved, recorded] = await Promise.all([
    db.query(`SELECT id, name, name_hy, role, last_seen_at, ${local("last_seen_at")} = $1::date AS seen_today FROM users WHERE status = 'active' AND role <> ALL($2) ORDER BY role, name`, [day, DIGEST_ROLES]).then((r) => r.rows),
    q(`SELECT user_id, count(*)::int AS n, min(timestamp) AS first_at, max(timestamp) AS last_at FROM checkins WHERE ${local("timestamp")} = $1::date GROUP BY user_id`),
    q(`SELECT user_id, planned_count, visited_count, late_minutes, day_off FROM vaghinak_day_log WHERE day = $1::date`),
    q(`SELECT user_id, count(*)::int AS n, COALESCE(sum(total_amd), 0) AS amd FROM orders WHERE ${local("created_at")} = $1::date AND status <> 'draft' AND cancelled_at IS NULL GROUP BY user_id`),
    q(`SELECT sales_manager_id AS user_id, count(*)::int AS n, COALESCE(sum(amount_amd), 0) AS amd FROM payments WHERE ${local("created_at")} = $1::date AND status <> 'rejected' GROUP BY sales_manager_id`),
    // cash still in the person's hands (not handed over, not on its way): how much and since when
    q(`SELECT current_holder_id AS user_id, count(*)::int AS n, COALESCE(sum(amount_amd), 0) AS amd, ($1::date - min(${local("payment_date")}))::int AS days
       FROM payments WHERE current_holder_id IS NOT NULL AND pending_handoff_id IS NULL AND status <> 'rejected' AND ${local("payment_date")} <= $1::date
       GROUP BY current_holder_id`),
    q(`SELECT completed_by AS user_id, count(*)::int AS n FROM tasks WHERE ${local("completed_at")} = $1::date GROUP BY completed_by`),
    q(`SELECT assignee_id AS user_id, count(*)::int AS n FROM tasks WHERE status = 'open' AND due_date < $1::date GROUP BY assignee_id`),
    q(`SELECT changed_by AS user_id, count(*)::int AS n FROM order_status_history WHERE new_status = 'packed_stock_out' AND ${local("changed_at")} = $1::date GROUP BY changed_by`),
    q(`SELECT changed_by AS user_id, count(*)::int AS n FROM order_status_history WHERE new_status = 'confirmed' AND ${local("changed_at")} = $1::date GROUP BY changed_by`),
    q(`SELECT r.driver_id AS user_id, count(*)::int AS total, count(s.completed_at)::int AS done
       FROM delivery_routes r JOIN route_stops s ON s.route_id = r.id WHERE r.route_date = $1::date GROUP BY r.driver_id`),
    q(`SELECT approved_by AS user_id, count(*)::int AS n FROM payments WHERE ${local("approved_at")} = $1::date GROUP BY approved_by`),
    q(`SELECT recorded_by AS user_id, count(*)::int AS n FROM orders WHERE ${local("recorded_at")} = $1::date GROUP BY recorded_by`),
  ]);
  return users.map((u) => ({
    user: u,
    visits: visits.get(u.id) ?? null,
    plan: plans.get(u.id) ?? null,
    orders: orders.get(u.id) ?? null,
    payments: pays.get(u.id) ?? null,
    cash: cash.get(u.id) ?? null,
    tasksDone: done.get(u.id)?.n ?? 0,
    overdue: overdue.get(u.id)?.n ?? 0,
    packed: packed.get(u.id)?.n ?? 0,
    confirmed: confirmed.get(u.id)?.n ?? 0,
    stops: stops.get(u.id) ?? null,
    approved: approved.get(u.id)?.n ?? 0,
    recorded: recorded.get(u.id)?.n ?? 0,
  }));
}

// The company's day next to its usual level: the average of the same figure over the previous 4 weeks' same weekday.
export async function companyTotals(db, day) {
  const sql = (from) => `SELECT
      (SELECT count(*) FROM checkins WHERE ${local("timestamp")} ${from})::int AS visits,
      (SELECT count(*) FROM orders WHERE ${local("created_at")} ${from} AND status <> 'draft' AND cancelled_at IS NULL)::int AS orders,
      (SELECT COALESCE(sum(total_amd), 0) FROM orders WHERE ${local("created_at")} ${from} AND status <> 'draft' AND cancelled_at IS NULL) AS orders_amd,
      (SELECT COALESCE(sum(amount_amd), 0) FROM payments WHERE ${local("created_at")} ${from} AND status <> 'rejected') AS paid_amd`;
  const [today, usual, waiting] = await Promise.all([
    db.query(sql("= $1::date"), [day]).then((r) => r.rows[0]),
    // the same weekday of the 4 weeks before: divided by 4 below
    db.query(sql("IN ($1::date - 7, $1::date - 14, $1::date - 21, $1::date - 28)"), [day]).then((r) => r.rows[0]),
    db.query(
      `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS to_confirm,
              count(*) FILTER (WHERE status = 'confirmed' AND updated_at < now() - interval '1 day')::int AS pack_late,
              (SELECT count(*) FROM payments WHERE status = 'pending')::int AS pay_pending
       FROM orders`
    ).then((r) => r.rows[0]),
  ]);
  const avg = (k) => Math.round(Number(usual[k]) / 4);
  return { today, usual: { visits: avg("visits"), orders: avg("orders"), orders_amd: avg("orders_amd"), paid_amd: avg("paid_amd") }, waiting };
}

// One person's line (what their job made them do today) and Vaghinak's recommendations for them, each with a weight (higher = first).
export function personSummary(f, { graceMin = 15 } = {}) {
  const u = f.user;
  const parts = [];
  const recos = [];
  const role = u.role;
  const field = role === "sales_manager";
  if (field) {
    const planned = f.plan?.planned_count ?? 0;
    const visited = f.visits?.n ?? 0;
    const pct = planned > 0 ? Math.round((Math.min(visited, planned) / planned) * 100) : null;
    parts.push(planned ? `այցեր ${visited}/${planned} (${pct}%)` : `այցեր ${visited}`);
    if (f.plan?.day_off) parts.push("ազատ օր");
    else if (planned > 0 && visited === 0) recos.push({ w: 90, text: "այսօր ոչ մի այց․ զանգահարել և պարզել պատճառը" });
    else if (pct !== null && pct < 50) recos.push({ w: 60, text: `պլանի միայն ${pct}%․ քննարկել երթուղին` });
    if (!f.plan?.day_off && (f.plan?.late_minutes ?? 0) > graceMin) recos.push({ w: 40, text: `ուշ է սկսել (${durationHy(f.plan.late_minutes)})` });
    if (visited >= 3 && !f.orders) recos.push({ w: 35, text: `${visited} այց, բայց ոչ մի պատվեր․ արժե հարցնել՝ ինչու` });
  }
  if (f.orders) parts.push(`պատվերներ ${f.orders.n} · ${amd(f.orders.amd)}`);
  if (f.payments) parts.push(`վճարումներ ${f.payments.n} · ${amd(f.payments.amd)}`);
  if (f.confirmed) parts.push(`հաստատել է ${f.confirmed} պատվեր`);
  if (f.packed) parts.push(`փաթեթավորել է ${f.packed} պատվեր`);
  if (f.stops) {
    parts.push(`առաքում ${f.stops.done}/${f.stops.total}`);
    if (f.stops.done < f.stops.total) recos.push({ w: 70, text: `${f.stops.total - f.stops.done} կանգառ չի ավարտվել` });
  }
  if (f.approved) parts.push(`հաստատել է ${f.approved} վճարում`);
  if (f.recorded) parts.push(`գրանցել է ${f.recorded} պատվեր Excel-ում`);
  if (f.tasksDone) parts.push(`առաջադրանքներ ✓${f.tasksDone}`);
  if (f.cash && Number(f.cash.amd) > 0 && f.cash.days >= 2) recos.push({ w: 80, text: `կանխիկը մոտն է ${f.cash.days} օր (${amd(f.cash.amd)})․ պետք է հանձնել` });
  if (f.overdue >= 3) recos.push({ w: 50, text: `ժամկետանց առաջադրանքներ՝ ${f.overdue}` });
  else if (f.overdue > 0) parts.push(`ժամկետանց առաջադրանքներ ${f.overdue}`);
  if (!u.seen_today) recos.push({ w: field ? 85 : 30, text: "այսօր հավելվածը չի բացել" });
  return { name: firstName(u), fullName: u.name_hy || u.name, role: ROLE_HY[role] ?? role, parts, recos: recos.sort((a, b) => b.w - a.w) };
}

const compare = (now, usual) => (usual > 0 ? ` (սովորականը՝ ${usual.toLocaleString("en-US")}${now >= usual ? "" : " · ավելի քիչ"})` : "");
const compareAmd = (now, usual) => (usual > 0 ? ` (սովորականը՝ ${amd(usual)}${Number(now) >= usual ? "" : " · ավելի քիչ"})` : "");

// The whole message body (Armenian, plain text with bullets): company, then the top recommendations, then everyone.
export function digestBody(facts, totals, opts) {
  const t = totals.today;
  const company = bullets([
    `Այցեր՝ ${t.visits}${compare(t.visits, totals.usual.visits)}`,
    `Պատվերներ՝ ${t.orders} · ${amd(t.orders_amd)}${compareAmd(t.orders_amd, totals.usual.orders_amd)}`,
    `Վճարումներ՝ ${amd(t.paid_amd)}${compareAmd(t.paid_amd, totals.usual.paid_amd)}`,
    ...(totals.waiting.to_confirm ? [`Հաստատման սպասող պատվերներ՝ ${totals.waiting.to_confirm}`] : []),
    ...(totals.waiting.pack_late ? [`Մեկ օրից ավելի փաթեթավորման սպասող պատվերներ՝ ${totals.waiting.pack_late}`] : []),
    ...(totals.waiting.pay_pending ? [`Հաստատման սպասող վճարումներ՝ ${totals.waiting.pay_pending}`] : []),
  ]);
  const people = facts.map((f) => personSummary(f, opts));
  const top = people
    .flatMap((p) => p.recos.map((r) => ({ w: r.w, text: `${p.fullName} — ${r.text}` })))
    .sort((a, b) => b.w - a.w)
    .slice(0, 8)
    .map((r) => r.text);
  const everyone = people
    .filter((p) => p.parts.length || p.recos.length)
    .map((p) => `▸ ${p.fullName} (${p.role}) — ${p.parts.length ? p.parts.join(" · ") : "գործողություն չկա"}${p.recos.length ? `\n   Խորհուրդ՝ ${p.recos.map((r) => r.text).join("; ")}` : ""}`);
  return {
    body: [`Ընկերությունը այսօր՝\n${company}`, top.length ? `Առաջին հերթին՝\n${bullets(top)}` : "Լուրջ խնդիրներ չեմ նկատել։", everyone.length ? `Ըստ աշխատակիցների՝\n${everyone.join("\n")}` : ""].filter(Boolean).join("\n\n"),
    recommendations: top.length,
    people: people.length,
  };
}

export async function fullDigest(now = new Date(), db = pool, { pick, delayMaxMs } = {}) {
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off") return { created: 0 };
  const day = yerevanToday(now);
  const nowMin = minuteOfDay(now);
  if (nowMin < settings.workEndMin + AFTER_WORK_END_MIN || nowMin > 23 * 60) return { created: 0 };
  if (!(await isWorkingDay(db, day))) return { created: 0 };
  const { rows: recipients } = await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE role = ANY($1) AND status = 'active'", [DIGEST_ROLES]);
  if (!recipients.length) return { created: 0 };
  // already sent today to everyone: nothing to compute
  const { rows: sent } = await db.query("SELECT count(*)::int AS n FROM vaghinak_messages WHERE kind = 'full_digest' AND day = $1", [day]);
  if (sent[0].n >= recipients.length) return { created: 0 };
  if (!humanDelayPassed(day, "fulldigest", now, { maxMs: delayMaxMs, pick })) return { created: 0 };
  const [facts, totals] = await Promise.all([dayFacts(db, day), companyTotals(db, day)]);
  const { body } = digestBody(facts, totals, { graceMin: settings.lateGraceMin });
  let created = 0;
  for (const user of recipients) {
    // the day's most important message for them: not held back by the daily message limit, and sent even in test mode
    const m = await createMessage(db, user, { kind: "full_digest", level: 1, day, ctx: { date: day, body }, audience: "management", settings: { ...settings, mode: "live", dailyCap: Infinity }, pick });
    if (m) created++;
  }
  return { created };
}
