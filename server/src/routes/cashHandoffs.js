// Cash custody chain -- see migrations/059_cash_handoffs.sql for the
// business definition. Physical cash travels
//   sales_manager -> sales_director -> (ceo OR accountant) -> accountant
// and every hop is a `cash_handoffs` row: the sender declares it, the
// receiver counts the money and confirms (or rejects with a reason).
//
// Kept in its own router rather than bolted onto routes/payments.js: that
// file already owns the payment lifecycle and is long enough, and every
// route here hangs off /api/cash-handoffs. The two files are the only
// places that write payments.status / custody columns -- deliberately not
// three.
//
// Every multi-row state change below runs inside a single BEGIN/COMMIT,
// because a half-applied handoff would either lose custody of real cash or
// let the same payment be handed off twice.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import {
  validHandoffRecipientRoles,
  isTerminalHandoffRole,
  canSubmitHandoffForOthers,
} from "../roles.js";
import { notifyUser } from "../notifications.js";

export const cashHandoffsRouter = Router();
cashHandoffsRouter.use(requireAuth);

const PAGE_SIZE = 30;
const UNASSIGNED_CHANNEL = "—";

// A payment is available for `holderId` to hand off when they physically
// hold it, it is not already inside an in-flight handoff, and its journey
// has not already ended (approved) or been voided (rejected).
const AVAILABLE_SQL = `
  SELECT p.id, p.amount_amd, p.sales_channel, COALESCE(c.name, p.customer_name_snapshot) AS customer_name_snapshot,
         p.erp_customer_id_snapshot, p.sales_manager_name_snapshot, p.payment_date
  FROM payments p
  LEFT JOIN customers c ON c.id = p.customer_id
  WHERE p.current_holder_id = $1
    AND p.pending_handoff_id IS NULL
    AND p.status = 'pending'
  ORDER BY p.sales_channel NULLS LAST, p.payment_date DESC
`;

// Both the "available to hand off" screen and the receiver's "count the
// cash against this" screen need the same shape: per-channel subtotals so
// physical notes can be counted channel by channel, plus a grand total.
function summarize(rows) {
  const byChannel = new Map();
  let total = 0;
  for (const row of rows) {
    const key = row.sales_channel || UNASSIGNED_CHANNEL;
    const amount = Number(row.amount_amd);
    total += amount;
    const entry = byChannel.get(key) ?? { sales_channel: key, count: 0, total_amd: 0 };
    entry.count += 1;
    entry.total_amd += amount;
    byChannel.set(key, entry);
  }
  return {
    by_channel: [...byChannel.values()].sort((a, b) => a.sales_channel.localeCompare(b.sales_channel)),
    total_amd: total,
    count: rows.length,
  };
}

