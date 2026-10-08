// Token-authenticated API for Lily, the AI accountant: she pulls orders that
// management has asked accounting to document (waybill / invoice), claims
// them, and reports the documents she created. She can read orders and write
// accounting status -- nothing else; see docs/lily-integration.md.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { hashToken } from "../integrationTokens.js";
import { nextStatusFromDocuments } from "../accountingStatus.js";
import { notifyUser } from "../notifications.js";
import { waitForQueueChange } from "../accountingEvents.js";

export const integrationRouter = Router();

const ACCOUNTING_STATUSES = ["pending", "in_progress", "waybill_created", "partially_created", "exported_unsigned", "signed", "needs_attention"];
const ISSUE_CODES = ["insufficient_stock", "unknown_product", "hc_unavailable", "mixed_destination", "other"];
// A claim that is never reported on is released after this long.
const CLAIM_TTL_MINUTES = 30;

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// --- auth + audit + idempotency -------------------------------------------

integrationRouter.use(async (req, res, next) => {
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return fail(res, 401, "unauthorized", "Missing bearer token");
  const { rows } = await pool.query(
    "SELECT id, name, test_mode FROM integration_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(match[1])]
  );
  if (!rows[0]) return fail(res, 401, "unauthorized", "Invalid or revoked token");
  req.integration = rows[0];
  pool.query("UPDATE integration_tokens SET last_used_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});

  res.on("finish", () => {
    pool
      .query(
        `INSERT INTO integration_audit_log (token_id, token_name, method, path, status_code, order_id, idempotency_key, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rows[0].id, rows[0].name, req.method, req.originalUrl.split("?")[0], res.statusCode, req.auditOrderId ?? null, req.get("idempotency-key") ?? null, req.ip]
      )
      .catch((err) => console.error("Integration audit log failed:", err));
  });
  next();
});

// Repeating a write with the same Idempotency-Key replays the first response
// instead of doing the work twice.
integrationRouter.use(async (req, res, next) => {
  const key = req.get("idempotency-key");
  if (!key || req.method === "GET") return next();
  const path = req.originalUrl.split("?")[0];
  const { rows } = await pool.query(
    "SELECT method, path, status_code, response_body FROM integration_idempotency WHERE token_id = $1 AND idempotency_key = $2",
    [req.integration.id, key]
  );
  if (rows[0]) {
    if (rows[0].method !== req.method || rows[0].path !== path) {
      return fail(res, 422, "idempotency_key_reused", "This Idempotency-Key was used for a different request");
    }
    res.set("Idempotent-Replay", "true");
    return res.status(rows[0].status_code).json(rows[0].response_body);
  }
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // Only successful or deterministic client-side outcomes are remembered.
    if (res.statusCode < 500) {
      pool
        .query(
          `INSERT INTO integration_idempotency (token_id, idempotency_key, method, path, status_code, response_body)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [req.integration.id, key, req.method, path, res.statusCode, JSON.stringify(body)]
        )
        .catch((err) => console.error("Integration idempotency store failed:", err));
    }
    return originalJson(body);
  };
  next();
});

// --- serialization ----------------------------------------------------------

function orderRef(id) {
  return `ord_${String(id).padStart(6, "0")}`;
}

function parseOrderRef(ref) {
  const match = /^(?:ord_)?0*(\d+)$/.exec(String(ref));
  return match ? Number(match[1]) : null;
}

// Timestamps go out as ISO 8601 with the Yerevan offset (UTC+4, no DST).
function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return new Date(d.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 19) + "+04:00";
}

// A claim nobody reported on within 30 minutes goes back to pending.
async function expireStaleClaims() {
  await pool.query(
    `UPDATE orders SET accounting_status = 'pending', accounting_claimed_at = NULL, accounting_updated_at = now()
     WHERE accounting_status = 'in_progress' AND accounting_claimed_at < now() - ($1 || ' minutes')::interval`,
    [String(CLAIM_TTL_MINUTES)]
  );
}

