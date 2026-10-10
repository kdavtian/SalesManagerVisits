import { nextStatusFromDocuments, ACCOUNTING_STATUSES } from "../accountingStatus.js";
import { accountingQueueChanged } from "../accountingEvents.js";
import { accountingBadgeCount } from "../accountingBadge.js";
import { buildOrderBlanksPdf } from "../orderBlankPdf.js";
import { OFFICE_PHONE } from "../pricelistPdf.js";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { tierListPrice } from "../tierPricing.js";
import { seesAllActivity, canConfirmOrders, canConfirmSubmittedOrders, canRequestAccountingDocs, canSubmitOrdersForOthers, canAssignErpCustomerId, canRecordOrders, seesUnrecordedBadge, canMarkDeliveredWithoutRoute, seesProductCosts } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../notifications.js";
import { ORDER_NOTIFY_ROLES, WAREHOUSE_NOTIFY_ROLES, DELIVERY_OUTCOME_NOTIFY_ROLES } from "../notificationPreferences.js";
import { compareProducts } from "../../../client/public/js/productSort.js";
import { evaluateCredit } from "../creditLimit.js";
import { orderCostCheck, decideDiscountApproval, canApproveDiscountRole } from "../discountPolicy.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// v3 status machine (5 states): draft -> submitted -> confirmed ->
// packed_stock_out -> delivered. Every exception (director reject, WM
// stock issue, failed delivery) loops back to "draft" instead of a
// dedicated status -- see migrations/051_warehouse_delivery_v3.sql. This is
// the master map -- routes/warehouse.js and routes/delivery.js own the
// dedicated endpoints that actually perform the note-required (stock
// issue/reject) and POD-required (delivered) transitions; the generic
// PATCH below only exposes "confirmed" (see GENERIC_PATCH_TARGETS) so
// those can't be bypassed without their required extra data.
export const NEXT_STATUS = {
  draft: ["submitted"],
  submitted: ["confirmed", "draft"],
  confirmed: ["packed_stock_out", "draft"],
  packed_stock_out: ["delivered", "draft"],
  delivered: [],
};

// The generic PATCH /:id below only ever writes "confirmed" directly --
// draft (reject/stock-issue/delivery-failure), packed_stock_out and
// delivered all carry required extra data (a note, a mark-packed action, a
// delivery signature) that only their dedicated endpoints collect.
const GENERIC_PATCH_TARGETS = new Set(["confirmed"]);

// Snapshots each line's product name/price at build time -- shared by
// create and edit so an edited order prices its new lines exactly the same
// way a fresh order would. The price is resolved here from the customer's
// tier (never trusted from the client), except that a Gold customer can
// have individual prices: saved ones apply automatically, and a reviewer
// role (canSetPrices) can set a new one by sending unit_price_amd with
// price_override: true on the line, which is remembered for that customer.
async function buildOrderLines(items, { customerId, tier, canSetPrices = false, userId = null } = {}) {
  const productIds = items.map((i) => Number(i.product_id)).filter(Number.isInteger);
  const { rows: products } = productIds.length
    ? await pool.query("SELECT * FROM products WHERE id = ANY($1)", [productIds])
    : { rows: [] };
  const productById = new Map(products.map((p) => [p.id, p]));

  const isGold = tier === "gold" && customerId;
  const individual = new Map();
  if (isGold && productIds.length) {
    const { rows } = await pool.query(
      "SELECT product_id, price_amd FROM customer_product_prices WHERE customer_id = $1 AND product_id = ANY($2)",
      [customerId, productIds]
    );
    for (const r of rows) individual.set(r.product_id, Number(r.price_amd));
  }

  const lines = [];
  const newIndividual = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new OrderValidationError("Every item needs a positive quantity");
    }
    // Every line must resolve to a real catalog product -- no product can
    // be sold out of catalog (per decision C6). A free-text line was
    // previously allowed here for something not yet in the catalog; that
    // path is removed.
    const product = Number.isInteger(Number(item.product_id)) ? productById.get(Number(item.product_id)) : null;
    if (!product) {
      throw new OrderValidationError("Every item must be a product from the catalog");
    }
    let price = individual.has(product.id) ? individual.get(product.id) : tierListPrice(product, tier);
    if (isGold && canSetPrices && item.price_override === true && item.unit_price_amd !== undefined && item.unit_price_amd !== null) {
      const requested = Number(item.unit_price_amd);
      if (!Number.isFinite(requested) || requested < 0) {
        throw new OrderValidationError("unit_price_amd must be a non-negative number");
      }
      if (requested !== price) {
        price = requested;
        newIndividual.push([product.id, requested]);
      }
    }
    lines.push({
      product,
      product_id: product.id,
      product_name: product.name,
      brand: product.brand ?? null,
      unit_price_amd: price,
      quantity,
      line_total_amd: price * quantity,
    });
  }
  for (const [productId, price] of newIndividual) {
    await pool.query(
      `INSERT INTO customer_product_prices (customer_id, product_id, price_amd, set_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (customer_id, product_id) DO UPDATE SET price_amd = EXCLUDED.price_amd, set_by = EXCLUDED.set_by, updated_at = now()`,
      [customerId, productId, price, userId]
    );
  }
  // Saved in the products page's order (brand -> family -> viscosity -> spec
  // -> size), whatever order the rep tapped them in, so the order, its PDF
  // and the printed blank all read tidily. order_items are read back by id.
  lines.sort((a, b) => compareProducts(a.product, b.product));
  for (const line of lines) delete line.product;
  return lines;
}

class OrderValidationError extends Error {}