async function getUser(id, db = pool) {
  const { rows } = await db.query("SELECT id, name, role, position FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Who the caller is allowed to hand cash on behalf of. Acting for yourself
// is always allowed; acting for someone else is the first-hop case only
// (a director declaring "I received rep X's collections"), and the actor
// must be the RECEIVER of that hop -- you can only declare a handoff into
// your own hands, never move cash between two other people. Admin is the
// usual backstop exception (see roles.js: admin is a full-authority
// superset throughout this app) so a stuck chain can always be unblocked.
function checkOnBehalf(actor, sender, recipient) {
  if (sender.id === actor.id) return null;
  if (!canSubmitHandoffForOthers(actor.role)) {
    return "Not allowed to submit a handoff for another user";
  }
  if (sender.role !== "sales_manager") {
    return "A handoff can only be submitted on behalf of a sales manager";
  }
  if (recipient.id !== actor.id && actor.role !== "admin") {
    return "You can only declare a handoff into your own custody";
  }
  return null;
}

// GET /available -- what the caller (or, with ?as_user_id=, the manager
// they are declaring for) currently holds and could hand off next.
cashHandoffsRouter.get("/available", async (req, res) => {
  let holderId = req.user.id;
  if (req.query.as_user_id && Number(req.query.as_user_id) !== req.user.id) {
    if (!canSubmitHandoffForOthers(req.user.role)) {
      return res.status(403).json({ error: "Not allowed to view another user's cash" });
    }
    holderId = Number(req.query.as_user_id);
    if (!Number.isInteger(holderId)) return res.status(400).json({ error: "Invalid as_user_id" });
  }

  const holder = await getUser(holderId);
  if (!holder) return res.status(404).json({ error: "User not found" });

  const { rows } = await pool.query(AVAILABLE_SQL, [holderId]);
  const recipientRoles = validHandoffRecipientRoles(holder.role);
  const { rows: recipients } = recipientRoles.length
    ? await pool.query(
        "SELECT id, name, role, position FROM users WHERE role = ANY($1) ORDER BY role, name",
        [recipientRoles]
      )
    : { rows: [] };

  res.json({
    holder: { id: holder.id, name: holder.name, role: holder.role },
    payments: rows,
    ...summarize(rows),
    recipient_roles: recipientRoles,
    recipients,
  });
});

// GET /senders -- the managers a director/CEO/accountant/admin can declare
// a first-hop handoff for, each with how much of their cash is still
// waiting to be declared. Scoped narrowly (GET /api/users is admin-only)
// exactly like payments.js's /eligible-managers.
cashHandoffsRouter.get("/senders", async (req, res) => {
  if (!canSubmitHandoffForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.position,
            COALESCE(SUM(p.amount_amd), 0)::float8 AS available_amd,
            COUNT(p.id)::int AS available_count
     FROM users u
     LEFT JOIN payments p
       ON p.current_holder_id = u.id AND p.pending_handoff_id IS NULL AND p.status = 'pending'
     WHERE u.role = 'sales_manager'
     GROUP BY u.id, u.name, u.position
     ORDER BY u.name`
  );
  res.json(rows);
});

// POST / -- submit a handoff.
// Body: { to_user_id, payment_ids: [...] } or { to_user_id, all: true },
// plus optional on_behalf_of_user_id (first hop) and note.
// "all" is resolved server-side from the same availability rule, never from
// a client-supplied list, and amount_amd is always re-summed from the rows
// actually locked -- a client-supplied total is never trusted.
cashHandoffsRouter.post("/", async (req, res) => {
  const { to_user_id, payment_ids, all, on_behalf_of_user_id, note } = req.body ?? {};
  if (!to_user_id) return res.status(400).json({ error: "A recipient is required" });
  if (!all && (!Array.isArray(payment_ids) || payment_ids.length === 0)) {
    return res.status(400).json({ error: "Select at least one payment, or pass all: true" });
  }

  const recipient = await getUser(Number(to_user_id));
  if (!recipient) return res.status(400).json({ error: "Recipient not found" });

  const senderId = on_behalf_of_user_id ? Number(on_behalf_of_user_id) : req.user.id;
  const sender = await getUser(senderId);
  if (!sender) return res.status(400).json({ error: "Sender not found" });
  if (sender.id === recipient.id) return res.status(400).json({ error: "Cannot hand cash to yourself" });

  const onBehalfError = checkOnBehalf(req.user, sender, recipient);
  if (onBehalfError) return res.status(403).json({ error: onBehalfError });

  const allowedRoles = validHandoffRecipientRoles(sender.role);
  if (!allowedRoles.length) {
    return res.status(403).json({ error: "This role cannot hand cash onward" });
  }
  if (!allowedRoles.includes(recipient.role)) {
    return res.status(400).json({ error: `Cash from a ${sender.role} can only go to: ${allowedRoles.join(", ")}` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE on the payment rows is what makes two simultaneous
    // "Submit all" taps safe: the second one blocks, then re-reads the
    // rows with pending_handoff_id already set and finds nothing left.
    const selection = all
      ? await client.query(
          `SELECT id, amount_amd, sales_channel FROM payments
           WHERE current_holder_id = $1 AND pending_handoff_id IS NULL AND status = 'pending'
           ORDER BY id FOR UPDATE`,
          [sender.id]
        )
      : await client.query(
          `SELECT id, amount_amd, sales_channel FROM payments
           WHERE id = ANY($1::int[]) AND current_holder_id = $2
             AND pending_handoff_id IS NULL AND status = 'pending'
           ORDER BY id FOR UPDATE`,
          [payment_ids.map(Number), sender.id]
        );

    if (!selection.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Nothing available to hand off" });
    }
    if (!all && selection.rows.length !== new Set(payment_ids.map(Number)).size) {
      // Some requested payment is not (or no longer) this sender's to give
      // -- refuse the whole batch rather than silently handing off a subset
      // of what the user saw on screen.
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Some of those payments are no longer available to hand off" });
    }

    const total = selection.rows.reduce((sum, r) => sum + Number(r.amount_amd), 0);
    const { rows: created } = await client.query(
      `INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by, note)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING id`,
      [sender.id, recipient.id, total, req.user.id, note?.trim() || null]
    );
    const handoffId = created[0].id;
    const ids = selection.rows.map((r) => r.id);

    await client.query(
      `INSERT INTO cash_handoff_items (handoff_id, payment_id)
       SELECT $1, unnest($2::int[])`,
      [handoffId, ids]
    );
    await client.query("UPDATE payments SET pending_handoff_id = $1 WHERE id = ANY($2::int[])", [handoffId, ids]);

    await client.query("COMMIT");

    notifyHandoff(recipient.id, "cash_handoff_submitted", {
      title: "Կանխիկի հանձնում",
      body: `${sender.name} → ${Number(total).toLocaleString()} AMD (${ids.length})`,
      url: `/#/cash-handoffs/${handoffId}`,
    });

    res.status(201).json(await loadHandoff(handoffId));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// GET / -- the caller's inbox (handoffs awaiting THEIR confirmation) plus a
// paginated history of everything they sent or received. Paginated with the
// same LIMIT n+1 / has_more convention as GET /api/payments and /api/orders.
cashHandoffsRouter.get("/", async (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const { rows: incoming } = await pool.query(
    `${HANDOFF_SELECT}
     WHERE h.to_user_id = $1 AND h.status = 'pending'
     ORDER BY h.submitted_at ASC`,
    [req.user.id]
  );
  const { rows: history } = await pool.query(
    `${HANDOFF_SELECT}
     WHERE (h.from_user_id = $1 OR h.to_user_id = $1 OR h.submitted_by = $1)
       AND NOT (h.to_user_id = $1 AND h.status = 'pending')
     ORDER BY h.submitted_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, PAGE_SIZE + 1, offset]
  );

  res.json({
    incoming,
    rows: history.slice(0, PAGE_SIZE),
    has_more: history.length > PAGE_SIZE,
  });
});

cashHandoffsRouter.get("/:id", async (req, res) => {
  const handoff = await loadHandoff(Number(req.params.id));
  if (!handoff) return res.status(404).json({ error: "Handoff not found" });
  if (!canSeeHandoff(req.user, handoff)) return res.status(403).json({ error: "Not allowed to view this handoff" });
  res.json(handoff);
});

cashHandoffsRouter.post("/:id/confirm", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM cash_handoffs WHERE id = $1 FOR UPDATE", [req.params.id]);
    const handoff = rows[0];
    if (!handoff) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Handoff not found" });
    }
    // Admin as backstop, matching every other review gate in this app.
    if (handoff.to_user_id !== req.user.id && req.user.role !== "admin") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the recipient can confirm this handoff" });
    }
    if (handoff.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This handoff has already been resolved" });
    }

    const recipient = await getUser(handoff.to_user_id, client);
    await client.query(
      `UPDATE cash_handoffs SET status = 'confirmed', confirmed_by = $1, confirmed_at = now() WHERE id = $2`,
      [req.user.id, handoff.id]
    );

    // Custody moves; the in-flight lock clears either way.
    await client.query(
      `UPDATE payments SET current_holder_id = $1, pending_handoff_id = NULL
       WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $2)`,
      [handoff.to_user_id, handoff.id]
    );

    if (isTerminalHandoffRole(recipient.role)) {
      // The accountant is always the last stage, so their confirmation is
      // the moment the money's journey is complete -- which is exactly what
      // payments.status = 'approved' has always meant. Reports, exports and
      // Team Performance therefore keep working unchanged.
      const { rows: terminal } = await client.query(
        `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(),
                rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
         WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $2)
           AND status = 'pending'
         RETURNING id`,
        [req.user.id, handoff.id]
      );
      for (const row of terminal) {
        await client.query(
          `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
           VALUES ($1, 'pending', 'approved', $2, $3)`,
          [row.id, `Cash handoff #${handoff.id} confirmed`, req.user.id]
        );
      }
    }

    await client.query("COMMIT");

    notifyHandoff(handoff.from_user_id, "cash_handoff_reviewed", {
      title: "Կանխիկի հանձնումը հաստատվեց",
      body: `${recipient.name} · ${Number(handoff.amount_amd).toLocaleString()} AMD`,
      url: `/#/cash-handoffs/${handoff.id}`,
    });
    if (handoff.submitted_by !== handoff.from_user_id) {
      notifyHandoff(handoff.submitted_by, "cash_handoff_reviewed", {
        title: "Կանխիկի հանձնումը հաստատվեց",
        body: `${recipient.name} · ${Number(handoff.amount_amd).toLocaleString()} AMD`,
        url: `/#/cash-handoffs/${handoff.id}`,
      });
    }

    res.json(await loadHandoff(handoff.id));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

