// Excel "Balance" rows -> the app's cash handovers (owner, 2026-11-16).
//
// In the Excel Cashflow sheet, a rep's cash reaching the office is a pair of "Balance" rows: -X on the rep's cash box ("Cash DVT") and +X on
// the office box ("Cash"), on the same or the next day. After each Excel upload (and every few hours) every such pair is matched once:
//   1. the rep's handover of exactly X waiting for the accountant          -> confirmed (marked "from Excel")
//   2. else the rep's cash in hand up to that day adds up to exactly X     -> a handover to the accountant is created and confirmed
//      (all of it, or the oldest payments that add up to X)                    (owner: "if recorded in Excel > create handover")
//   3. anything else (a different amount, a handover waiting at a director) -> a task for the accountant (owner: "Task")
// The app never invents money: a pair is acted on only when the app's own payments add up to the Excel amount exactly.
// Q1 (owner): the money in the office box is the ACCOUNTANT's (the end of the chain).
//
// Test mode first (app_settings.excel_balance_mode = 'shadow'): every pair is matched and written down with what WOULD happen, nothing is
// changed. 'live' acts. A pair is known by its content (the Excel rows are re-inserted on every upload), so it is acted on once per mode.
// Only pairs from the payments cut-over (and the last 30 days) count: older ones are the archive.
import { pool } from "../db/pool.js";
import { CASH_IN_HAND_SQL } from "./cashCustody.js";
import { confirmHandoffInTx } from "./handoffConfirm.js";
import { usersWithRole, createOpsTask } from "../team/opsTasks.js";
import { notifyUser } from "../shared/notifications.js";