// YYMMDD + a 2-digit daily sequence, e.g. the 1st order on 2026-05-30 is
// "26053001" and the 27th on 2026-07-18 is "26071827".
export function formatOrderCode(date, seq) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}${String(seq).padStart(2, "0")}`;
}

// Atomically claims the next sequence number for today within the given
// transaction -- the upsert prevents two orders placed in the same instant
// from racing to the same seq.
async function nextOrderCode(client) {
  // Stamp the code from the same row (and thus the same clock) that claimed
  // the sequence number, rather than the app server's own `new Date()` --
  // if the app container and the DB ever disagree on timezone, those two
  // clocks can land on different calendar days near midnight, producing a
  // code whose date doesn't match the counter it was actually assigned from.
  const { rows } = await client.query(
    `INSERT INTO daily_order_seq (day, seq) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET seq = daily_order_seq.seq + 1
     RETURNING seq, day`
  );
  return formatOrderCode(rows[0].day, rows[0].seq);
}

// Same reviewer set as who confirms a submitted order (roles.js's
// canConfirmOrders) -- kept as one function instead of a second duplicate
// role list (B1).

// A flat-AMD discount and a percent discount are mutually exclusive on one
// order -- discount_amd wins if both are somehow nonzero (shouldn't happen,
// since the two setters below reset the other), and never goes below 0.
export function applyDiscount(subtotal, discountPct, discountAmd) {
  if (discountAmd > 0) return Math.max(0, subtotal - discountAmd);
  return subtotal * (1 - discountPct / 100);
}

// Create an order: an items array of {product_id, quantity}, every line
// resolving to a real catalog product (no free-text lines -- decision C6).
// Prices are snapshotted from the catalog at save time, not looked up live
// later -- an order is what was actually agreed, and must stay correct
// even if the catalog price changes afterward.
// Same idempotency shape GET /:id returns (order + items), used both for a
// retried submission recognized before the insert and one recognized via
// the unique-violation race below.
async function loadOrderWithItems(orderId) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) return null;
  const { rows: items } = await pool.query(
    "SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id",
    [orderId]
  );
  return { ...order, items };
}

ordersRouter.post("/", async (req, res) => {
  const { customer_id, checkin_id, note, items, discount_pct, discount_amd, payment_method, client_ref } = req.body ?? {};
  const customerId = Number(customer_id);
  if (!customerId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "customer_id and at least one item are required" });
  }

  // A retried submission (the offline queue's flushQueue() re-sending an
  // entry whose earlier attempt actually succeeded but whose response was
  // lost) carries the same client_ref every time -- recognize it here and
  // return the original order instead of creating a duplicate.
  if (client_ref) {
    const { rows: existingRows } = await pool.query("SELECT id FROM orders WHERE user_id = $1 AND client_ref = $2", [req.user.id, client_ref]);
    if (existingRows[0]) return res.status(201).json(await loadOrderWithItems(existingRows[0].id));
  }
  // Required going forward (item 6) -- informational only, not a
  // reintroduction of the rejected payment-approval workflow. Nullable at
  // the DB level so it doesn't break pre-existing orders; enforced here.
  if (payment_method !== "cash" && payment_method !== "invoice") {
    return res.status(400).json({ error: "payment_method must be 'cash' or 'invoice'" });
  }
  let discountPct = discount_pct !== undefined ? Number(discount_pct) : 0;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
  }
  let discountAmd = discount_amd !== undefined ? Number(discount_amd) : 0;
  if (!Number.isFinite(discountAmd) || discountAmd < 0) {
    return res.status(400).json({ error: "discount_amd must be a non-negative number" });
  }
  // The two discount kinds are mutually exclusive -- a flat amount takes
  // priority if a caller somehow sent both.
  if (discountAmd > 0) discountPct = 0;

  const { rows: customerRows } = await pool.query("SELECT id, name, erp_customer_id, customer_tier FROM customers WHERE id = $1", [customerId]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  // An order can never be approved without its customer being linked to an
  // ERP record (see the confirm-transition guard below), so there is no
  // point letting one exist as "submitted" and waiting on a reviewer who
  // can never approve it. It lands as a draft instead -- not visible to
  // reviewers/fulfillment -- until POST /orders/:id/submit links the
  // customer (or confirms it's already linked) and moves it forward.
  const initialStatus = customer.erp_customer_id ? "submitted" : "draft";

  // A client-supplied checkin_id is otherwise unverified -- without this,
  // any rep could link their order to someone else's checkin (or one for a
  // different customer entirely), which would misattribute the order in
  // the customer's visit history.
  if (checkin_id) {
    const { rows: checkinRows } = await pool.query(
      "SELECT id FROM checkins WHERE id = $1 AND user_id = $2 AND customer_id = $3",
      [checkin_id, req.user.id, customerId]
    );
    if (!checkinRows[0]) {
      return res.status(400).json({ error: "checkin_id does not match this customer and your own check-ins" });
    }
  }

  let lines;
  try {
    lines = await buildOrderLines(items, { customerId: customer.id, tier: customer.customer_tier, canSetPrices: canConfirmOrders(req.user.role), userId: req.user.id });
  } catch (err) {
    if (err instanceof OrderValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const subtotalAmd = lines.reduce((sum, l) => sum + l.line_total_amd, 0);
  const totalAmd = applyDiscount(subtotalAmd, discountPct, discountAmd);
  // A discount needs a director's sign-off before the order can move past
  // "submitted" into fulfillment (see the approval_status gate in PATCH
  // below) -- no discount means nothing to approve.
  // Up to 3 % is approved automatically (unless a line would sell below net cost); see discountPolicy.js.
  const costCheck = await orderCostCheck(pool, lines, subtotalAmd, totalAmd);
  const approvalStatus = decideDiscountApproval({ discountPct, discountAmd, subtotal: subtotalAmd, belowCost: costCheck.belowCost });
  // Credit limit (migration 101): an order that pushes the customer over their
  // limit also needs a director's sign-off. A draft (no ERP link yet, so no
  // debt known) is checked later, when it is submitted.
  const credit = initialStatus === "submitted" ? await evaluateCredit(pool, customer.id, totalAmd) : null;
  const creditStatus = credit?.exceeded ? "pending" : "not_required";

  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const orderCode = await nextOrderCode(client);
    const { rows } = await client.query(
      `INSERT INTO orders (customer_id, user_id, checkin_id, status, total_amd, note, discount_pct, discount_amd, approval_status, order_code, payment_method, client_ref,
                           credit_status, credit_exposure_amd, credit_limit_snapshot_amd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [customerId, req.user.id, checkin_id || null, initialStatus, totalAmd, note || null, discountPct, discountAmd, approvalStatus, orderCode, payment_method, client_ref || null,
       creditStatus, credit ? credit.exposure : null, credit ? credit.limit : null]
    );
    order = rows[0];
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, line.product_id, line.product_name, line.brand, line.unit_price_amd, line.quantity, line.line_total_amd]
      );
    }
    await client.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
       VALUES ($1, NULL, $2, 'Created', $3)`,
      [order.id, initialStatus, req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // 23505 = unique_violation -- two near-simultaneous retries of the same
    // queued entry both passed the client_ref check above before either had
    // committed; the loser here just needs the winner's row, not an error.
    if (err.code === "23505" && client_ref) {
      const { rows: existingRows } = await pool.query("SELECT id FROM orders WHERE user_id = $1 AND client_ref = $2", [req.user.id, client_ref]);
      if (existingRows[0]) return res.status(201).json(await loadOrderWithItems(existingRows[0].id));
    }
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ ...order, items: lines });

  // Fire after responding -- the rep shouldn't wait on a Telegram round
  // trip for their order confirmation. Wrapped so a late DB hiccup here
  // can't throw after headers are already sent (which would otherwise
  // crash the handler with ERR_HTTP_HEADERS_SENT). Skipped entirely for a
  // draft -- reviewers/fulfillment have nothing to act on until it's
  // actually submitted.
  if (initialStatus !== "submitted") return;
  (async () => {
    try {
      const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const repName = repRows[0]?.name || "Someone";
      const discountSuffix =
        approvalStatus !== "pending"
          ? ""
          : discountAmd > 0
          ? ` (${discountAmd.toLocaleString()} AMD discount, pending director approval)`
          : discountPct > 0
          ? ` (${discountPct}% discount, pending director approval)`
          : "";
      const discountSuffixHy =
        approvalStatus !== "pending"
          ? ""
          : discountAmd > 0
          ? ` (զեղչ՝ ${discountAmd.toLocaleString()} ԱՄԴ, սպասում է տնօրենի հաստատմանը)`
          : discountPct > 0
          ? ` (զեղչ՝ ${discountPct}%, սպասում է տնօրենի հաստատմանը)`
          : "";
      const creditSuffix = credit?.exceeded ? ` (credit limit exceeded by ${Math.round(credit.over).toLocaleString()} AMD)` : "";
      const creditSuffixHy = credit?.exceeded ? ` (վարկային սահմանը գերազանցված է ${Math.round(credit.over).toLocaleString()} ԱՄԴ-ով, սպասում է հաստատման)` : "";
      notifyTelegram(
        `🛒 <b>New order</b>\n${escapeHtml(repName)} — ${escapeHtml(customer.name)}\n${lines.length} item${lines.length === 1 ? "" : "s"}, ${Number(totalAmd).toLocaleString()} AMD${escapeHtml(discountSuffix + creditSuffix)}`
      );

      const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
      for (const recipient of notifyRecipients) {
        notifyUser(recipient.id, "order_placed", {
          title: "Նոր պատվեր",
          body: `${repName}-ը պատվեր է ձևակերպել ${customer.name}-ի համար — ${lines.length} ապրանք, ${Number(totalAmd).toLocaleString()} ԱՄԴ${discountSuffixHy}${creditSuffixHy}`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-order notification failed:", err);
    }
  })();
});

const PAGE_SIZE = 100;

ordersRouter.get("/", async (req, res) => {
  let { customer_id, user_id, status, offset, accounting, accounting_signed } = req.query;
  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }

  const conditions = [];
  const params = [];
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`o.user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  // "Accounting requests" group: every order that was sent to accounting
  // (accounting=any), or only those in one request status. Only the roles that
  // can see requests get this filter.
  // Everyone can open the Accounting page; what they see is already limited
  // by the visibility conditions above (a rep only gets their own orders).
  if (accounting) {
    if (accounting === "any") {
      conditions.push("o.accounting_status IS NOT NULL");
    } else if (accounting === "requests") {
      // Documents not made yet: waiting, being worked on, stuck or cancelled.
      conditions.push("o.accounting_status IN ('pending', 'in_progress', 'needs_attention', 'cancelled')");
    } else if (accounting === "waybill" || accounting === "invoice") {
      // Already-created documents of one kind; optionally only signed / not yet signed.
      params.push(accounting);
      conditions.push(`o.accounting_doc_type = $${params.length}`);
      if (accounting_signed === "signed") {
        conditions.push("o.accounting_status = 'signed'");
      } else if (accounting_signed === "unsigned") {
        conditions.push("o.accounting_status IN ('waybill_created', 'partially_created', 'exported_unsigned')");
      } else {
        conditions.push("o.accounting_status IN ('waybill_created', 'partially_created', 'exported_unsigned', 'signed')");
      }
    } else if (ACCOUNTING_STATUSES.includes(accounting)) {
      params.push(accounting);
      conditions.push(`o.accounting_status = $${params.length}`);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offsetNum = Math.max(0, Number(offset) || 0);

  // Fetch one extra row to know whether there's a next page, without a
  // separate COUNT(*) query -- trimmed back to PAGE_SIZE before sending.
  params.push(PAGE_SIZE + 1, offsetNum);
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name, c.sales_channel,
       -- Total liters across this order's lines -- only lines linked to a
       -- real catalog product count (product_id set), since a free-text
       -- line has no unit to go by. Every current product's unit is a
       -- plain "<number>L" string (e.g. "4L", "0.5L", "205L"), so stripping
       -- the trailing L and casting is enough; a future non-liter unit
       -- (e.g. "PCS") would need excluding here explicitly.
       (SELECT COALESCE(SUM(oi.quantity * NULLIF(regexp_replace(p.unit, 'L$', ''), '')::numeric), 0)
        FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = o.id AND p.unit ~ '^[0-9.]+L$') AS total_liters,
       (SELECT COUNT(*)::int FROM order_documents d WHERE d.order_id = o.id) AS document_count
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE });
});

