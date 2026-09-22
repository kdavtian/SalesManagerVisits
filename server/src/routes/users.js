import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { ROLES, canPlanForOthers, canReassignCustomers } from "../roles.js";
import { passwordChangeLimiter } from "./auth.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Just enough to populate the "plan for" rep picker -- no email/other PII,
// open to any canPlanForOthers role (not admin-only like the rest of this
// router), since a Sales Director planning their team's routes has no
// other reason to need the full admin user-management list.
usersRouter.get(
  "/plannable",
  (req, res, next) => {
    if (!canPlanForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
    next();
  },
  async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, name, position FROM users WHERE role = 'sales_manager' ORDER BY name"
    );
    res.json(rows);
  }
);

// The customer card's "Assigned manager" picker -- deliberately a
// different (wider) role set than /plannable above. /plannable backs
// field-visit contexts (route/plan pickers, map filters) where a sales
// director has no business appearing since they don't do field visits
// themselves; this backs office-owned channels like OEM/CVO/PCO, which
// are assigned to the sales director, not an individual field rep.
usersRouter.get(
  "/assignable-managers",
  (req, res, next) => {
    if (!canReassignCustomers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
    next();
  },
  async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, name, position, role FROM users WHERE role IN ('sales_manager', 'sales_director') ORDER BY role, name"
    );
    res.json(rows);
  }
);

usersRouter.use(requireAdmin);

usersRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, position, phone, created_at,
            last_seen_at, last_seen_app_version, last_seen_user_agent
     FROM users ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Editable profile fields for an existing staff member -- deliberately not
// role (a role change has broader implications, e.g. re-checking whatever
// that user was assigned/plans/approves elsewhere, so it's out of scope
// for a quick "fix a typo in their phone number" edit) and not password
// (its own endpoint below, with its own rate limit and session-invalidation
// behavior).
const EDITABLE_PROFILE_FIELDS = ["name", "email", "position", "phone"];

usersRouter.patch("/:id", async (req, res) => {
  if (req.body?.email !== undefined && !req.body.email) {
    return res.status(400).json({ error: "Email cannot be empty" });
  }
  if (req.body?.name !== undefined && !req.body.name) {
    return res.status(400).json({ error: "Name cannot be empty" });
  }

  const updates = [];
  const params = [];
  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (req.body?.[field] === undefined) continue;
    const value = field === "email" ? String(req.body.email).toLowerCase() : req.body[field] || null;
    params.push(value);
    updates.push(`${field} = $${params.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${params.length}
       RETURNING id, email, name, role, position, phone, created_at,
                 last_seen_at, last_seen_app_version, last_seen_user_agent`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    throw err;
  }
});