const ORDER_SELECT = `
  SELECT o.id, o.order_code, o.created_at, o.note, o.payment_method, o.discount_pct, o.discount_amd, o.total_amd,
         o.status AS kad_status, o.accounting_doc_type, o.accounting_status, o.accounting_is_test,
         o.accounting_requested_at, o.accounting_requested_by, o.accounting_claimed_at, o.accounting_documents, o.accounting_error,
         c.name AS customer_name, c.erp_customer_id, c.tin AS customer_tin
  FROM orders o
  JOIN customers c ON c.id = o.customer_id`;

async function loadItems(orderIds) {
  if (!orderIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT oi.id, oi.order_id, oi.product_name, oi.brand, oi.unit_price_amd, oi.quantity, oi.line_total_amd,
            p.sku, p.hc_code, p.unit
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1) ORDER BY oi.id`,
    [orderIds]
  );
  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
    byOrder.get(r.order_id).push({
      line_id: `ln_${r.id}`,
      hc_code: r.hc_code,
      kad_sku: r.sku,
      name: r.product_name,
      brand: r.brand,
      quantity: Number(r.quantity),
      unit: r.unit || "pcs",
      unit_price_amd: Number(r.unit_price_amd),
      line_total_amd: Number(r.line_total_amd),
    });
  }
  return byOrder;
}

function serializeOrder(o, items) {
  return {
    id: orderRef(o.id),
    number: o.order_code || `KAD-${o.id}`,
    created_at: iso(o.created_at),
    // KAD has no requested ship date or destination warehouse; Lily applies
    // her defaults (today / warehouse 04) when these are null.
    ship_date: null,
    destination_warehouse: null,
    customer: { name: o.customer_name, tax_id: o.customer_tin, erp_customer_id: o.erp_customer_id },
    note: o.note,
    waybill_status: o.accounting_status,
    doc_type: o.accounting_doc_type,
    payment_method: o.payment_method,
    kad_order_status: o.kad_status,
    is_test: o.accounting_is_test,
    discount_pct: Number(o.discount_pct),
    discount_amd: Number(o.discount_amd),
    total_amd: Number(o.total_amd),
    waybills: o.accounting_documents,
    issue: o.accounting_error,
    items,
  };
}

// A normal token only ever sees real orders, a test-mode token only ever
// sees orders management flagged as test -- so the integration can be tried
// end to end without touching real orders.
function testScope(req) {
  return req.integration.test_mode ? "AND o.accounting_is_test = true" : "AND o.accounting_is_test = false";
}

async function loadOrder(req, res) {
  const id = parseOrderRef(req.params.id);
  if (!id) {
    fail(res, 404, "not_found", "Order not found");
    return null;
  }
  req.auditOrderId = id;
  await expireStaleClaims();
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1 ${testScope(req)}`, [id]);
  if (!rows[0] || !rows[0].accounting_status) {
    fail(res, 404, "not_found", "Order not found");
    return null;
  }
  return rows[0];
}

async function respondWithOrder(res, id) {
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
  const items = await loadItems([id]);
  res.json(serializeOrder(rows[0], items.get(id) ?? []));
}

// --- endpoints --------------------------------------------------------------

integrationRouter.get("/ping", (req, res) => {
  res.json({ ok: true, token: req.integration.name, test_mode: req.integration.test_mode });
});

// Tell whoever sent the order to accounting what Lily just did, at once.
async function notifyRequester(order, title, body) {
  if (!order.accounting_requested_by) return;
  try {
    await notifyUser(order.accounting_requested_by, "accounting_update", { title, body: `${order.customer_name} · ${order.order_code || `KAD-${order.id}`}: ${body}`, url: "/#/orders" });
  } catch (err) {
    console.error("Accounting notification failed:", err);
  }
}