// Badge on the Accounting quick action (see accountingBadge.js for who counts what).
ordersRouter.get("/accounting-count", async (req, res) => {
  res.json({ count: await accountingBadgeCount(req.user) });
});

// Is Lily (the accounting agent) connected right now? She calls the
// integration API every few seconds (a long-poll), so "seen in the last 60 s"
// on a real (non-test) token means online. Shown as a small chip on the
// Accounting tab. Declared ahead of GET /:id.
ordersRouter.get("/accounting-agent", async (req, res) => {
  if (!canRequestAccountingDocs(req.user.role)) return res.json({ online: false, last_seen_at: null });
  const { rows } = await pool.query(
    "SELECT MAX(last_used_at) AS last_seen_at FROM integration_tokens WHERE revoked_at IS NULL AND test_mode = false"
  );
  const last = rows[0].last_seen_at;
  res.json({ online: !!last && Date.now() - new Date(last).getTime() < 60 * 1000, last_seen_at: last });
});

// Signed documents Lily stored on an order. Reps see their own orders'
// documents, everyone with all-activity access sees all (same as the order).
async function canSeeOrderDocs(user, orderId) {
  const { rows } = await pool.query("SELECT user_id FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return null;
  return seesAllActivity(user.role) || rows[0].user_id === user.id;
}

ordersRouter.get("/documents/:docId/file", async (req, res) => {
  const { rows } = await pool.query("SELECT order_id, filename, content_type, data FROM order_documents WHERE id = $1", [req.params.docId]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: "Document not found" });
  // Same access as the customer card, which lists these documents too.
  res.set("Content-Type", doc.content_type);
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, max-age=3600");
  res.send(doc.data);
});

