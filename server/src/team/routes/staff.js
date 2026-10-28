// Staff module (owner, 2026-10-23): people, who reports to whom, payroll of a month, day marks, premiums / bonuses / deductions, company rules.
// Pay maths lives in ../payroll.js. Access: admin / CEO / accountant see everyone; a boss sees themselves and everyone below them; everybody sees
// themselves. Managing people + pay items: admin / CEO / accountant. Marking days (completed / day off / unpaid): admin / CEO and the boss above the person.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { seesAllStaff, canManageStaff, canSetStaffRules } from "../../shared/roles.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { monthBounds, getStaffSettings, saveStaffSettings, payForStaff, holidaysOf, salaryLines, unmatchedSalaryLines } from "../../money/payroll.js";

export const staffRouter = Router();
staffRouter.use(requireAuth);

const KINDS = ["executive", "director", "rep", "office", "warehouse", "driver"];
const BASES = ["none", "collected", "sales"];
const DAY_STATUSES = ["completed", "dayoff", "unpaid"];
const ITEM_KINDS = ["premium", "bonus", "deduction"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const PERSON_COLS = `id, user_id, name, position, pay_keys, kind, reports_to, channel, fixed_salary_amd::float8 AS fixed_salary_amd, visit_based, min_visit_pct,
  paid_dayoffs_per_month, commission_basis, commission_pct::float8 AS commission_pct, commission_channels, commission_excluded,
  start_date::text AS start_date, end_date::text AS end_date, active, note`;

const monthOf = (q) => (monthBounds(q) ? q : yerevanToday().slice(0, 7));

async function allStaff() {
  const { rows } = await pool.query(`SELECT ${PERSON_COLS} FROM staff_members ORDER BY id`);
  return rows;
}

// The people below `id` (any depth).
function descendants(rows, id) {
  const out = new Set();
  const walk = (parent) => {
    for (const r of rows) if (r.reports_to === parent && !out.has(r.id)) { out.add(r.id); walk(r.id); }
  };
  walk(id);
  return out;
}

// What this user may see: { all, ids:Set, self } -- `bossOf(id)` tells whether the user is above that person.
async function scopeOf(user) {
  const rows = await allStaff();
  if (seesAllStaff(user.role)) return { rows, all: true, ids: new Set(rows.map((r) => r.id)), self: rows.find((r) => r.user_id === user.id) ?? null, bossOf: () => true };
  const self = rows.find((r) => r.user_id === user.id) ?? null;
  const below = self ? descendants(rows, self.id) : new Set();
  const ids = new Set(below);
  if (self) ids.add(self.id);
  return { rows, all: false, ids, self, bossOf: (id) => below.has(id) };
}

// Admin / CEO mark anybody; a boss marks the people below them; the accountant reads and manages pay items but does not mark days.
const canMarkFor = (user, scope, id) => user.role === "admin" || user.role === "ceo" || (!scope.all && scope.bossOf(id));

function cleanPerson(b, { partial = false } = {}) {
  const err = (m) => ({ error: m });
  const v = {};
  const has = (k) => b[k] !== undefined;
  const str = (k, max = 120) => (typeof b[k] === "string" ? b[k].trim().slice(0, max) : "");
  if (!partial || has("name")) { v.name = str("name"); if (!v.name) return err("Name is required"); }
  if (!partial || has("position")) { v.position = str("position"); if (!v.position) return err("Position is required"); }
  if (has("kind")) { if (!KINDS.includes(b.kind)) return err("Unknown kind"); v.kind = b.kind; }
  if (has("user_id")) { v.user_id = b.user_id === null || b.user_id === "" ? null : Number(b.user_id); if (v.user_id !== null && !Number.isInteger(v.user_id)) return err("Bad user"); }
  if (has("reports_to")) { v.reports_to = b.reports_to === null || b.reports_to === "" ? null : Number(b.reports_to); if (v.reports_to !== null && !Number.isInteger(v.reports_to)) return err("Bad boss"); }
  if (has("channel")) v.channel = str("channel", 40) || null;
  if (has("pay_keys")) v.pay_keys = (Array.isArray(b.pay_keys) ? b.pay_keys : String(b.pay_keys ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  if (has("fixed_salary_amd")) { v.fixed_salary_amd = Number(b.fixed_salary_amd); if (!(v.fixed_salary_amd >= 0) || v.fixed_salary_amd > 1e9) return err("Bad salary"); }
  if (has("visit_based")) v.visit_based = b.visit_based === true;
  if (has("min_visit_pct")) {
    v.min_visit_pct = b.min_visit_pct === null || b.min_visit_pct === "" ? null : Math.round(Number(b.min_visit_pct));
    if (v.min_visit_pct !== null && !(v.min_visit_pct >= 1 && v.min_visit_pct <= 100)) return err("Visit % must be 1-100");
  }
  if (has("paid_dayoffs_per_month")) { v.paid_dayoffs_per_month = Math.round(Number(b.paid_dayoffs_per_month)); if (!(v.paid_dayoffs_per_month >= 0 && v.paid_dayoffs_per_month <= 31)) return err("Bad day-off allowance"); }
  if (has("commission_basis")) { if (!BASES.includes(b.commission_basis)) return err("Unknown commission basis"); v.commission_basis = b.commission_basis; }
  if (has("commission_pct")) { v.commission_pct = Number(b.commission_pct); if (!(v.commission_pct >= 0 && v.commission_pct <= 100)) return err("Commission % must be 0-100"); }
  for (const k of ["commission_channels", "commission_excluded"]) {
    if (has(k)) {
      const list = (Array.isArray(b[k]) ? b[k] : String(b[k] ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
      v[k] = k === "commission_channels" && !list.length ? null : list;
    }
  }
  for (const k of ["start_date", "end_date"]) if (has(k)) { if (b[k] && !DATE.test(b[k])) return err("Bad date"); v[k] = b[k] || null; }
  if (has("active")) v.active = b.active !== false;
  if (has("note")) v.note = str("note", 500) || null;
  return { value: v };
}

async function wouldCycle(id, reportsTo) {
  if (reportsTo == null) return false;
  if (reportsTo === id) return true;
  const rows = await allStaff();
  return descendants(rows, id).has(reportsTo);
}

const dup = (err) => err.code === "23505";

// ---- who am I, rules ---------------------------------------------------------------------------------------------------------
staffRouter.get("/access", async (req, res) => {
  const scope = await scopeOf(req.user);
  res.json({ can_manage: canManageStaff(req.user.role), can_set_rules: canSetStaffRules(req.user.role), sees_all: scope.all, self_id: scope.self?.id ?? null, has_access: scope.all || scope.ids.size > 0 });
});

staffRouter.get("/settings", async (req, res) => {
  const scope = await scopeOf(req.user);
  if (!scope.all && !scope.ids.size) return res.status(403).json({ error: "Not allowed" });
  res.json({ ...(await getStaffSettings()), can_edit: canSetStaffRules(req.user.role) });
});
staffRouter.put("/settings", async (req, res) => {
  if (!canSetStaffRules(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const pct = Math.round(Number(req.body?.min_visit_pct));
  if (!(pct >= 1 && pct <= 100)) return res.status(400).json({ error: "Visit % must be 1-100" });
  res.json({ ...(await saveStaffSettings({ min_visit_pct: pct })), can_edit: true });
});

// ---- people + structure -------------------------------------------------------------------------------------------------------
staffRouter.get("/people", async (req, res) => {
  const scope = await scopeOf(req.user);
  if (!scope.all && !scope.ids.size) return res.status(403).json({ error: "Not allowed" });
  const { rows: users } = await pool.query("SELECT id, name, email, role FROM users");
  const byUser = new Map(users.map((u) => [u.id, u]));
  const people = scope.rows
    .filter((r) => scope.ids.has(r.id))
    .map((r) => ({ ...r, user: r.user_id ? { id: r.user_id, name: byUser.get(r.user_id)?.name ?? null, role: byUser.get(r.user_id)?.role ?? null } : null, can_mark: canMarkFor(req.user, scope, r.id), is_self: scope.self?.id === r.id }));
  res.json({ people, can_manage: canManageStaff(req.user.role), self_id: scope.self?.id ?? null });
});

// App users who are not in the staff list yet (to pick the login of a new person).
staffRouter.get("/candidates", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.role FROM users u WHERE u.role = ANY($1) AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = u.id) ORDER BY u.name`,
    [["admin", "ceo", "operations_director", "sales_director", "sales_manager", "warehouse_manager", "delivery_manager", "accountant"]]
  );
  res.json(rows);
});

staffRouter.post("/people", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const c = cleanPerson(req.body ?? {});
  if (c.error) return res.status(400).json({ error: c.error });
  const v = c.value;
  try {
    const keys = Object.keys(v);
    const { rows } = await pool.query(
      `INSERT INTO staff_members (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      keys.map((k) => v[k])
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (dup(err)) return res.status(409).json({ error: "This login is already linked to another person" });
    if (err.code === "23503") return res.status(400).json({ error: "Unknown boss or login" });
    throw err;
  }
});

staffRouter.put("/people/:id", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const c = cleanPerson(req.body ?? {}, { partial: true });
  if (c.error) return res.status(400).json({ error: c.error });
  const v = c.value;
  if (v.reports_to !== undefined && (await wouldCycle(id, v.reports_to))) return res.status(400).json({ error: "A person cannot report to themselves or to someone below them" });
  const keys = Object.keys(v);
  if (!keys.length) return res.status(400).json({ error: "Nothing to change" });
  try {
    const { rowCount } = await pool.query(`UPDATE staff_members SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${keys.length + 1}`, [...keys.map((k) => v[k]), id]);
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    if (dup(err)) return res.status(409).json({ error: "This login is already linked to another person" });
    if (err.code === "23503") return res.status(400).json({ error: "Unknown boss or login" });
    throw err;
  }
});

staffRouter.delete("/people/:id", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rowCount } = await pool.query("DELETE FROM staff_members WHERE id = $1", [Number(req.params.id)]);
  rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});

// ---- payroll ---------------------------------------------------------------------------------------------------------------------
// One month for everybody the user may see: the list the Payroll tab shows.
staffRouter.get("/payroll", async (req, res) => {
  const scope = await scopeOf(req.user);
  if (!scope.all && !scope.ids.size) return res.status(403).json({ error: "Not allowed" });
  const month = monthOf(String(req.query.month ?? ""));
  const [settings, holidays, lines] = await Promise.all([getStaffSettings(), holidaysOf(month), salaryLines()]);
  const today = yerevanToday();
  const people = scope.rows.filter((r) => scope.ids.has(r.id) && r.active);
  const rows = [];
  for (const p of people) {
    const pay = await payForStaff(p, month, { settings, holidays, today, lines });
    const { days, items, ...rest } = pay;
    rows.push({ id: p.id, name: p.name, position: p.position, kind: p.kind, reports_to: p.reports_to, ...rest });
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  // Salary payments of the month that name nobody on the list (the managers link them to a person in one tap).
  const unmatched = canManageStaff(req.user.role) ? await unmatchedSalaryLines(month, pool, lines) : [];
  res.json({ month, today, rows, unmatched, totals: { total: sum("total"), paid: sum("paid"), balance: sum("balance") } });
});

// Link a Salary payment to a person: the payment's name part (Info without the month) becomes one of the person's pay keys, so this payment
// and every later one written the same way count for them.
staffRouter.post("/people/:id/pay-keys", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const entryId = Number(req.body?.entry_id);
  const line = (await salaryLines()).find((l) => l.id === entryId);
  if (!line) return res.status(404).json({ error: "Payment not found" });
  if (!line.key) return res.status(400).json({ error: "This payment has no text to link by: write the person's position in its Info" });
  const { rowCount } = await pool.query(
    "UPDATE staff_members SET pay_keys = CASE WHEN $2 = ANY(pay_keys) THEN pay_keys ELSE array_append(pay_keys, $2) END WHERE id = $1",
    [id, line.key.slice(0, 120)]
  );
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true, key: line.key });
});