const LOOKBACK_DAYS = 30;
const amd = (n) => Math.round(Number(n)).toLocaleString("en-US");
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// The Balance pairs (pure, unit-tested): an outflow and an inflow of the same amount on another box, the same or the next day; each row is
// used once, in date order. Key: date | amount | from | to | n-th identical pair.
export function pairBalanceRows(rows) {
  const sorted = [...rows].sort((a, b) => dayOf(a.entry_date).localeCompare(dayOf(b.entry_date)) || a.id - b.id);
  const ins = sorted.filter((r) => Number(r.amount_amd) > 0);
  const used = new Set();
  const seen = new Map();
  const pairs = [];
  for (const out of sorted.filter((r) => Number(r.amount_amd) < 0)) {
    const amount = Math.round(-Number(out.amount_amd));
    const day = dayOf(out.entry_date);
    const inflow = ins.find(
      (r) => !used.has(r.id) && Math.round(Number(r.amount_amd)) === amount && r.account_id !== out.account_id && dayOf(r.entry_date) >= day && dayOf(r.entry_date) <= addDays(day, 1)
    );
    if (!inflow) continue;
    used.add(inflow.id);
    const base = `${day}|${amount}|${String(out.account_name).toLowerCase()}|${String(inflow.account_name).toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    pairs.push({ key: `${base}|${n}`, day, amount, from: out, to: inflow });
  }
  return pairs;
}

// Which sales manager a cash box belongs to (its only sales-manager holder, else the sales direction whose cash source it is), and which
// boxes are the office's (held by an accountant, or the box called "Cash"), with the accountant who receives.
async function loadBoxes(db) {
  const [{ rows: holders }, { rows: channels }, { rows: accounts }, accountants] = await Promise.all([
    db.query("SELECT h.account_id, u.id AS user_id, u.role FROM cash_desk_holders h JOIN users u ON u.id = h.user_id"),
    db.query(
      `SELECT lower(sc.cash_source) AS source, sc.manager_user_id FROM sales_channels sc JOIN users u ON u.id = sc.manager_user_id
       WHERE sc.active AND sc.cash_source IS NOT NULL AND u.role = 'sales_manager'`
    ),
    db.query("SELECT id, name, COALESCE(excel_aliases, '{}') AS aliases FROM cash_accounts"),
    usersWithRole("accountant", db),
  ]);
  const repOf = new Map();
  const officeOf = new Map(); // account id -> the accountant receiving
  for (const a of accounts) {
    const reps = holders.filter((h) => h.account_id === a.id && h.role === "sales_manager").map((h) => h.user_id);
    if (reps.length === 1) repOf.set(a.id, reps[0]);
    else if (!reps.length) {
      const names = [a.name, ...a.aliases].map((x) => String(x).toLowerCase());
      const owners = [...new Set(channels.filter((c) => names.includes(c.source)).map((c) => c.manager_user_id))];
      if (owners.length === 1) repOf.set(a.id, owners[0]);
    }
    const acc = holders.filter((h) => h.account_id === a.id && h.role === "accountant").map((h) => h.user_id);
    if (acc.length) officeOf.set(a.id, acc[0]);
    else if (String(a.name).trim().toLowerCase() === "cash" && accountants.length) officeOf.set(a.id, accountants[0]);
  }
  return { repOf, officeOf };
}

// What to do with one pair (inside the caller's transaction; `lock` adds FOR UPDATE).
async function decide(client, pair, repId, accountantId, { lock }) {
  const forUpdate = lock ? "FOR UPDATE OF h" : "";
  const { rows: [waiting] } = await client.query(
    `SELECT h.* FROM cash_handoffs h JOIN users u ON u.id = h.to_user_id
     WHERE h.from_user_id = $1 AND h.status = 'pending' AND u.role = 'accountant' AND round(h.amount_amd) = $2
       AND (h.submitted_at AT TIME ZONE 'Asia/Yerevan')::date BETWEEN $3::date - 7 AND $3::date + 1
     ORDER BY h.submitted_at LIMIT 1 ${forUpdate}`,
    [repId, pair.amount, pair.day]
  );
  if (waiting) return { outcome: "confirmed_existing", handoff: waiting };
  const { rows: cash } = await client.query(
    `SELECT p.id, p.amount_amd FROM payments p
     WHERE p.current_holder_id = $1 AND p.pending_handoff_id IS NULL AND p.payment_date <= $2::date AND ${CASH_IN_HAND_SQL}
     ORDER BY p.payment_date, p.id ${lock ? "FOR UPDATE OF p" : ""}`,
    [repId, pair.day]
  );
  // the oldest payments that add up to exactly the Excel amount (all of them is the usual case)
  let sum = 0;
  const take = [];
  for (const p of cash) {
    sum += Math.round(Number(p.amount_amd));
    take.push(p.id);
    if (sum === pair.amount) return { outcome: "created", paymentIds: take };
    if (sum > pair.amount) break;
  }
  const inHand = cash.reduce((s, p) => s + Math.round(Number(p.amount_amd)), 0);
  const { rows: [atDirector] } = await client.query(
    "SELECT 1 FROM cash_handoffs WHERE from_user_id = $1 AND status = 'pending' AND round(amount_amd) = $2 LIMIT 1",
    [repId, pair.amount]
  );
  return { outcome: "task", inHand, atDirector: Boolean(atDirector) };
}

export async function syncExcelBalance({ db = pool, now = new Date() } = {}) {
  const { rows: [st] } = await db.query("SELECT excel_balance_mode AS mode, payments_cutover FROM app_settings WHERE id = 1");
  const mode = st?.mode ?? "off";
  if (mode === "off") return { mode, pairs: 0 };
  const lockClient = await db.connect();
  try {
    const { rows: [got] } = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('excel_balance_sync')) AS ok");
    if (!got.ok) return { mode, skipped: "busy" };
    try {
      return await runSync(db, mode, st.payments_cutover, now);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('excel_balance_sync'))");
    }
  } finally {
    lockClient.release();
  }
}

async function runSync(db, mode, cutover, now) {
  const today = now.toISOString().slice(0, 10);
  const since = [addDays(today, -LOOKBACK_DAYS), cutover ? dayOf(cutover) : null].filter(Boolean).sort().at(-1);
  const { rows } = await db.query(
    `SELECT e.id, e.entry_date, e.amount_amd, e.account_id, a.name AS account_name
     FROM cash_entries e JOIN cash_categories c ON c.id = e.category_id JOIN cash_accounts a ON a.id = e.account_id
     WHERE e.origin = 'excel' AND lower(c.name) = 'balance' AND e.entry_date >= $1::date - 1`,
    [since]
  );
  const { repOf, officeOf } = await loadBoxes(db);
  const pairs = pairBalanceRows(rows).filter((p) => p.day >= since && repOf.has(p.from.account_id) && officeOf.has(p.to.account_id));
  const { rows: done } = await db.query("SELECT pair_key FROM excel_balance_links WHERE mode = $1 AND pair_key = ANY($2::text[])", [mode, pairs.map((p) => p.key)]);
  const doneKeys = new Set(done.map((r) => r.pair_key));
  const result = { mode, pairs: pairs.length, confirmed_existing: 0, created: 0, task: 0 };
  const taskLines = [];
  const notices = [];
  for (const pair of pairs.filter((p) => !doneKeys.has(p.key))) {
    const repId = repOf.get(pair.from.account_id);
    const accountantId = officeOf.get(pair.to.account_id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // the pair is claimed first: a second run (or server) finds it taken and does nothing
      const { rowCount } = await client.query(
        `INSERT INTO excel_balance_links (pair_key, mode, entry_date, amount_amd, from_account, to_account, rep_id, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'task') ON CONFLICT (pair_key, mode) DO NOTHING`,
        [pair.key, mode, pair.day, pair.amount, pair.from.account_name, pair.to.account_name, repId]
      );
      if (!rowCount) {
        await client.query("ROLLBACK");
        continue;
      }
      const live = mode === "live";
      const d = await decide(client, pair, repId, accountantId, { lock: live });
      let handoffId = d.handoff?.id ?? null;
      let detail = null;
      if (d.outcome === "confirmed_existing" && live) {
        await confirmHandoffInTx(client, d.handoff, { confirmerId: d.handoff.to_user_id, fromExcel: true });
        notices.push({ repId, handoffId, amount: pair.amount });
      } else if (d.outcome === "created" && live) {
        const { rows: [h] } = await client.query(
          `INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by, note, from_excel)
           VALUES ($1, $2, $3, 'pending', $2, $4, true) RETURNING *`,
          [repId, accountantId, pair.amount, `Excel Balance ${pair.day}: ${pair.from.account_name} → ${pair.to.account_name}`]
        );
        await client.query("INSERT INTO cash_handoff_items (handoff_id, payment_id) SELECT $1, unnest($2::int[])", [h.id, d.paymentIds]);
        await confirmHandoffInTx(client, h, { confirmerId: accountantId, fromExcel: true });
        handoffId = h.id;
        notices.push({ repId, handoffId, amount: pair.amount });
      } else if (d.outcome === "created") {
        detail = `${d.paymentIds.length} payments`;
      }
      if (d.outcome === "task") {
        detail = `in hand ${amd(d.inHand)}${d.atDirector ? "; a handover of this amount waits at a director" : ""}`;
        taskLines.push({ pair, repId, inHand: d.inHand, atDirector: d.atDirector });
      }
      await client.query("UPDATE excel_balance_links SET outcome = $3, handoff_id = $4, detail = $5 WHERE pair_key = $1 AND mode = $2", [pair.key, mode, d.outcome, handoffId, detail]);
      await client.query("COMMIT");
      result[d.outcome]++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Excel Balance pair failed:", err.message);
    } finally {
      client.release();
    }
  }
  if (mode === "live") {
    for (const n of notices) {
      notifyUser(n.repId, "cash_handoff_reviewed", { title: "Կանխիկի հանձնումը գրանցվեց Excel-ից", body: `${amd(n.amount)} AMD`, url: `/#/cash-handoffs/${n.handoffId}` }).catch(() => {});
    }
    if (taskLines.length) await taskForAccountants(db, taskLines);
  }
  return result;
}

