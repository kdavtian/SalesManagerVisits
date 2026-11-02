// The daily money board (payments redesign, release 4, owner 2026-11-02: admin, CEO, accountant + an evening Telegram summary): where the
// company's money went on one day, from the screens that move it.
//   collected   cash the reps took (check-in / Payments "+"), per rep
//   counted     hand-overs the sales director (CEO, ops) counted that day, and what was short
//   received    cash that reached the office (hand-overs to the accountant + payments approved directly)
//   bank        bank / card payments of the day (Bank & cash desks)
//   now         cash still in someone's hands (cashCustody.js), open shortfalls, statement lines to check, payments the Excel lacks
import { pool } from "../../db/pool.js";
import { CASH_IN_HAND_SQL } from "../cashCustody.js";
import { getCutover } from "./service.js";

// "on that Yerevan day" as a time range, so the indexes on the time columns are used (not a date computed per row)
const onDay = (col) => `${col} >= ($1::date::timestamp AT TIME ZONE 'Asia/Yerevan') AND ${col} < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Yerevan')`;
const n = (v) => Math.round(Number(v) || 0);

export async function moneyBoard(db = pool, day) {
  const cutover = await getCutover(db);
  const [collected, handoffs, direct, bank, shortToday, shortOpen, inHands, toCheck, notInExcel] = await Promise.all([
    db.query(
      `SELECT p.sales_manager_id AS user_id, COALESCE(u.name, p.sales_manager_name_snapshot) AS name, SUM(p.amount_amd)::float8 AS amd, count(*)::int AS n
       FROM payments p LEFT JOIN users u ON u.id = p.sales_manager_id
       WHERE p.status <> 'rejected' AND ${onDay("p.payment_date")} GROUP BY 1, 2 ORDER BY amd DESC`,
      [day]
    ),
    db.query(
      `SELECT h.id, fu.name AS from_name, tu.name AS to_name, tu.role AS to_role, h.amount_amd::float8 AS amd, COALESCE(h.counted_amd, h.amount_amd)::float8 AS counted
       FROM cash_handoffs h JOIN users fu ON fu.id = h.from_user_id JOIN users tu ON tu.id = h.to_user_id
       WHERE h.status = 'confirmed' AND ${onDay("h.confirmed_at")} ORDER BY h.confirmed_at`,
      [day]
    ),
    db.query(
      `SELECT COALESCE(SUM(p.amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM payment_status_history s JOIN payments p ON p.id = s.payment_id
       WHERE s.new_status = 'approved' AND ${onDay("s.changed_at")} AND COALESCE(s.reason, '') NOT LIKE 'Cash handoff%' AND p.status = 'approved'`,
      [day]
    ),
    db.query(
      `SELECT method, COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM customer_payments
       WHERE method IN ('bank', 'card') AND voided_at IS NULL AND pay_day = $1::date GROUP BY method`,
      [day]
    ),
    db.query(`SELECT COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM cash_shortfalls WHERE ${onDay("created_at")}`, [day]),
    db.query("SELECT COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM cash_shortfalls WHERE status = 'open'"),
    db.query(
      `SELECT u.id AS user_id, u.name, u.role, SUM(p.amount_amd)::float8 AS amd, count(*)::int AS n
       FROM payments p JOIN users u ON u.id = p.current_holder_id
       WHERE ${CASH_IN_HAND_SQL} AND u.role <> 'accountant' GROUP BY u.id, u.name, u.role ORDER BY amd DESC`
    ),
    db.query("SELECT count(*)::int AS n FROM bank_statement_lines WHERE pay_state = 'unspecified'"),
    db.query(
      `SELECT COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM customer_payments
       WHERE voided_at IS NULL AND books_state = 'open' AND pay_day >= $1::date`,
      [cutover]
    ),
  ]);
  const hand = handoffs.rows;
  const toOffice = hand.filter((h) => h.to_role === "accountant");
  const counted = hand.filter((h) => h.to_role !== "accountant");
  const sum = (rows, key = "amd") => rows.reduce((s, r) => s + n(r[key]), 0);
  const bankBy = Object.fromEntries(bank.rows.map((r) => [r.method, { amd: n(r.amd), n: r.n }]));
  return {
    day,
    collected: { amd: sum(collected.rows), n: collected.rows.reduce((s, r) => s + r.n, 0), by_rep: collected.rows.map((r) => ({ name: r.name, amd: n(r.amd), n: r.n })) },
    counted: { amd: sum(counted, "counted"), expected_amd: sum(counted), n: counted.length, items: counted.map((h) => ({ from: h.from_name, to: h.to_name, amd: n(h.amd), counted: n(h.counted) })) },
    received: { amd: sum(toOffice, "counted") + n(direct.rows[0].amd), handovers_amd: sum(toOffice, "counted"), direct_amd: n(direct.rows[0].amd), direct_n: direct.rows[0].n },
    bank: { amd: (bankBy.bank?.amd ?? 0) + (bankBy.card?.amd ?? 0), bank: bankBy.bank ?? { amd: 0, n: 0 }, card: bankBy.card ?? { amd: 0, n: 0 } },
    shortfalls: { today_amd: n(shortToday.rows[0].amd), today_n: shortToday.rows[0].n, open_amd: n(shortOpen.rows[0].amd), open_n: shortOpen.rows[0].n },
    in_hands: { amd: sum(inHands.rows), by_person: inHands.rows.map((r) => ({ name: r.name, role: r.role, amd: n(r.amd), n: r.n })) },
    to_check: toCheck.rows[0].n,
    not_in_excel: { amd: n(notInExcel.rows[0].amd), n: notInExcel.rows[0].n },
  };
}