ordersRouter.delete("/documents/:docId", async (req, res) => {
  if (!canRequestAccountingDocs(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rowCount } = await pool.query("DELETE FROM order_documents WHERE id = $1", [req.params.docId]);
  if (!rowCount) return res.status(404).json({ error: "Document not found" });
  res.json({ ok: true });
});

ordersRouter.get("/:id/documents", async (req, res) => {
  const allowed = await canSeeOrderDocs(req.user, req.params.id);
  if (allowed === null) return res.status(404).json({ error: "Order not found" });
  if (!allowed) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    "SELECT id, order_id, hc_doc_number, kind, filename, content_type, size_bytes, created_at FROM order_documents WHERE order_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

// Print-ready "Delivery-acceptance act" blanks for one or more orders, as one
// PDF (see orderBlankPdf.js): small orders share an A4 sheet two by two, big
// ones get a whole sheet. A rep can only print their own orders. Declared
// ahead of GET /:id.
ordersRouter.post("/blank-pdf", async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return res.status(400).json({ error: "order_ids is required" });
  if (ids.length > 40) return res.status(400).json({ error: "Too many orders at once (max 40)" });
  const variant = ["full", "half"].includes(req.body?.variant) ? req.body.variant : undefined; // undefined = automatic

  const { rows: orders } = await pool.query(
    `SELECT o.id, o.order_code, o.created_at, o.total_amd, o.user_id,
            c.name AS customer_name, c.erp_customer_id, c.address AS customer_address, c.tin AS customer_tin, c.legal_name AS customer_legal_name, u.name AS rep_name, u.name_hy AS rep_name_hy, u.phone AS rep_phone, erp.debt_amd
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN users u ON u.id = o.user_id
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE o.id = ANY($1)`,
    [ids]
  );
  if (orders.length !== ids.length) return res.status(404).json({ error: "Order not found" });
  if (!seesAllActivity(req.user.role) && orders.some((o) => o.user_id !== req.user.id)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { rows: itemRows } = await pool.query(
    `SELECT oi.order_id, oi.brand, oi.product_name, p.unit AS size_l, oi.quantity, oi.unit_price_amd, oi.line_total_amd
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1) ORDER BY oi.id`,
    [ids]
  );
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const pdf = await buildOrderBlanksPdf(
    ids.map((id) => {
      const o = byOrder.get(id);
      return {
        variant,
        order: { order_code: o.order_code, created_at: o.created_at, total_amd: o.total_amd },
        items: itemRows.filter((r) => r.order_id === id).map((r) => ({ ...r, quantity: Number(r.quantity), unit_price_amd: Number(r.unit_price_amd), line_total_amd: Number(r.line_total_amd) })),
        customer: { name: o.customer_name, erp_customer_id: o.erp_customer_id, tin: o.customer_tin, legal_name: o.customer_legal_name, address: o.customer_address },
        rep: { name: o.rep_name_hy || o.rep_name, phone: o.rep_phone, officePhone: OFFICE_PHONE },
        // The customer's balance on file (Excel) before this order; blank line when unknown.
        previousDebtAmd: o.debt_amd != null ? Number(o.debt_amd) : null,
        paymentAmd: null,
      };
    })
  );
  const name = ids.length === 1 && orders[0].order_code ? `Order-${orders[0].order_code}.pdf` : "Order-blanks.pdf";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(pdf);
});

// Backs the badge on the Orders nav icon -- how many orders are sitting in
// "submitted" waiting on a confirm/reject/edit decision. Declared ahead of
// GET /:id so Express doesn't try to match "pending-count" as an :id.
ordersRouter.get("/pending-count", async (req, res) => {
  if (!canConfirmSubmittedOrders(req.user.role)) return res.json({ count: 0 });
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'submitted'");
  res.json({ count: rows[0].count });
});

// Accountant "Recorded" screen (spec section 6): every delivered order is
// listed here with its POD signature/debt/payment info until an
// accountant (or CEO/admin, who can also see the unrecorded backlog to
// catch it before it piles up) checks it off against the Excel books.
// This module never decides whether an order is "paid" -- it only tracks
// whether someone has looked at it. Declared ahead of GET /:id, same
// reason as pending-count above -- Express would otherwise try to match
// "recorded-list"/"unrecorded-count" as an :id.
ordersRouter.get("/recorded-list", async (req, res) => {
  if (!seesUnrecordedBadge(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const recorded = req.query.recorded === "true";
  const offsetNum = Math.max(0, Number(req.query.offset) || 0);
  // The "recorded" tab only ever grows (every delivered order eventually
  // lands here), so unlike the "unrecorded" backlog it can't be assumed
  // small -- same fetch-one-extra-row-for-has_more pattern as GET / above.
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.total_amd, o.updated_at AS delivered_at, o.recorded, o.recorded_at,
            c.id AS customer_id, c.name AS customer_name, c.erp_customer_id,
            rb.name AS recorded_by_name,
            pod.id AS pod_record_id, pod.payment_id,
            pod.debt_balance_before_amd, pod.amount_collected_amd, pod.new_balance_after_amd,
            pod.payment_method, pod.delivered_at AS pod_delivered_at
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users rb ON rb.id = o.recorded_by
     LEFT JOIN LATERAL (
       SELECT * FROM pod_records WHERE order_id = o.id ORDER BY id DESC LIMIT 1
     ) pod ON true
     WHERE o.status = 'delivered' AND o.recorded = $1
     ORDER BY o.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [recorded, PAGE_SIZE + 1, offsetNum]
  );
  res.json({ rows: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE });
});

ordersRouter.get("/unrecorded-count", async (req, res) => {
  if (!seesUnrecordedBadge(req.user.role)) return res.json({ count: 0 });
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status = 'delivered' AND recorded = false");
  res.json({ count: rows[0].count });
});

ordersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name, c.erp_customer_id
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!seesAllActivity(req.user.role) && order.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const { rows: items } = await pool.query(
    "SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id",
    [order.id]
  );
  const { rows: history } = await pool.query(
    `SELECT h.*, u.name AS changed_by_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.order_id = $1
     ORDER BY h.changed_at ASC`,
    [order.id]
  );
  // Margin against net cost is internal: only roles that see product costs get it.
  let pricing_check = null;
  if (seesProductCosts(req.user.role)) {
    const subtotal = items.reduce((sum, l) => sum + Number(l.unit_price_amd) * Number(l.quantity), 0);
    const check = await orderCostCheck(pool, items, subtotal, Number(order.total_amd));
    pricing_check = {
      margin_pct: check.marginPct === null ? null : Math.round(check.marginPct * 10) / 10,
      below_cost: check.belowCost,
      can_approve_discount: canApproveDiscountRole(req.user.role, check.belowCost),
    };
  }
  res.json({ ...order, items, history, pricing_check });
});

// Moves a draft order to "submitted" -- the only path that transition can
// take (see NEXT_STATUS, where "submitted" isn't reachable from "draft" via
// the generic PATCH below). If the customer still has no ERP customer ID,
// one must be supplied here and passes through the same ownership check as
// the dedicated "assign ERP ID" sheet on the customer page.
ordersRouter.post("/:id/submit", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, c.erp_customer_id, c.created_by AS customer_created_by, c.name AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.user_id !== req.user.id && req.user.role !== "admin" && !canSubmitOrdersForOthers(req.user.role)) {
    return res.status(403).json({ error: "Not allowed to submit this order" });
  }
  if (order.status !== "draft") {
    return res.status(409).json({ error: `Cannot submit an order that is already "${order.status}"` });
  }

  let erpCustomerId = order.erp_customer_id;
  if (!erpCustomerId) {
    const { erp_customer_id } = req.body ?? {};
    if (!erp_customer_id || !String(erp_customer_id).trim()) {
      return res.status(400).json({ error: "This customer has no ERP customer ID -- provide one to submit the order" });
    }
    if (!canAssignErpCustomerId(req.user.role, order.customer_created_by, req.user.id)) {
      return res.status(403).json({ error: "Not allowed to assign an ERP customer ID to this customer" });
    }
    erpCustomerId = String(erp_customer_id).trim();
    await pool.query("UPDATE customers SET erp_customer_id = $1 WHERE id = $2", [erpCustomerId, order.customer_id]);
  }

  // Guard the WHERE clause against a concurrent submit of the same order
  // (e.g. a double-tap or two tabs) racing this one -- the loser gets 0
  // rows back and a 409 instead of silently re-submitting an already-moved
  // order.
  const credit = await evaluateCredit(pool, order.customer_id, order.total_amd, order.id);
  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET status = 'submitted', updated_at = now(),
            credit_status = $2, credit_exposure_amd = $3, credit_limit_snapshot_amd = $4
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [order.id, credit?.exceeded ? "pending" : "not_required", credit ? credit.exposure : null, credit ? credit.limit : null]
  );
  const updated = updatedRows[0];
  if (!updated) {
    return res.status(409).json({ error: "This order was already submitted (or changed) by another request" });
  }
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'draft', 'submitted', 'Submitted', $2)`,
    [order.id, req.user.id]
  );
  const { rows: items } = await pool.query("SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id", [order.id]);
  res.json({ ...updated, items });

  (async () => {
    try {
      const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
      const repName = repRows[0]?.name || "Someone";
      notifyTelegram(
        `🛒 <b>New order</b>\n${escapeHtml(repName)} — ${escapeHtml(order.customer_name)}\n${Number(order.total_amd).toLocaleString()} AMD`
      );
      const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [ORDER_NOTIFY_ROLES]);
      for (const recipient of notifyRecipients) {
        notifyUser(recipient.id, "order_placed", {
          title: "Նոր պատվեր",
          body: `${repName}-ը պատվեր է ուղարկել ${order.customer_name}-ի համար — ${Number(order.total_amd).toLocaleString()} ԱՄԴ։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-order-submit notification failed:", err);
    }
  })();
});