// One person's month: the day-by-day table, the pay items, the numbers.
staffRouter.get("/people/:id/pay", async (req, res) => {
  const id = Number(req.params.id);
  const scope = await scopeOf(req.user);
  if (!scope.ids.has(id)) return res.status(403).json({ error: "Not allowed" });
  const person = scope.rows.find((r) => r.id === id);
  const month = monthOf(String(req.query.month ?? ""));
  const pay = await payForStaff(person, month);
  res.json({ person, can_mark: canMarkFor(req.user, scope, id), can_manage: canManageStaff(req.user.role), min_visit_pct: person.min_visit_pct ?? (await getStaffSettings()).min_visit_pct, ...pay });
});

// Mark (or clear, status = null) one day.
staffRouter.put("/people/:id/days/:day", async (req, res) => {
  const id = Number(req.params.id);
  const day = req.params.day;
  if (!DATE.test(day)) return res.status(400).json({ error: "Bad date" });
  const scope = await scopeOf(req.user);
  if (!scope.ids.has(id)) return res.status(403).json({ error: "Not allowed" });
  if (!canMarkFor(req.user, scope, id)) return res.status(403).json({ error: "Only the boss of this person can mark days" });
  const status = req.body?.status ?? null;
  if (status !== null && !DAY_STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status" });
  if (status === null) await pool.query("DELETE FROM staff_days WHERE staff_id = $1 AND day = $2", [id, day]);
  else {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) || null : null;
    await pool.query(
      `INSERT INTO staff_days (staff_id, day, status, note, marked_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id, day) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, marked_at = now()`,
      [id, day, status, note, req.user.id]
    );
  }
  res.json({ ok: true });
});

// Premiums, bonuses, deductions.
staffRouter.post("/people/:id/items", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  const { kind, amount_amd: amt, note } = req.body ?? {};
  const b = monthBounds(String(req.body?.month ?? ""));
  const amount = Math.round(Number(amt));
  if (!b || !ITEM_KINDS.includes(kind) || !(amount > 0)) return res.status(400).json({ error: "Month, kind and a positive amount are required" });
  try {
    const { rows } = await pool.query(
      "INSERT INTO staff_pay_items (staff_id, month, kind, amount_amd, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [id, b.start, kind, amount, typeof note === "string" ? note.trim().slice(0, 300) || null : null, req.user.id]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23503") return res.status(404).json({ error: "Not found" });
    throw err;
  }
});
staffRouter.delete("/items/:itemId", async (req, res) => {
  if (!canManageStaff(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rowCount } = await pool.query("DELETE FROM staff_pay_items WHERE id = $1", [Number(req.params.itemId)]);
  rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});