// One open task per accountant: new mismatches are added to it as lines.
async function taskForAccountants(db, lines) {
  const { rows: names } = await db.query("SELECT id, COALESCE(name_hy, name) AS name FROM users WHERE id = ANY($1::int[])", [lines.map((l) => l.repId)]);
  const nameOf = new Map(names.map((r) => [r.id, r.name]));
  const items = lines.map(
    (l) =>
      `${l.pair.day.split("-").reverse().join("-")} · ${nameOf.get(l.repId) ?? "—"} · Excel՝ ${amd(l.pair.amount)} AMD (${l.pair.from.account_name} → ${l.pair.to.account_name}), հավելվածում ձեռքին՝ ${amd(l.inHand)} AMD${l.atDirector ? " · հանձնումը սպասում է տնօրենի մոտ" : ""}`
  );
  let assignees = await usersWithRole("accountant", db);
  if (!assignees.length) assignees = await usersWithRole("admin", db);
  for (const assigneeId of assignees) {
    const { rows: [open] } = await db.query("SELECT id FROM tasks WHERE auto_kind = 'cash_balance_check' AND assignee_id = $1 AND status = 'open' LIMIT 1", [assigneeId]);
    if (open) {
      const { rows: [m] } = await db.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM task_items WHERE task_id = $1", [open.id]);
      for (const [i, text] of items.entries()) await db.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [open.id, text.slice(0, 300), m.next + i]);
    } else {
      await createOpsTask({ kind: "cash_balance_check", title: "Excel-ի Balance-ը չի համընկնում հավելվածի կանխիկի հետ", assigneeId, items, db });
    }
  }
}

// The screen (Cash handovers, accountant / admin / CEO): the mode and the last pairs with what was (or would be) done.
export async function excelBalanceOverview(db = pool) {
  const [{ rows: [st] }, { rows: links }] = await Promise.all([
    db.query("SELECT excel_balance_mode AS mode FROM app_settings WHERE id = 1"),
    db.query(
      `SELECT l.id, l.mode, l.entry_date::text AS entry_date, l.amount_amd::float8 AS amount_amd, l.from_account, l.to_account, l.outcome, l.handoff_id, l.detail,
              l.created_at, COALESCE(u.name_hy, u.name) AS rep_name
       FROM excel_balance_links l LEFT JOIN users u ON u.id = l.rep_id
       WHERE l.mode = (SELECT CASE WHEN excel_balance_mode = 'live' THEN 'live' ELSE 'shadow' END FROM app_settings WHERE id = 1)
       ORDER BY l.entry_date DESC, l.id DESC LIMIT 60`
    ),
  ]);
  return { mode: st?.mode ?? "off", links };
}

export async function setExcelBalanceMode(mode, db = pool) {
  if (!["off", "shadow", "live"].includes(mode)) throw Object.assign(new Error("mode must be off, shadow or live"), { status: 400 });
  await db.query("UPDATE app_settings SET excel_balance_mode = $1 WHERE id = 1", [mode]);
}