cashHandoffsRouter.post("/:id/reject", async (req, res) => {
  const reason = (req.body?.reason ?? "").trim();
  if (!reason) return res.status(400).json({ error: "A rejection reason is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM cash_handoffs WHERE id = $1 FOR UPDATE", [req.params.id]);
    const handoff = rows[0];
    if (!handoff) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Handoff not found" });
    }
    if (handoff.to_user_id !== req.user.id && req.user.role !== "admin") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Only the recipient can reject this handoff" });
    }
    if (handoff.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This handoff has already been resolved" });
    }

    await client.query(
      `UPDATE cash_handoffs SET status = 'rejected', rejected_by = $1, rejected_at = now(), rejection_reason = $2
       WHERE id = $3`,
      [req.user.id, reason, handoff.id]
    );
    // The receiver refused the cash, so it never left the sender's hands:
    // current_holder_id deliberately stays put and only the in-flight lock
    // clears, making these payments available for the sender to re-declare.
    await client.query(
      `UPDATE payments SET pending_handoff_id = NULL
       WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $1)`,
      [handoff.id]
    );
    await client.query("COMMIT");

    const rejector = await getUser(req.user.id);
    for (const target of new Set([handoff.from_user_id, handoff.submitted_by])) {
      notifyHandoff(target, "cash_handoff_reviewed", {
        title: "Կանխիկի հանձնումը մերժվեց",
        body: `${rejector.name} · ${reason}`,
        url: `/#/cash-handoffs/${handoff.id}`,
      });
    }

    res.json(await loadHandoff(handoff.id));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

const HANDOFF_SELECT = `
  SELECT h.*, fu.name AS from_user_name, fu.role AS from_user_role,
         tu.name AS to_user_name, tu.role AS to_user_role,
         sb.name AS submitted_by_name, cb.name AS confirmed_by_name, rb.name AS rejected_by_name,
         (SELECT count(*)::int FROM cash_handoff_items i WHERE i.handoff_id = h.id) AS item_count
  FROM cash_handoffs h
  JOIN users fu ON fu.id = h.from_user_id
  JOIN users tu ON tu.id = h.to_user_id
  JOIN users sb ON sb.id = h.submitted_by
  LEFT JOIN users cb ON cb.id = h.confirmed_by
  LEFT JOIN users rb ON rb.id = h.rejected_by
`;

async function loadHandoff(id) {
  const { rows } = await pool.query(`${HANDOFF_SELECT} WHERE h.id = $1`, [id]);
  const handoff = rows[0];
  if (!handoff) return null;
  const { rows: items } = await pool.query(
    `SELECT p.id, p.amount_amd, p.sales_channel, COALESCE(c.name, p.customer_name_snapshot) AS customer_name_snapshot,
            p.erp_customer_id_snapshot, p.sales_manager_name_snapshot, p.payment_date, p.status
     FROM cash_handoff_items i
     JOIN payments p ON p.id = i.payment_id
     LEFT JOIN customers c ON c.id = p.customer_id
     WHERE i.handoff_id = $1
     ORDER BY p.sales_channel NULLS LAST, p.payment_date DESC`,
    [id]
  );
  return { ...handoff, amount_amd: Number(handoff.amount_amd), payments: items, ...summarize(items) };
}

// Anyone on either end of the handoff, whoever declared it, or a role that
// already sees every payment company-wide (see seesAllPayments) -- a
// handoff exposes nothing a payment row doesn't.
function canSeeHandoff(user, handoff) {
  if (user.role !== "sales_manager") return true;
  return handoff.from_user_id === user.id || handoff.to_user_id === user.id || handoff.submitted_by === user.id;
}

// Notifications are best-effort: a failed push must never roll back or
// 500 a committed cash movement (same fire-and-forget shape as
// insertPayment's notify block in routes/payments.js).
function notifyHandoff(userId, type, payload) {
  Promise.resolve()
    .then(() => notifyUser(userId, type, payload))
    .catch((err) => console.error("Cash handoff notification failed:", err));
}