// Edit line items (only while still "submitted", by the rep who placed it
// or an admin) and/or confirm a submitted order. Both can be sent in the
// same request. There is no "cancel" path here -- a rep who wants to
// withdraw their own submitted order asks a director to reject it (see
// POST /:id/reject); the only true dead-end is an admin's permanent
// DELETE below.
ordersRouter.patch("/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });

  const { status, items, note, discount_pct, discount_amd } = req.body ?? {};
  if (status === undefined && items === undefined && note === undefined && discount_pct === undefined && discount_amd === undefined) {
    return res.status(400).json({ error: "status, items, note, discount_pct, or discount_amd is required" });
  }

  const isOwnerOrAdmin = order.user_id === req.user.id || req.user.role === "admin";
  // A sales director (or admin) reviewing a fresh order can confirm/reject
  // it or fix a mistake in it, same editing rights as the rep who placed it
  // -- but only while it's still "submitted"; once it's moved on, editing
  // goes back to owner/admin only.
  const canEditSubmitted = isOwnerOrAdmin || (order.status === "submitted" && canConfirmOrders(req.user.role));

  // A note-only PATCH (no status/items/discount) fell through every check
  // below untouched -- none of them run when their own field is absent --
  // so any authenticated rep could overwrite any other rep's order note
  // regardless of ownership. Same ownership rule as items/discount edits.
  if (note !== undefined && !canEditSubmitted) {
    return res.status(403).json({ error: "Not allowed to edit this order" });
  }

  let nextLines = null;
  let nextTotal = order.total_amd;
  let nextDiscountPct = Number(order.discount_pct);
  let nextDiscountAmd = Number(order.discount_amd);
  let nextApprovalStatus = order.approval_status;

  if (discount_pct !== undefined || discount_amd !== undefined) {
    if (!canEditSubmitted) return res.status(403).json({ error: "Not allowed to edit this order" });
    // A draft is editable too, not just "submitted" -- it has no reviewer
    // yet (canEditSubmitted's director clause only ever applies once
    // status is "submitted", so this naturally stays owner/admin-only for
    // a draft), and there was previously no way at all to fix a draft
    // order's discount before submitting it short of deleting and
    // recreating the whole order.
    if (order.status !== "submitted" && order.status !== "draft") {
      return res.status(409).json({ error: "Only a draft or submitted order's discount can still be changed" });
    }
    if (discount_pct !== undefined) {
      const parsed = Number(discount_pct);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: "discount_pct must be a number between 0 and 100" });
      }
      nextDiscountPct = parsed;
      // Setting one discount kind always clears the other -- an order
      // carries at most one active discount.
      if (parsed > 0) nextDiscountAmd = 0;
    }
    if (discount_amd !== undefined) {
      const parsed = Number(discount_amd);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: "discount_amd must be a non-negative number" });
      }
      nextDiscountAmd = parsed;
      if (parsed > 0) nextDiscountPct = 0;
    }
    // Changing the discount always resets any prior director decision --
    // none needs no approval, anything else needs a fresh sign-off even if
    // a previous (different) discount on this order was already approved.
    nextApprovalStatus = nextDiscountPct > 0 || nextDiscountAmd > 0 ? "pending" : "not_required";
  }

  if (items !== undefined) {
    if (!canEditSubmitted) return res.status(403).json({ error: "Not allowed to edit this order" });
    // Same draft-or-submitted allowance as the discount block above.
    if (order.status !== "submitted" && order.status !== "draft") {
      return res.status(409).json({ error: "Only a draft or submitted order's items can still be edited" });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    try {
      const { rows: tierRows } = await pool.query("SELECT customer_tier FROM customers WHERE id = $1", [order.customer_id]);
      nextLines = await buildOrderLines(items, { customerId: order.customer_id, tier: tierRows[0]?.customer_tier, canSetPrices: canConfirmOrders(req.user.role), userId: req.user.id });
    } catch (err) {
      if (err instanceof OrderValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }

  if (nextLines || discount_pct !== undefined || discount_amd !== undefined) {
    // Editing items recomputes the subtotal, but a discount already
    // approved (or awaiting approval) still applies to whatever the order
    // now totals -- it shouldn't silently vanish just because the rep
    // swapped a line.
    const subtotal = nextLines
      ? nextLines.reduce((sum, l) => sum + l.line_total_amd, 0)
      : (await pool.query("SELECT COALESCE(SUM(line_total_amd), 0) AS subtotal FROM order_items WHERE order_id = $1", [order.id])).rows[0]
          .subtotal;
    nextTotal = applyDiscount(Number(subtotal), nextDiscountPct, nextDiscountAmd);

    // Discount policy (discountPolicy.js): a changed discount is decided again (up to 3 % is
    // automatic); changed items re-check only an automatic approval, a person's decision stays.
    const discountChanged = discount_pct !== undefined || discount_amd !== undefined;
    const wasAutoApproved = order.approval_status === "approved" && order.approved_by === null;
    if (nextDiscountPct > 0 || nextDiscountAmd > 0) {
      if (discountChanged || wasAutoApproved) {
        const policyLines = nextLines ?? (await pool.query("SELECT product_id, unit_price_amd, quantity FROM order_items WHERE order_id = $1", [order.id])).rows;
        const check = await orderCostCheck(pool, policyLines, Number(subtotal), nextTotal);
        nextApprovalStatus = decideDiscountApproval({ discountPct: nextDiscountPct, discountAmd: nextDiscountAmd, subtotal: Number(subtotal), belowCost: check.belowCost });
      }
    } else {
      nextApprovalStatus = "not_required";
    }
  }

  // Credit limit: a changed total is checked again (a draft has no debt yet, it
  // is checked at submit). An approval stays valid while the total does not grow.
  let nextCreditStatus = order.credit_status;
  let nextCreditExposure = order.credit_exposure_amd;
  let nextCreditLimit = order.credit_limit_snapshot_amd;
  if (order.status === "submitted" && Number(nextTotal) !== Number(order.total_amd)) {
    const credit = await evaluateCredit(pool, order.customer_id, nextTotal, order.id);
    nextCreditExposure = credit ? credit.exposure : null;
    nextCreditLimit = credit ? credit.limit : null;
    if (!credit?.exceeded) nextCreditStatus = "not_required";
    else if (!(order.credit_status === "approved" && Number(nextTotal) <= Number(order.total_amd))) nextCreditStatus = "pending";
  }

  let nextStatus = order.status;
  if (status !== undefined) {
    // Only a director (or admin) reviewing a fresh "submitted" order can
    // confirm it via this generic endpoint -- see GENERIC_PATCH_TARGETS.
    const canReviewSubmitted = order.status === "submitted" && canConfirmSubmittedOrders(req.user.role);
    if (!canReviewSubmitted) {
      return res.status(403).json({ error: "Only a director confirming a submitted order can update its status here" });
    }
    // nextApprovalStatus, not order.approval_status -- a discount_pct/
    // discount_amd sent in this SAME request already recomputed it above
    // (any new discount always resets to "pending"), and checking the
    // pre-request value here let a single PATCH combining a fresh discount
    // with status: "confirmed" sail straight through: order.approval_status
    // was still "not_required" from before this request touched it, so this
    // guard passed, and the UPDATE below wrote status="confirmed" and
    // approval_status="pending" together -- an order entering the warehouse
    // queue with a discount no director had actually signed off on
    // (reported as "confirmation can leave a new discount unapproved").
    if (nextApprovalStatus === "pending" || nextApprovalStatus === "rejected") {
      return res.status(409).json({
        error:
          nextApprovalStatus === "pending"
            ? "This order's price change is awaiting director approval"
            : "This order's price change was rejected -- edit the order to remove or adjust it before it can proceed",
      });
    }
    // Credit limit gate (migration 101): like a discount, an over-limit order
    // needs a director's approval first. An order that was fine at submit time
    // is re-checked live, because the customer's debt may have grown since.
    if (status === "confirmed" && nextCreditStatus !== "approved") {
      if (nextCreditStatus === "not_required") {
        const live = await evaluateCredit(pool, order.customer_id, nextTotal, order.id);
        if (live?.exceeded) {
          await pool.query(
            "UPDATE orders SET credit_status = 'pending', credit_exposure_amd = $2, credit_limit_snapshot_amd = $3 WHERE id = $1 AND credit_status = 'not_required'",
            [order.id, live.exposure, live.limit]
          );
          nextCreditStatus = "pending";
        }
      }
      if (nextCreditStatus === "pending" || nextCreditStatus === "rejected") {
        return res.status(409).json({
          error:
            nextCreditStatus === "pending"
              ? "This order is over the customer's credit limit and needs a director's approval first"
              : "This order's credit-limit approval was rejected -- reduce the order before it can proceed",
        });
      }
    }
    if (!NEXT_STATUS[order.status]?.includes(status)) {
      return res.status(409).json({ error: `Cannot move an order from "${order.status}" to "${status}"` });
    }
    if (!GENERIC_PATCH_TARGETS.has(status)) {
      return res.status(400).json({
        error: `"${status}" requires the dedicated endpoint, not a plain status edit`,
      });
    }
    // Defense in depth: draft orders can only reach "submitted" through
    // POST /:id/submit (see NEXT_STATUS, which doesn't even list it as
    // reachable from here), but a submitted order could in principle have
    // had its customer's ERP link removed after the fact -- re-check right
    // before confirming rather than trusting the state at submit time.
    const { rows: cRows } = await pool.query("SELECT erp_customer_id FROM customers WHERE id = $1", [order.customer_id]);
    if (!cRows[0]?.erp_customer_id) {
      return res.status(409).json({ error: "This order's customer has no ERP customer ID -- link one before confirming" });
    }
    nextStatus = status;
  }

  // Confirming an order isn't a resting state -- it immediately enters the
  // Warehouse Manager's queue (spec: "order confirmed -> WM notified").
  const enteringWarehouseQueue = status !== undefined && nextStatus === "confirmed" && order.status !== "confirmed";

  const client = await pool.connect();
  let updated;
  try {
    await client.query("BEGIN");
    // Guarding on the status/approval_status this handler's checks above
    // were computed against closes the race with a second concurrent PATCH
    // (or a discount approve/reject) landing between our initial read and
    // this write -- the loser gets 0 rows back instead of clobbering
    // whatever the winner just set.
    const { rows: updatedRows } = await client.query(
      `UPDATE orders
       SET status = $1, total_amd = $2, note = COALESCE($3, note),
           discount_pct = $4, discount_amd = $7, approval_status = $5, updated_at = now(),
           credit_status = $10, credit_exposure_amd = $11, credit_limit_snapshot_amd = $12
       WHERE id = $6 AND status = $8 AND approval_status = $9 RETURNING *`,
      [nextStatus, nextTotal, note ?? null, nextDiscountPct, nextApprovalStatus, order.id, nextDiscountAmd, order.status, order.approval_status, nextCreditStatus, nextCreditExposure, nextCreditLimit]
    );
    updated = updatedRows[0];
    if (!updated) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This order was changed by someone else -- refresh and try again" });
    }

    if (nextLines) {
      await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
      for (const line of nextLines) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, line.product_id, line.product_name, line.brand, line.unit_price_amd, line.quantity, line.line_total_amd]
        );
      }
    }
    // Only a real status transition (this endpoint doubles as a plain
    // items/discount/note editor, which never touches status) belongs in
    // the timeline.
    if (status !== undefined && nextStatus !== order.status) {
      await client.query(
        `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
         VALUES ($1, $2, $3, 'Confirmed', $4)`,
        [order.id, order.status, nextStatus, req.user.id]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const { rows: items2 } = await pool.query("SELECT oi.*, p.unit AS size FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id", [order.id]);
  res.json({ ...updated, items: items2 });

  // Only the rep who placed the order cares about its fulfillment moving
  // forward, and only when the status actually changed (not a pure
  // items/note edit) -- and not when they made the change themselves.
  (async () => {
    try {
      if (status !== undefined && nextStatus !== order.status && req.user.id !== order.user_id) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        notifyUser(order.user_id, "order_status_changed", {
          title: "Պատվերի թարմացում",
          body: `${customerRows[0]?.name || "Պատվերի"} կարգավիճակը այժմ՝ "${nextStatus}"։`,
          url: "/#/orders",
        });
      }
      if (enteringWarehouseQueue) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        const customerName = customerRows[0]?.name || "Պատվերի";
        const { rows: wmRows } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
        for (const wm of wmRows) {
          notifyUser(wm.id, "order_warehouse_review", {
            title: "Պատվերը պատրաստ է պահեստի համար",
            body: `${customerName}-ի պատվերը հաստատվել է և պատրաստ է հավաքման ու փաթեթավորման համար։`,
            url: "/#/warehouse",
          });
        }
      }
    } catch (err) {
      console.error("Post-order-update notification failed:", err);
    }
  })();
});