// Long-poll: "tell me the moment there is something to do". Returns at once
// when orders are waiting, otherwise holds the call open (<= 25 s, re-checking
// the database every 5 s) and returns as soon as KAD puts an order in the
// queue. Lily calls it in a loop, so a new request reaches her within a
// moment instead of on her next scheduled poll; the same calls also tell KAD
// she is online.
async function pendingOrderRefs(req) {
  await expireStaleClaims();
  const { rows } = await pool.query(
    `SELECT o.id FROM orders o WHERE o.accounting_status = 'pending' ${testScope(req)} ORDER BY o.accounting_requested_at LIMIT 50`
  );
  return rows.map((r) => orderRef(r.id));
}

integrationRouter.get("/wait", async (req, res) => {
  const timeoutMs = Math.min(Math.max(Number(req.query.timeout) || 25, 1), 25) * 1000;
  const startedAt = Date.now();
  let orders = await pendingOrderRefs(req);
  while (!orders.length && Date.now() - startedAt < timeoutMs && !req.aborted) {
    await waitForQueueChange(Math.min(5000, timeoutMs - (Date.now() - startedAt)));
    orders = await pendingOrderRefs(req);
  }
  pool.query("UPDATE integration_tokens SET last_used_at = now() WHERE id = $1", [req.integration.id]).catch(() => {});
  res.json({ pending: orders.length, orders });
});

// 3.1  "Ready" = management confirmed the order in KAD and asked accounting
// for the document, which sets waybill_status to "pending".
integrationRouter.get("/orders", async (req, res) => {
  const status = req.query.waybill_status ?? "pending";
  if (!ACCOUNTING_STATUSES.includes(status)) return fail(res, 400, "invalid_status", `waybill_status must be one of ${ACCOUNTING_STATUSES.join(", ")}`);
  await expireStaleClaims();
  const params = [status];
  let docFilter = "";
  if (req.query.doc_type !== undefined) {
    if (!["waybill", "invoice"].includes(req.query.doc_type)) return fail(res, 400, "invalid_doc_type", "doc_type must be waybill or invoice");
    params.push(req.query.doc_type);
    docFilter = `AND o.accounting_doc_type = $${params.length}`;
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  params.push(limit);
  const { rows } = await pool.query(
    `${ORDER_SELECT}
     WHERE o.accounting_status = $1 ${docFilter} ${testScope(req)}
     ORDER BY o.accounting_requested_at, o.id LIMIT $${params.length}`,
    params
  );
  const items = await loadItems(rows.map((r) => r.id));
  res.json({ orders: rows.map((r) => serializeOrder(r, items.get(r.id) ?? [])) });
});

// 3.2
integrationRouter.get("/orders/:id", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const items = await loadItems([order.id]);
  res.json(serializeOrder(order, items.get(order.id) ?? []));
});

// 3.3  Atomic pending -> in_progress: two workers can't both win.
integrationRouter.post("/orders/:id/claim", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const { rows } = await pool.query(
    `UPDATE orders SET accounting_status = 'in_progress', accounting_claimed_at = now(), accounting_updated_at = now(), accounting_error = NULL
     WHERE id = $1 AND accounting_status = 'pending' RETURNING id`,
    [order.id]
  );
  if (!rows[0]) return fail(res, 409, "not_pending", `Order is "${order.accounting_status}", only a pending order can be claimed`);
  await respondWithOrder(res, order.id);
});

