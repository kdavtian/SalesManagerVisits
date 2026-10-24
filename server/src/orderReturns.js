// Order returns and cancellations (owner, 2026-10-24).
//   cancel: the order is not delivered yet -> approval cancels it (the KAD OS way: back to draft with cancelled_at, out of every live queue);
//           a packed order waits for the warehouse manager to put the goods back first.
//   return: the order was delivered -> approval, then the warehouse manager confirms what came back (good / damaged), then it is done.
// Money: Excel stays the truth. The return carries a provisional credit (what the customer paid per unit x quantity) that the customer card shows
// until the negative line arrives from Excel (matchReturnsToErp) or the accountant marks it recorded.
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";

export const RETURN_REASONS = ["damaged", "wrong_product", "expired", "changed_mind", "quality", "other"];
export class ReturnError extends Error {
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CANCELLABLE = ["submitted", "confirmed", "packed_stock_out"];

// What the customer really paid per unit: the order's own discount is spread over its lines.
function creditFactor(order, items) {
  const subtotal = items.reduce((s, i) => s + Number(i.line_total_amd), 0);
  return subtotal > 0 ? Number(order.total_amd) / subtotal : 1;
}

export async function returnedQuantities(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT ri.order_item_id, SUM(ri.quantity)::float8 AS qty
     FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id
     WHERE r.order_id = $1 AND r.kind = 'return' AND r.status <> 'rejected' GROUP BY ri.order_item_id`,
    [orderId]
  );
  return new Map(rows.map((r) => [r.order_item_id, r.qty]));
}

// A sales manager may act on their own orders and their own customers' orders; everyone with an approval role on any.
export function mayRequest(user, order, customerManagerId) {
  if (user.role === "sales_manager") return order.user_id === user.id || customerManagerId === user.id;
  return ["admin", "ceo", "operations_director", "sales_director", "accountant"].includes(user.role);
}

export async function requestReturn(user, body) {
  const orderId = Number(body.order_id);
  const reason = String(body.reason ?? "");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  if (!RETURN_REASONS.includes(reason)) throw new ReturnError("Choose the reason");
  if (reason === "other" && !note) throw new ReturnError("Explain the \"Other\" reason");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [order] } = Number.isInteger(orderId)
      ? await client.query("SELECT o.*, c.assigned_manager_id AS customer_manager_id, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1 FOR UPDATE OF o", [orderId])
      : { rows: [] };
    if (!order) throw new ReturnError("Order not found", 404);
    if (!mayRequest(user, order, order.customer_manager_id)) throw new ReturnError("Not allowed", 403);
    if (order.cancelled_at) throw new ReturnError("This order is already cancelled", 409);
    const { rows: items } = await client.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [orderId]);
    const factor = creditFactor(order, items);
    let kind;
    let picked = [];
    if (order.status === "delivered") {
      kind = "return";
      const wanted = Array.isArray(body.items) ? body.items : [];
      if (!wanted.length) throw new ReturnError("Choose what is returned");
      const already = await returnedQuantities(orderId, client);
      const byId = new Map(items.map((i) => [i.id, i]));
      const seen = new Set();
      for (const w of wanted) {
        const item = byId.get(Number(w.order_item_id));
        const qty = Number(w.quantity);
        if (!item || seen.has(item.id)) throw new ReturnError("Unknown order line");
        seen.add(item.id);
        if (!(qty > 0)) throw new ReturnError("Every returned line needs a quantity");
        const left = Number(item.quantity) - (already.get(item.id) ?? 0);
        if (qty > left + 1e-9) throw new ReturnError(`Only ${left} of "${item.product_name}" can still be returned`, 409);
        picked.push({ item, qty });
      }
    } else if (CANCELLABLE.includes(order.status)) {
      kind = "cancel";
      const { rowCount } = await client.query("SELECT 1 FROM order_returns WHERE order_id = $1 AND kind = 'cancel' AND status IN ('requested', 'approved')", [orderId]);
      if (rowCount) throw new ReturnError("A cancellation of this order is already waiting", 409);
      picked = items.map((item) => ({ item, qty: Number(item.quantity) }));
    } else {
      throw new ReturnError("A draft order is simply deleted, it needs no cancellation", 400);
    }
    const credit = kind === "return" ? picked.reduce((s, p) => s + Math.round(Number(p.item.unit_price_amd) * factor * p.qty), 0) : 0;
    const { rows: [ret] } = await client.query(
      `INSERT INTO order_returns (order_id, customer_id, kind, reason, note, order_status_at_request, credit_amd, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orderId, order.customer_id, kind, reason, note, order.status, credit, user.id]
    );
    for (const p of picked) {
      const unit = Math.round(Number(p.item.unit_price_amd) * factor);
      await client.query(
        `INSERT INTO order_return_items (return_id, order_item_id, product_id, product_name, brand, quantity, unit_credit_amd, line_credit_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ret.id, p.item.id, p.item.product_id, p.item.product_name, p.item.brand ?? null, p.qty, unit, Math.round(Number(p.item.unit_price_amd) * factor * p.qty)]
      );
    }
    await client.query("COMMIT");
    notifyRoles(["admin", "ceo", "operations_director", "sales_director", "accountant"], user.id, {
      title: kind === "return" ? "Վերադարձի հայց" : "Չեղարկման հայց",
      body: `${order.customer_name}${order.order_code ? ` · #${order.order_code}` : ""}`,
      url: "/#/returns",
    });
    return { id: ret.id, kind };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function notifyRoles(roles, exceptUserId, payload) {
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [roles]);
    for (const u of rows) if (u.id !== exceptUserId) await notifyUser(u.id, "order_status_changed", payload);
  } catch (err) {
    console.error("Return notification failed:", err);
  }
}

async function applyCancel(client, order, ret, userId) {
  await client.query(
    `UPDATE orders SET status = 'draft', cancelled_at = now(), cancel_reason = $2, draft_reason = $3, updated_at = now() WHERE id = $1`,
    [order.id, ret.note ?? ret.reason, `Cancelled (request #${ret.id})`]
  );
  await client.query("DELETE FROM route_stops WHERE order_id = $1 AND completed_at IS NULL", [order.id]);
  await client.query(`INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, $2, 'draft', $3, $4)`, [order.id, order.status, `Cancelled (request #${ret.id})`, userId]);
}

async function loadForUpdate(client, id) {
  const { rows: [ret] } = await client.query("SELECT * FROM order_returns WHERE id = $1 FOR UPDATE", [id]);
  if (!ret) throw new ReturnError("Not found", 404);
  const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [ret.order_id]);
  return { ret, order };
}

export async function decideReturn(user, id, { approve, note }) {
  const text = typeof note === "string" ? note.trim().slice(0, 500) || null : null;
  if (!approve && !text) throw new ReturnError("Write why it is rejected");
  const client = await pool.connect();
  let outcome;
  try {
    await client.query("BEGIN");
    const { ret, order } = await loadForUpdate(client, id);
    if (ret.status !== "requested") throw new ReturnError("Already decided", 409);
    if (!approve) {
      await client.query("UPDATE order_returns SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1", [id, user.id, text]);
      outcome = "rejected";
    } else if (ret.kind === "cancel") {
      if (order.cancelled_at || !CANCELLABLE.includes(order.status)) throw new ReturnError("The order has changed since the request (it may be delivered now): reject this one and request a return", 409);
      if (order.status === "packed_stock_out") {
        await client.query("UPDATE order_returns SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1", [id, user.id, text]);
        outcome = "approved_waiting_warehouse";
      } else {
        await applyCancel(client, order, ret, user.id);
        await client.query("UPDATE order_returns SET status = 'done', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1", [id, user.id, text]);
        outcome = "done";
      }
    } else {
      await client.query("UPDATE order_returns SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE id = $1", [id, user.id, text]);
      outcome = "approved_waiting_warehouse";
    }
    await client.query("COMMIT");
    const msg = { rejected: "Հայցը մերժվեց", done: "Պատվերը չեղարկվեց", approved_waiting_warehouse: "Հայցը հաստատվեց" }[outcome];
    if (ret.requested_by) notifyUser(ret.requested_by, "order_status_changed", { title: msg, body: text ?? "", url: "/#/returns" }).catch(() => {});
    if (outcome === "approved_waiting_warehouse") notifyRoles(["warehouse_manager", "admin"], user.id, { title: "Վերադարձ՝ ապրանքը ստանալու համար", body: "", url: "/#/returns" });
    return { status: outcome === "rejected" ? "rejected" : outcome === "done" ? "done" : "approved" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// The warehouse manager: the goods are back. Each returned line is good (back to stock) or damaged (written off).
export async function receiveReturn(user, id, body = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { ret, order } = await loadForUpdate(client, id);
    if (ret.status !== "approved") throw new ReturnError("This return is not waiting for the warehouse", 409);
    const { rows: items } = await client.query("SELECT id FROM order_return_items WHERE return_id = $1", [id]);
    const conditions = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [Number(i.id), i.condition === "damaged" ? "damaged" : "good"]));
    for (const it of items) await client.query("UPDATE order_return_items SET condition = $2 WHERE id = $1", [it.id, conditions.get(it.id) ?? "good"]);
    if (ret.kind === "cancel") {
      if (order.cancelled_at || order.status !== "packed_stock_out") throw new ReturnError("The order has changed since the approval", 409);
      await applyCancel(client, order, ret, user.id);
    }
    await client.query("UPDATE order_returns SET status = 'done', received_by = $2, received_at = now(), updated_at = now() WHERE id = $1", [id, user.id]);
    await client.query("COMMIT");
    if (ret.requested_by) notifyUser(ret.requested_by, "order_status_changed", { title: ret.kind === "return" ? "Վերադարձը ստացվել է պահեստում" : "Պատվերը չեղարկվեց", body: "", url: "/#/returns" }).catch(() => {});
    if (ret.kind === "return") notifyRoles(["accountant"], user.id, { title: "Վերադարձ՝ մուտքագրել Excel-ում", body: "", url: "/#/returns" });
    return { status: "done" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markRecorded(user, id) {
  const { rowCount, rows } = await pool.query(
    "UPDATE order_returns SET recorded_at = now(), recorded_by = $2, recorded_via = 'manual', updated_at = now() WHERE id = $1 AND kind = 'return' AND status IN ('approved', 'done') AND recorded_at IS NULL RETURNING id",
    [id, user.id]
  );
  if (!rowCount) throw new ReturnError("Nothing to record", 409);
  return { id: rows[0].id };
}

// After an ERP sync: a return whose goods appear as negative lines of the same customer and product (at least the returned quantity, dated from the day it was
// requested) is recorded in Excel. Best effort: the accountant can always mark it by hand.
export async function matchReturnsToErp(db = pool) {
  const { rows: open } = await db.query(
    `SELECT r.id, r.requested_at, c.erp_customer_id FROM order_returns r JOIN customers c ON c.id = r.customer_id
     WHERE r.kind = 'return' AND r.status IN ('approved', 'done') AND r.recorded_at IS NULL AND c.erp_customer_id IS NOT NULL`
  );
  let matched = 0;
  for (const r of open) {
    const { rows: items } = await db.query(
      `SELECT ri.quantity::float8 AS qty, lower(p.erp_product_id) AS erp_product FROM order_return_items ri LEFT JOIN products p ON p.id = ri.product_id WHERE ri.return_id = $1`,
      [r.id]
    );
    if (!items.length || items.some((i) => !i.erp_product)) continue;
    const since = yerevanToday(new Date(r.requested_at));
    const { rows: lines } = await db.query(
      `SELECT lower(product_id) AS erp_product, SUM(-qty)::float8 AS qty FROM erp_order_lines WHERE erp_customer_id = $1 AND qty < 0 AND order_date >= $2::date GROUP BY 1`,
      [r.erp_customer_id, since]
    );
    const have = new Map(lines.map((l) => [l.erp_product, l.qty]));
    const need = new Map();
    for (const i of items) need.set(i.erp_product, (need.get(i.erp_product) ?? 0) + i.qty);
    if ([...need].every(([p, q]) => (have.get(p) ?? 0) + 1e-9 >= q)) {
      await db.query("UPDATE order_returns SET recorded_at = now(), recorded_via = 'erp', updated_at = now() WHERE id = $1 AND recorded_at IS NULL", [r.id]);
      matched++;
    }
  }
  return matched;
}

export async function listReturns(user, { status, orderId, customerId, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (status) where.push(`r.status = $${params.push(status)}`);
  if (orderId) where.push(`r.order_id = $${params.push(Number(orderId))}`);
  if (customerId) where.push(`r.customer_id = $${params.push(Number(customerId))}`);
  if (user.role === "sales_manager") where.push(`(r.requested_by = $${params.push(user.id)} OR c.assigned_manager_id = $${params.length})`);
  const { rows } = await pool.query(
    `SELECT r.id, r.order_id, r.customer_id, r.kind, r.status, r.reason, r.note, r.order_status_at_request, r.credit_amd::float8 AS credit_amd,
            r.requested_at, r.decided_at, r.decision_note, r.received_at, r.recorded_at, r.recorded_via,
            o.order_code, c.name AS customer_name, ru.name AS requested_by_name, du.name AS decided_by_name,
            (SELECT COALESCE(json_agg(json_build_object('id', i.id, 'product_name', i.product_name, 'brand', i.brand, 'quantity', i.quantity::float8, 'unit_credit_amd', i.unit_credit_amd::float8, 'line_credit_amd', i.line_credit_amd::float8, 'condition', i.condition) ORDER BY i.id), '[]')
               FROM order_return_items i WHERE i.return_id = r.id) AS items
     FROM order_returns r
     JOIN orders o ON o.id = r.order_id JOIN customers c ON c.id = r.customer_id
     LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY (r.status IN ('requested', 'approved')) DESC, r.requested_at DESC LIMIT ${Math.min(300, Math.max(1, Number(limit) || 100))}`,
    params
  );
  return rows;
}

// The credit shown on a customer until Excel has the negative lines: approved / done returns not yet recorded.
export async function pendingCreditFor(customerId, db = pool) {
  const { rows: [r] } = await db.query(
    "SELECT COALESCE(SUM(credit_amd), 0)::float8 AS amd, COUNT(*)::int AS n FROM order_returns WHERE customer_id = $1 AND kind = 'return' AND status IN ('approved', 'done') AND recorded_at IS NULL",
    [customerId]
  );
  return { amd: r.amd, count: r.n };
}

// For the nav / home badges: what is waiting for this user.
export async function returnCounts(user) {
  if (["admin", "ceo", "operations_director", "sales_director", "accountant"].includes(user.role)) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'requested')::int AS to_decide,
              COUNT(*) FILTER (WHERE kind = 'return' AND status = 'done' AND recorded_at IS NULL)::int AS to_record
       FROM order_returns`
    );
    return { to_decide: r.to_decide, to_record: user.role === "accountant" || user.role === "admin" ? r.to_record : 0, to_receive: 0 };
  }
  if (user.role === "warehouse_manager") {
    const { rows: [r] } = await pool.query("SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS to_receive FROM order_returns");
    return { to_decide: 0, to_record: 0, to_receive: r.to_receive };
  }
  return { to_decide: 0, to_record: 0, to_receive: 0 };
}