const amd = (v) => `${n(v).toLocaleString("en-US")} դր`;

/** The evening summary for the accounting Telegram group (Armenian, plain text). */
export function boardText(b) {
  const d = `${b.day.slice(8, 10)}.${b.day.slice(5, 7)}.${b.day.slice(0, 4)}`;
  const lines = [`💰 Դրամական օրվա ամփոփում · ${d}`, ""];
  lines.push(`Հավաքագրված կանխիկ՝ ${amd(b.collected.amd)} (${b.collected.n})`);
  for (const r of b.collected.by_rep) lines.push(`  • ${r.name}՝ ${amd(r.amd)} (${r.n})`);
  lines.push(`Հաշված (տնօրեն)՝ ${amd(b.counted.amd)}${b.counted.expected_amd !== b.counted.amd ? ` / սպասվող ${amd(b.counted.expected_amd)}` : ""}`);
  lines.push(`Ստացված գրասենյակում՝ ${amd(b.received.amd)}`);
  lines.push(`Բանկ՝ ${amd(b.bank.bank.amd)} (${b.bank.bank.n}) · Քարտ՝ ${amd(b.bank.card.amd)} (${b.bank.card.n})`);
  if (b.shortfalls.today_amd) lines.push(`⚠️ Այսօրվա պակասորդ՝ ${amd(b.shortfalls.today_amd)}`);
  if (b.shortfalls.open_amd) lines.push(`Բաց պակասորդներ՝ ${amd(b.shortfalls.open_amd)} (${b.shortfalls.open_n})`);
  lines.push("", `Կանխիկը դեռ մարդկանց մոտ՝ ${amd(b.in_hands.amd)}`);
  for (const p of b.in_hands.by_person) lines.push(`  • ${p.name}՝ ${amd(p.amd)} (${p.n})`);
  if (b.to_check) lines.push(`Ստուգելու բանկային տողեր՝ ${b.to_check}`);
  lines.push(`Excel-ում դեռ չկա՝ ${amd(b.not_in_excel.amd)} (${b.not_in_excel.n})`);
  return lines.join("\n");
}

/** Today's (Yerevan) board text when it is due (from 20:00) and not posted yet; null otherwise. */
export async function pendingBoardPost(db = pool) {
  const { rows: [t] } = await db.query(
    "SELECT to_char((now() AT TIME ZONE 'Asia/Yerevan')::date, 'YYYY-MM-DD') AS day, EXTRACT(HOUR FROM now() AT TIME ZONE 'Asia/Yerevan')::int AS hour"
  );
  if (t.hour < 20) return null;
  const { rows: [post] } = await db.query("SELECT posted_at, attempts FROM money_board_posts WHERE day = $1", [t.day]);
  if (post?.posted_at || (post?.attempts ?? 0) >= 10) return null;
  return { day: t.day, text: boardText(await moneyBoard(db, t.day)) };
}

export async function markBoardPosted(db, day, ok, error = null) {
  await db.query(
    `INSERT INTO money_board_posts (day, posted_at, attempts, last_error) VALUES ($1, CASE WHEN $2 THEN now() END, 1, $3)
     ON CONFLICT (day) DO UPDATE SET posted_at = COALESCE(money_board_posts.posted_at, EXCLUDED.posted_at), attempts = money_board_posts.attempts + 1, last_error = EXCLUDED.last_error`,
    [day, ok, ok ? null : String(error ?? "").slice(0, 300)]
  );
}