// 3.4  One waybill per brand: report one or several. Quantities per line are
// summed across waybills; when every line is covered the order is
// waybill_created, otherwise partially_created.
integrationRouter.post("/orders/:id/waybills", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (!["in_progress", "partially_created", "waybill_created"].includes(order.accounting_status)) {
    return fail(res, 409, "invalid_state", `Order is "${order.accounting_status}"; claim it first`);
  }
  const list = req.body?.waybills;
  if (!Array.isArray(list) || !list.length) return fail(res, 400, "invalid_body", "waybills must be a non-empty array");
  const incoming = [];
  for (const w of list) {
    if (!w || !w.hc_doc_number || !/^\d{4}-\d{2}-\d{2}$/.test(String(w.date ?? ""))) {
      return fail(res, 400, "invalid_waybill", "Each waybill needs hc_doc_number and a YYYY-MM-DD date");
    }
    const lines = Array.isArray(w.items) ? w.items : [];
    if (lines.some((l) => !l || !l.line_id || !Number.isFinite(Number(l.quantity)))) {
      return fail(res, 400, "invalid_waybill", "Each waybill item needs line_id and a numeric quantity");
    }
    incoming.push({
      hc_doc_number: String(w.hc_doc_number),
      hc_isn: w.hc_isn ?? null,
      date: w.date,
      warehouse_from: w.warehouse_from ?? null,
      warehouse_to: w.warehouse_to ?? null,
      brand: w.brand ?? null,
      items: lines.map((l) => ({ line_id: l.line_id, hc_code: l.hc_code ?? null, quantity: Number(l.quantity) })),
      created_at: w.created_at ?? null,
      reported_at: iso(new Date()),
      einvoicing: null,
    });
  }
  // Re-sending a document number replaces it but keeps any e-invoicing result.
  const existing = order.accounting_documents;
  const merged = [
    ...existing.filter((x) => !incoming.some((d) => d.hc_doc_number === x.hc_doc_number)),
    ...incoming.map((d) => ({ ...d, einvoicing: existing.find((x) => x.hc_doc_number === d.hc_doc_number)?.einvoicing ?? null })),
  ];

  const orderedItems = (await loadItems([order.id])).get(order.id) ?? [];
  const covered = new Map();
  for (const w of merged) for (const l of w.items) covered.set(l.line_id, (covered.get(l.line_id) ?? 0) + l.quantity);
  const unknown = [...covered.keys()].filter((id) => !orderedItems.some((i) => i.line_id === id));
  if (unknown.length) return fail(res, 400, "unknown_line", `Unknown line_id: ${unknown.join(", ")}`);
  const complete = orderedItems.every((i) => (covered.get(i.line_id) ?? 0) >= i.quantity);
  const next = !complete ? "partially_created" : "waybill_created";

  await pool.query(
    "UPDATE orders SET accounting_documents = $2::jsonb, accounting_status = $3, accounting_error = NULL, accounting_updated_at = now() WHERE id = $1",
    [order.id, JSON.stringify(merged), next]
  );
  if (next !== order.accounting_status) {
    await notifyRequester(order, next === "partially_created" ? "Բեռնագիրը մասամբ ստեղծված է" : "Փաստաթուղթը ստեղծված է", next === "partially_created" ? "մի մասը դեռ սպասում է" : "Լիլին ստեղծեց փաստաթուղթը");
  }
  res.json({ id: orderRef(order.id), waybill_status: next, waybills: merged });
});

// 3.5  SRC e-invoicing result for one waybill. The order is
// exported_unsigned once every waybill is exported, signed once all are signed.
integrationRouter.post("/orders/:id/waybills/:number/einvoicing", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const { exported_at: exportedAt, status } = req.body ?? {};
  if (!["exported_unsigned", "signed"].includes(status)) return fail(res, 400, "invalid_status", "status must be exported_unsigned or signed");
  const docs = order.accounting_documents;
  const doc = docs.find((d) => d.hc_doc_number === req.params.number);
  if (!doc) return fail(res, 404, "waybill_not_found", "No waybill with that number on this order");
  doc.einvoicing = { status, exported_at: exportedAt ?? iso(new Date()) };
  const next = nextStatusFromDocuments(order.accounting_status, docs);
  await pool.query(
    "UPDATE orders SET accounting_documents = $2::jsonb, accounting_status = $3, accounting_error = NULL, accounting_updated_at = now() WHERE id = $1",
    [order.id, JSON.stringify(docs), next]
  );
  if (next === "signed" && order.accounting_status !== "signed") {
    await notifyRequester(order, "Փաստաթուղթը ստորագրված է", "ստորագրված է");
  }
  res.json({ id: orderRef(order.id), waybill_status: next, waybills: docs });
});