// Asks accounting (Lily) for the order's document: a waybill (Բեռնագիր) for
// a cash order, a tax invoice (Հաշիվ ապրանքագիր) for an invoice order.
// Management can still change the payment method here, which decides the
// document type. Allowed again while the request is still "pending" (to
// switch method) or "needs_attention" (retry); once Lily has claimed it the
// document is her's to finish.
ordersRouter.post("/:id/accounting-request", async (req, res) => {
  if (!canRequestAccountingDocs(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.*, c.erp_customer_id, c.tin AS customer_tin FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!["confirmed", "packed_stock_out", "delivered"].includes(order.status)) {
    return res.status(409).json({ error: "Only a confirmed order can be sent to accounting" });
  }
  const method = req.body?.payment_method ?? order.payment_method;
  if (!["cash", "invoice"].includes(method)) return res.status(400).json({ error: "payment_method must be cash or invoice" });
  if (!["pending", "needs_attention", "cancelled", null].includes(order.accounting_status)) {
    return res.status(409).json({ error: "Accounting is already working on this order's document" });
  }
  if (!order.erp_customer_id) return res.status(409).json({ error: "This order's customer has no ERP customer ID" });
  if (method === "invoice" && !order.customer_tin) {
    return res.status(409).json({ error: "An invoice needs the customer's TIN -- add it on the customer page first" });
  }
  const isTest = req.user.role === "admin" && req.body?.test === true;
  const docType = method === "cash" ? "waybill" : "invoice";
  const { rows: updated } = await pool.query(
    `UPDATE orders SET payment_method = $2, accounting_doc_type = $3, accounting_status = 'pending', accounting_is_test = $4,
            accounting_requested_by = $5, accounting_requested_at = now(), accounting_claimed_at = NULL,
            accounting_documents = '[]'::jsonb, accounting_error = NULL, accounting_updated_at = now(), updated_at = now()
     WHERE id = $1 AND accounting_status IS NOT DISTINCT FROM $6 RETURNING *`,
    [order.id, method, docType, isTest, req.user.id, order.accounting_status]
  );
  if (!updated[0]) return res.status(409).json({ error: "This order was changed by someone else -- refresh and try again" });
  accountingQueueChanged();
  res.json(updated[0]);
});

// Moves a request to another condition by hand (pending = back in the queue
// for Lily, cancelled = withdrawn, created / signed / needs attention =
// recorded by a person). Management and the accountant can do it.
ordersRouter.post("/:id/accounting-status", async (req, res) => {
  if (!canConfirmOrders(req.user.role) && req.user.role !== "accountant") return res.status(403).json({ error: "Not allowed" });
  const next = req.body?.status;
  if (!ACCOUNTING_STATUSES.includes(next)) return res.status(400).json({ error: "Unknown request status" });
  const { rows } = await pool.query("SELECT id, accounting_status FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!order.accounting_status) return res.status(409).json({ error: "This order was never sent to accounting" });
  if (order.accounting_status === next) return res.json((await pool.query("SELECT * FROM orders WHERE id = $1", [order.id])).rows[0]);
  const error =
    next === "needs_attention"
      ? JSON.stringify({ code: "manual", message: `Marked by ${req.user.name}` })
      : null;
  const { rows: updated } = await pool.query(
    `UPDATE orders SET accounting_status = $2, accounting_error = $3::jsonb,
            accounting_claimed_at = CASE WHEN $2 = 'in_progress' THEN now() ELSE NULL END,
            accounting_requested_at = CASE WHEN $2 = 'pending' THEN now() ELSE accounting_requested_at END,
            accounting_updated_at = now(), updated_at = now()
     WHERE id = $1 AND accounting_status = $4 RETURNING *`,
    [order.id, next, error, order.accounting_status]
  );
  if (!updated[0]) return res.status(409).json({ error: "This request was changed by someone else -- refresh and try again" });
  if (next === "pending") accountingQueueChanged();
  res.json(updated[0]);
});

// A human confirms the SRC signature in KAD (Lily never signs and may not be
// able to see it): marks one waybill (by HC document number) or all of them
// as signed.
ordersRouter.post("/:id/accounting-signed", async (req, res) => {
  if (!canConfirmOrders(req.user.role) && req.user.role !== "accountant") return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query("SELECT id, accounting_status, accounting_documents FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!["waybill_created", "partially_created", "exported_unsigned"].includes(order.accounting_status)) {
    return res.status(409).json({ error: "Nothing to sign yet" });
  }
  const number = req.body?.number;
  const docs = order.accounting_documents.map((d) =>
    !number || d.hc_doc_number === String(number) ? { ...d, einvoicing: { status: "signed", exported_at: d.einvoicing?.exported_at ?? null, signed_by: req.user.id } } : d
  );
  const next = nextStatusFromDocuments(order.accounting_status, docs);
  const { rows: updated } = await pool.query(
    "UPDATE orders SET accounting_documents = $2::jsonb, accounting_status = $3, accounting_updated_at = now() WHERE id = $1 RETURNING *",
    [order.id, JSON.stringify(docs), next]
  );
  res.json(updated[0]);
});

// A discounted order can't reach fulfillment until a sales director (or
// admin) approves or rejects it here -- see the approval_status gate on
// the fulfillment-status branch of PATCH /:id above.
ordersRouter.post("/:id/approve-discount", async (req, res) => {
  if (!canConfirmOrders(req.user.role)) {
    return res.status(403).json({ error: "Only a sales director can approve a discount" });
  }
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.approval_status !== "pending") {
    return res.status(409).json({ error: "This order has no pending discount to approve" });
  }
  // The sales director may approve only while every line stays at or above net cost; the CEO and admin may approve any.
  const { rows: costItems } = await pool.query("SELECT product_id, unit_price_amd, quantity FROM order_items WHERE order_id = $1", [order.id]);
  const subtotal = costItems.reduce((sum, l) => sum + Number(l.unit_price_amd) * Number(l.quantity), 0);
  const check = await orderCostCheck(pool, costItems, subtotal, Number(order.total_amd));
  if (!canApproveDiscountRole(req.user.role, check.belowCost)) {
    return res.status(403).json({ error: "This discount takes a line below net cost -- only the CEO or an admin can approve it" });
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET approval_status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
     WHERE id = $2 AND approval_status = 'pending' RETURNING *`,
    [req.user.id, order.id]
  );
  if (!updatedRows[0]) return res.status(409).json({ error: "This order has no pending discount to approve" });
  res.json(updatedRows[0]);

  (async () => {
    try {
      const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
      const customerName = customerRows[0]?.name || "Պատվերի";

      // Now that the discount is cleared, the accountant is the next stop --
      // same order_placed preference gate a rep's original order used.
      const { rows: accountants } = await pool.query("SELECT id FROM users WHERE role = 'accountant'");
      for (const accountant of accountants) {
        notifyUser(accountant.id, "order_placed", {
          title: "Պատվերի զեղչը հաստատվեց",
          body: `${customerName}-ի զեղչված պատվերը հաստատվել է և պատրաստ է կատարման համար։`,
          url: "/#/orders",
        });
      }
      if (req.user.id !== order.user_id) {
        notifyUser(order.user_id, "order_status_changed", {
          title: "Զեղչը հաստատվեց",
          body: `${customerName}-ի պատվերի զեղչը հաստատվել է։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-discount-approval notification failed:", err);
    }
  })();
});