usersRouter.post("/", async (req, res) => {
  const { email, password, name, role, position } = req.body ?? {};

  if (!email || !password || !name || !role) {
    return res
      .status(400)
      .json({ error: "email, password, name and role are required" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, position, created_at`,
      [String(email).toLowerCase(), passwordHash, name, role, position || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    throw err;
  }
});

// A role change is deliberately its own endpoint, not folded into the
// quick profile-edit PATCH /:id above (see EDITABLE_PROFILE_FIELDS'
// comment) -- broader implications (what that user is assigned/plans/
// approves elsewhere) mean it should be a distinct, considered admin
// action, not a side effect of fixing a typo in someone's phone number.
usersRouter.patch("/:id/role", async (req, res) => {
  const { role } = req.body ?? {};
  if (!role || !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
  }
  // Same self-lockout guard as DELETE /:id below -- an admin demoting
  // their own account out of admin would need another admin to undo it.
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You can't change your own role" });
  }
  const { rows } = await pool.query(
    `UPDATE users SET role = $1 WHERE id = $2
     RETURNING id, email, name, role, position, phone, created_at,
               last_seen_at, last_seen_app_version, last_seen_user_agent`,
    [role, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

usersRouter.patch("/:id/password", passwordChangeLimiter, async (req, res) => {
  const password = req.body?.password;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // Bumping token_version invalidates any session cookie already issued to
  // this user, so a reset password (e.g. after a suspected compromise)
  // actually logs them out everywhere instead of just changing the hash.
  const { rowCount } = await pool.query(
    "UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2",
    [passwordHash, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.status(204).end();
});

// The DELETE /:id 23503 case below ("they have activity records") is real
// -- most tables referencing users(id) aren't ON DELETE CASCADE/SET NULL on
// purpose, so the audit trail survives a rep leaving. But it also means a
// throwaway test account that did a couple of check-ins can never be
// removed at all. These three groups back a narrow admin escape hatch for
// exactly that case: "show me everything connected to this account, let me
// clear the safe stuff, then delete the user."
//
// AUTO_CLEAR: rows that are this user's *own* activity (or a stale
// reviewer/approver pointer on someone else's row that's safe to null out)
// -- clearing these never touches another person's business record.
const AUTO_CLEAR = [
  { table: "checkins", column: "user_id", mode: "delete", label: "checkins" },
  { table: "cash_expenses", column: "user_id", mode: "delete", label: "cash_expenses" },
  { table: "customer_edit_requests", column: "requested_by", mode: "delete", label: "edit_requests_made" },
  { table: "customer_edit_requests", column: "reviewed_by", mode: "null", label: "edit_requests_reviewed" },
  { table: "visit_plans", column: "reviewed_by", mode: "null", label: "visit_plans_reviewed" },
  { table: "perf_plans", column: "submitted_by", mode: "null", label: "perf_plans_submitted" },
  { table: "perf_plans", column: "approved_by", mode: "null", label: "perf_plans_approved" },
  { table: "perf_plans", column: "closed_by", mode: "null", label: "perf_plans_closed" },
];

// MUST_RESOLVE: rows that are someone *else's* real record (a customer, a
// payment, a cash handoff, a delivery/warehouse assignment, a plan this
// user authored for someone else) -- auto-deleting or renumbering these
// would silently destroy business data or an audit trail, so the admin has
// to resolve each by hand (reassign the customer, wait out the handoff
// history, etc.) first. The delete-records action below refuses outright
// while any of these is non-zero.
const MUST_RESOLVE = [
  { table: "customers", column: "created_by", label: "customers_created" },
  { table: "customers", column: "assigned_manager_id", label: "customers_assigned" },
  { table: "visit_plans", column: "created_by", label: "visit_plans_authored_for_others", extra: "user_id != $1" },
  { table: "visit_plan_rules", column: "created_by", label: "visit_plan_rules_authored_for_others", extra: "user_id != $1" },
  { table: "perf_plans", column: "created_by", label: "perf_plans_authored" },
  { table: "perf_plan_audit", column: "actor_id", label: "perf_plan_audit_entries" },
  { table: "perf_plan_comments", column: "author_id", label: "perf_plan_comments" },
  { table: "payments", column: "sales_manager_id", label: "payments_as_sales_manager" },
  { table: "payments", column: "created_by", label: "payments_created" },
  { table: "pod_records", column: "driver_id", label: "deliveries_as_driver" },
  { table: "delivery_routes", column: "driver_id", label: "delivery_routes_as_driver" },
  { table: "delivery_routes", column: "created_by", label: "delivery_routes_created" },
  { table: "cash_handoffs", column: "from_user_id", label: "cash_handoffs_sent" },
  { table: "cash_handoffs", column: "to_user_id", label: "cash_handoffs_received" },
  { table: "cash_handoffs", column: "submitted_by", label: "cash_handoffs_submitted" },
  { table: "cash_handoffs", column: "confirmed_by", label: "cash_handoffs_confirmed" },
  { table: "cash_handoffs", column: "rejected_by", label: "cash_handoffs_rejected" },
];

// WILL_CASCADE: already ON DELETE CASCADE, so deleting the user row itself
// takes care of these with no action needed here -- never blocking. Purely
// informational, so an admin sees "this also deletes N orders" up front
// instead of discovering it after the fact.
const WILL_CASCADE = [
  { table: "orders", column: "user_id", label: "orders" },
  { table: "visit_plans", column: "user_id", label: "visit_plans" },
  { table: "visit_plan_rules", column: "user_id", label: "visit_plan_rules" },
  { table: "push_subscriptions", column: "user_id", label: "push_subscriptions" },
  { table: "notifications", column: "user_id", label: "notifications" },
];

async function countRows(pool, list, userId) {
  const out = {};
  for (const { table, column, label, extra } of list) {
    const where = extra ? `${column} = $1 AND ${extra}` : `${column} = $1`;
    // table/column/extra all come from the fixed arrays above, never from
    // request input, so this interpolation carries no injection risk.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [userId]);
    out[label || `${table}.${column}`] = rows[0].n;
  }
  return out;
}

// What's connected to this account -- backs the admin's "records connected
// to this user" sheet before they attempt DELETE /:id/records.
usersRouter.get("/:id/deletion-report", async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) return res.status(400).json({ error: "Invalid user id" });
  const { rows } = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [userId]);
  if (!rows[0]) return res.status(404).json({ error: "User not found" });

  const mustResolve = await countRows(pool, MUST_RESOLVE, userId);
  const willClear = await countRows(pool, AUTO_CLEAR, userId);
  const willCascade = await countRows(pool, WILL_CASCADE, userId);

  res.json({
    user: rows[0],
    mustResolve,
    willClear,
    willCascade,
    canDeleteRecords: Object.values(mustResolve).every((n) => n === 0),
  });
});

// Clears every AUTO_CLEAR row for this user, so a subsequent DELETE /:id no
// longer 23503s on them -- refuses if anything in MUST_RESOLVE is still
// non-zero (re-checked here, inside the transaction, in case the admin's
// last report is stale).
usersRouter.delete("/:id/records", async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) return res.status(400).json({ error: "Invalid user id" });
  if (userId === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own records" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mustResolve = await countRows(client, MUST_RESOLVE, userId);
    if (Object.values(mustResolve).some((n) => n > 0)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "This user still has records that must be resolved manually (customers, payments, cash handoffs, or delivery/warehouse assignments) before their records can be cleared.",
        mustResolve,
      });
    }
    for (const { table, column, mode } of AUTO_CLEAR) {
      const sql = mode === "delete" ? `DELETE FROM ${table} WHERE ${column} = $1` : `UPDATE ${table} SET ${column} = NULL WHERE ${column} = $1`;
      await client.query(sql, [userId]);
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

usersRouter.delete("/:id", async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  try {
    const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "User not found" });
    res.status(204).end();
  } catch (err) {
    // Many tables reference users(id) without ON DELETE CASCADE (checkins,
    // customers.created_by, cash expenses, visit plans, cash handoffs,
    // performance records, ...) -- any account that ever actually did
    // something in the app hits this, and the admin UI had no handling for
    // it at all (a raw 500 the delete button's click handler silently
    // swallowed, so tapping "delete" looked like it did nothing).
    if (err.code === "23503") {
      return res.status(409).json({
        error:
          "Can't delete this user: they have activity records (check-ins, orders, payments, etc.) that must be kept for the audit trail. Reset their password instead if you just want to disable access.",
      });
    }
    throw err;
  }
});