// Signed copy of a document, sent by Lily as the raw PDF body:
//   POST /orders/{id}/documents?filename=...&hc_doc_number=...   Content-Type: application/pdf
// Stored in the database and shown on the order, the customer and the
// Accounting tab. Re-sending the same hc_doc_number replaces that file.
integrationRouter.post("/orders/:id/documents", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) return fail(res, 400, "invalid_body", "Send the PDF as the raw request body with Content-Type: application/pdf");
  if (body.subarray(0, 5).toString("latin1") !== "%PDF-") return fail(res, 400, "not_a_pdf", "The file is not a PDF");
  const number = req.query.hc_doc_number ? String(req.query.hc_doc_number).slice(0, 60) : null;
  const rawName = String(req.query.filename || "").split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  const filename = rawName || `${order.order_code || `KAD-${order.id}`}${number ? `-${number}` : ""}.pdf`;
  const { rows } = number
    ? await pool.query(
        `INSERT INTO order_documents (order_id, hc_doc_number, filename, size_bytes, data, uploaded_by_token)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (order_id, hc_doc_number) WHERE hc_doc_number IS NOT NULL
         DO UPDATE SET filename = EXCLUDED.filename, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data, uploaded_by_token = EXCLUDED.uploaded_by_token, created_at = now()
         RETURNING id, hc_doc_number, filename, size_bytes, created_at, (xmax = 0) AS inserted`,
        [order.id, number, filename, body.length, body, req.integration.id]
      )
    : await pool.query(
        `INSERT INTO order_documents (order_id, filename, size_bytes, data, uploaded_by_token)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, hc_doc_number, filename, size_bytes, created_at, true AS inserted`,
        [order.id, filename, body.length, body, req.integration.id]
      );
  if (rows[0].inserted) await notifyRequester(order, "Ստորագրված պատճենը պահպանված է", "ստորագրված պատճենը ավելացվեց");
  const { inserted, ...doc } = rows[0];
  res.status(inserted ? 201 : 200).json({ id: orderRef(order.id), document: doc });
});

// 3.6  KAD product -> HC code. Read-only for Lily; management maintains it in KAD.
integrationRouter.get("/products", productMapping);
integrationRouter.get("/product-mapping", productMapping);

async function productMapping(req, res) {
  const params = [];
  const conditions = [];
  if (req.query.updated_since) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(req.query.updated_since))) return fail(res, 400, "invalid_date", "updated_since must be YYYY-MM-DD");
    params.push(req.query.updated_since);
    conditions.push(`updated_at >= $${params.length}::date`);
  }
  if (req.query.unmapped === "1" || req.query.unmapped === "true") conditions.push("hc_code IS NULL");
  const { rows } = await pool.query(
    `SELECT id, sku, name, brand, unit, hc_code, active FROM products ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id`,
    params
  );
  res.json({
    products: rows.map((p) => ({ kad_sku: p.sku, hc_code: p.hc_code, brand: p.brand, name: p.name, unit: p.unit || "pcs", active: p.active, kad_product_id: p.id })),
  });
}

// 3.7  "Not enough stock" and similar: Lily stops and reports instead of
// guessing; the claim is released (the order waits for a human).
integrationRouter.post("/orders/:id/issue", reportIssue);
integrationRouter.post("/orders/:id/problem", reportIssue);

async function reportIssue(req, res) {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.accounting_status === "signed") return fail(res, 409, "invalid_state", "A signed order cannot be flagged");
  const { code, message, lines } = req.body ?? {};
  if (!code || !message) return fail(res, 400, "invalid_body", "code and message are required");
  if (!ISSUE_CODES.includes(code)) return fail(res, 400, "invalid_code", `code must be one of ${ISSUE_CODES.join(", ")}`);
  const issue = { code, message: String(message), lines: Array.isArray(lines) ? lines : [], reported_at: iso(new Date()) };
  await pool.query(
    "UPDATE orders SET accounting_status = 'needs_attention', accounting_error = $2::jsonb, accounting_claimed_at = NULL, accounting_updated_at = now() WHERE id = $1",
    [order.id, JSON.stringify(issue)]
  );
  await notifyRequester(order, "Պահանջվում է ուշադրություն", String(message).slice(0, 200));
  res.json({ id: orderRef(order.id), waybill_status: "needs_attention", issue });
}