// Credit-limit approval (migration 101): the directors and the accountant
// decide on an order that goes over the customer's credit limit.
async function decideCredit(req, res, decision) {
  // Directors and the accountant (canConfirmSubmittedOrders) decide on credit-limit exceptions.
  if (!canConfirmSubmittedOrders(req.user.role)) {
    return res.status(403).json({ error: "Only a director or the accountant can decide on a credit-limit exception" });
  }
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.credit_status !== "pending") {
    return res.status(409).json({ error: "This order has no pending credit-limit decision" });
  }
  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET credit_status = $3, credit_decided_by = $1, credit_decided_at = now(), updated_at = now()
     WHERE id = $2 AND credit_status = 'pending' RETURNING *`,
    [req.user.id, order.id, decision]
  );
  if (!updatedRows[0]) return res.status(409).json({ error: "This order has no pending credit-limit decision" });
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
     VALUES ($1, $2, $2, $3, $4)`,
    [order.id, order.status, decision === "approved" ? "Credit limit exception approved" : "Credit limit exception rejected", req.user.id]
  );
  res.json(updatedRows[0]);

  (async () => {
    try {
      const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
      const customerName = customerRows[0]?.name || "";
      if (req.user.id !== order.user_id) {
        notifyUser(order.user_id, "order_status_changed", {
          title: decision === "approved" ? "Վարկային սահմանի բացառությունը հաստատվեց" : "Վարկային սահմանի բացառությունը մերժվեց",
          body: `${customerName}-ի պատվերը՝ ${decision === "approved" ? "կարող է շարունակվել" : "պետք է փոքրացնել"}։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-credit-decision notification failed:", err);
    }
  })();
}
ordersRouter.post("/:id/approve-credit", (req, res) => decideCredit(req, res, "approved"));
ordersRouter.post("/:id/reject-credit", (req, res) => decideCredit(req, res, "rejected"));

ordersRouter.post("/:id/reject-discount", async (req, res) => {
  if (!canConfirmOrders(req.user.role)) {
    return res.status(403).json({ error: "Only a sales director can reject a discount" });
  }
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.approval_status !== "pending") {
    return res.status(409).json({ error: "This order has no pending discount to reject" });
  }

  const { rows: updatedRows } = await pool.query(
    `UPDATE orders SET approval_status = 'rejected', approved_by = $1, approved_at = now(), updated_at = now()
     WHERE id = $2 AND approval_status = 'pending' RETURNING *`,
    [req.user.id, order.id]
  );
  if (!updatedRows[0]) return res.status(409).json({ error: "This order has no pending discount to reject" });
  res.json(updatedRows[0]);

  (async () => {
    try {
      if (req.user.id !== order.user_id) {
        const { rows: customerRows } = await pool.query("SELECT name FROM customers WHERE id = $1", [order.customer_id]);
        notifyUser(order.user_id, "order_status_changed", {
          title: "Զեղչը մերժվեց",
          body: `${customerRows[0]?.name || "Պատվերի"} զեղչը մերժվել է -- խմբագրեք պատվերը կամ հեռացրեք զեղչը շարունակելու համար։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-discount-rejection notification failed:", err);
    }
  })();
});

// A director (or admin) rejects a freshly-submitted order -- the only way
// (besides an admin's permanent delete below) a submitted order leaves the
// review queue without being confirmed. Drops it back to "draft" with an
// optional note, same exception-loop shape as the warehouse/delivery
// reject paths (see routes/warehouse.js and routes/delivery.js).
ordersRouter.post("/:id/reject", async (req, res) => {
  if (!canConfirmOrders(req.user.role)) {
    return res.status(403).json({ error: "Only a director can reject a submitted order" });
  }
  const { note } = req.body ?? {};
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "submitted") {
    return res.status(409).json({ error: `Cannot reject an order that is "${order.status}" -- only a submitted order can be rejected` });
  }

  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'draft', draft_reason = $1, updated_at = now() WHERE id = $2 AND status = 'submitted' RETURNING *",
    [note?.trim() || null, order.id]
  );
  if (!updatedRows[0]) return res.status(409).json({ error: "Cannot reject an order that is no longer \"submitted\"" });
  await pool.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
     VALUES ($1, 'submitted', 'draft', $2, $3)`,
    [order.id, note?.trim() || "Rejected", req.user.id]
  );
  res.json(updatedRows[0]);

  (async () => {
    try {
      if (req.user.id !== order.user_id) {
        notifyUser(order.user_id, "order_status_changed", {
          title: "Պատվերը մերժվեց",
          body: `${order.customer_name}-ի պատվերը մերժվել է${note?.trim() ? `՝ ${note.trim()}` : ""} -- խմբագրեք և կրկին ուղարկեք։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-order-reject notification failed:", err);
    }
  })();
});

// Manual, route-independent packed_stock_out -> delivered transition -- for
// when there's no driver actively using the app to complete a route stop
// through delivery.js's signature-required /orders/:id/confirm. No POD/
// signature is captured here (there's no physical delivery event to attest
// to); this is purely an office-side status correction, gated to
// canMarkDeliveredWithoutRoute (driver/sales director/accountant/CEO/admin).
// Deliberately its own endpoint rather than added to GENERIC_PATCH_TARGETS
// above, for the same reason packed_stock_out/delivered are excluded from
// there -- so the normal signature-capturing path stays the only way to
// reach "delivered" for anyone NOT in this explicit override list.
// Manual twin of erpAutoMatch.autoDeliverOrdersFromErp: when the accountant
// changed the order in Excel (quantity, discount, date) the automatic match
// finds no unique twin and the order would wait for ever. These two endpoints
// list the free Excel orders of the same customer and let a person link one.
ordersRouter.get("/:id/erp-candidates", async (req, res) => {
  if (!canMarkDeliveredWithoutRoute(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.id, o.total_amd, o.created_at, c.erp_customer_id
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!order.erp_customer_id) return res.json([]);
  const { rows: candidates } = await pool.query(
    `SELECT l.order_id AS erp_order_id, MIN(l.order_date) AS order_date, ROUND(SUM(l.revenue_amd)) AS total_amd,
            ABS(ROUND(SUM(l.revenue_amd)) - ROUND($2::numeric)) AS diff_amd
     FROM erp_order_lines l
     WHERE l.erp_customer_id = $1
       AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.erp_matched_order_id = l.order_id)
     GROUP BY l.order_id
     HAVING MIN(l.order_date) >= (($3::timestamptz AT TIME ZONE 'Asia/Yerevan')::date - 30)
     ORDER BY diff_amd ASC, MIN(l.order_date) DESC
     LIMIT 20`,
    [order.erp_customer_id, order.total_amd, order.created_at]
  );
  res.json(candidates.map((c) => ({ ...c, total_amd: Number(c.total_amd), diff_amd: Number(c.diff_amd) })));
});

ordersRouter.post("/:id/link-erp", async (req, res) => {
  if (!canMarkDeliveredWithoutRoute(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const erpOrderId = String(req.body?.erp_order_id ?? "").trim();
  if (!erpOrderId) return res.status(400).json({ error: "erp_order_id is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.*, c.erp_customer_id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1 FOR UPDATE OF o`,
      [req.params.id]
    );
    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    if (order.status !== "confirmed" && order.status !== "packed_stock_out") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Only a confirmed or packed order can be linked (this one is "${order.status}")` });
    }
    const { rows: erpRows } = await client.query(
      `SELECT 1 FROM erp_order_lines l WHERE l.order_id = $1 AND l.erp_customer_id = $2
         AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.erp_matched_order_id = l.order_id) LIMIT 1`,
      [erpOrderId, order.erp_customer_id]
    );
    if (!erpRows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That Excel order is not available for this customer (wrong customer or already linked)" });
    }
    await client.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1 AND completed_at IS NULL", [order.id]);
    const { rows: updatedRows } = await client.query(
      "UPDATE orders SET status = 'delivered', delivered_from_erp = true, erp_matched_order_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [order.id, erpOrderId]
    );
    await client.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, 'delivered', $3, $4)`,
      [order.id, order.status, `Linked by hand to Excel order ${erpOrderId}`, req.user.id]
    );
    await client.query("COMMIT");
    res.json(updatedRows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

ordersRouter.post("/:id/mark-delivered", async (req, res) => {
  if (!canMarkDeliveredWithoutRoute(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "packed_stock_out") {
    return res.status(409).json({ error: `Cannot mark "${order.status}" as delivered -- only a packed order can be delivered` });
  }

  const client = await pool.connect();
  let updatedOrder;
  try {
    await client.query("BEGIN");
    // Closes out any route stop this order happened to be on (harmless
    // no-op if it was never routed) -- same bookkeeping delivery.js's own
    // confirm/fail endpoints do, so a driver's route screen doesn't keep
    // showing this order as an open stop after it's already been resolved
    // here.
    await client.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1 AND completed_at IS NULL", [order.id]);
    const { rows: updatedRows } = await client.query(
      "UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = 'packed_stock_out' RETURNING *",
      [order.id]
    );
    updatedOrder = updatedRows[0];
    if (!updatedOrder) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Cannot mark as delivered -- only a packed order can be delivered" });
    }
    await client.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
       VALUES ($1, 'packed_stock_out', 'delivered', 'Marked delivered (no route)', $2)`,
      [order.id, req.user.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json(updatedOrder);

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DELIVERY_OUTCOME_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        if (recipient.id === req.user.id) continue;
        notifyUser(recipient.id, "order_delivered", {
          title: "Պատվերն առաքվեց",
          body: `${order.customer_name}-ի պատվերը նշվել է որպես առաքված (առանց երթուղու)։`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-manual-delivery notification failed:", err);
    }
  })();
});

ordersRouter.patch("/:id/recorded", async (req, res) => {
  if (!canRecordOrders(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { recorded } = req.body ?? {};
  if (typeof recorded !== "boolean") return res.status(400).json({ error: "recorded (boolean) is required" });

  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Order not found" });
  if (rows[0].status !== "delivered") {
    return res.status(409).json({ error: "Only a delivered order can be marked recorded" });
  }

  const { rows: updatedRows } = await pool.query(
    recorded
      ? "UPDATE orders SET recorded = true, recorded_by = $1, recorded_at = now() WHERE id = $2 RETURNING *"
      : "UPDATE orders SET recorded = false, recorded_by = NULL, recorded_at = NULL WHERE id = $1 RETURNING *",
    recorded ? [req.user.id, req.params.id] : [req.params.id]
  );
  res.json(updatedRows[0]);
});

// Permanent removal (not the same as rejecting, which keeps the order as
// a record) -- admin-only, for a duplicate or mistaken order that
// shouldn't appear in reports at all. order_items cascades with it.
ordersRouter.delete("/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Order not found" });
  res.status(204).end();
});
