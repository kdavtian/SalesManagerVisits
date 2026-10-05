// Token-authenticated API for Lily, the AI accountant: she pulls orders that
// management has asked accounting to document (waybill / invoice), claims
// them, and reports the documents she created. She can read orders and write
// accounting status -- nothing else; see docs/lily-integration.md.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { hashToken } from "../integrationTokens.js";

export const integrationRouter = Router();

const ACCOUNTING_STATUSES = ["pending", "in_progress", "document_created", "exported_unsigned", "signed", "needs_attention"];

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

const ORDER_SELECT = `
  SELECT o.id, o.order_code, o.created_at, o.note, o.payment_method, o.discount_pct, o.discount_amd, o.total_amd,
         o.status AS kad_status, o.accounting_doc_type, o.accounting_status, o.accounting_is_test,
         o.accounting_requested_at, o.accounting_claimed_at, o.accounting_documents, o.accounting_error,
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
    created_at: o.created_at,
    // KAD has no requested ship date or destination warehouse; Lily applies
    // her own defaults (today / warehouse 04) when these are null.
    ship_date: null,
    destination_warehouse: null,
    customer: { name: o.customer_name, erp_customer_id: o.erp_customer_id, tax_id: o.customer_tin },
    note: o.note,
    doc_type: o.accounting_doc_type,
    payment_method: o.payment_method,
    waybill_status: o.accounting_status,
    kad_order_status: o.kad_status,
    is_test: o.accounting_is_test,
    discount_pct: Number(o.discount_pct),
    discount_amd: Number(o.discount_amd),
    total_amd: Number(o.total_amd),
    documents: o.accounting_documents,
    error: o.accounting_error,
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
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1 ${testScope(req)}`, [id]);
  if (!rows[0] || !rows[0].accounting_status) {
    fail(res, 404, "not_found", "Order not found");
    return null;
  }
  return rows[0];
}

// --- endpoints --------------------------------------------------------------

integrationRouter.get("/ping", (req, res) => {
  res.json({ ok: true, token: req.integration.name, test_mode: req.integration.test_mode });
});

// "Ready" = management confirmed the order in KAD and asked accounting for a
// document, which sets waybill_status to "pending".
integrationRouter.get("/orders", async (req, res) => {
  const status = req.query.waybill_status ?? "pending";
  if (!ACCOUNTING_STATUSES.includes(status)) return fail(res, 400, "invalid_status", `waybill_status must be one of ${ACCOUNTING_STATUSES.join(", ")}`);
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

integrationRouter.get("/orders/:id", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const items = await loadItems([order.id]);
  res.json(serializeOrder(order, items.get(order.id) ?? []));
});

// Atomic pending -> in_progress: two workers can't both win.
integrationRouter.post("/orders/:id/claim", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  const { rows } = await pool.query(
    `UPDATE orders SET accounting_status = 'in_progress', accounting_claimed_at = now(), accounting_updated_at = now(), accounting_error = NULL
     WHERE id = $1 AND accounting_status = 'pending' RETURNING id`,
    [order.id]
  );
  if (!rows[0]) return fail(res, 409, "not_pending", `Order is "${order.accounting_status}", only a pending order can be claimed`);
  const { rows: fresh } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1`, [order.id]);
  const items = await loadItems([order.id]);
  res.json(serializeOrder(fresh[0], items.get(order.id) ?? []));
});

// Reports the created document(s): one waybill per brand, or one invoice.
integrationRouter.post("/orders/:id/documents", reportDocuments);
integrationRouter.post("/orders/:id/waybills", reportDocuments);

async function reportDocuments(req, res) {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (!["in_progress", "document_created"].includes(order.accounting_status)) {
    return fail(res, 409, "invalid_state", `Order is "${order.accounting_status}"; claim it first`);
  }
  const body = req.body ?? {};
  const list = body.documents ?? body.waybills;
  if (!Array.isArray(list) || !list.length) return fail(res, 400, "invalid_body", "documents (or waybills) must be a non-empty array");
  const docs = [];
  for (const d of list) {
    if (!d || !d.number || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date ?? ""))) {
      return fail(res, 400, "invalid_document", "Each document needs a number and a YYYY-MM-DD date");
    }
    docs.push({
      type: d.type === "invoice" || order.accounting_doc_type === "invoice" ? "invoice" : "waybill",
      number: String(d.number),
      hc_id: d.hc_id ?? null,
      date: d.date,
      brand: d.brand ?? null,
      source_warehouse: d.source_warehouse ?? null,
      destination_warehouse: d.destination_warehouse ?? null,
      lines: Array.isArray(d.lines ?? d.items) ? (d.lines ?? d.items).map((l) => ({ line_id: l.line_id, quantity: Number(l.quantity) })) : [],
      export_status: null,
      reported_at: new Date().toISOString(),
    });
  }
  const merged = [...order.accounting_documents.filter((x) => !docs.some((d) => d.number === x.number)), ...docs];
  await pool.query(
    `UPDATE orders SET accounting_documents = $2::jsonb, accounting_status = 'document_created', accounting_error = NULL, accounting_updated_at = now() WHERE id = $1`,
    [order.id, JSON.stringify(merged)]
  );
  res.json({ id: orderRef(order.id), waybill_status: "document_created", documents: merged });
}

// SRC e-invoicing export result, for one document (by number) or all of them.
integrationRouter.post("/orders/:id/export", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (!["document_created", "exported_unsigned", "signed"].includes(order.accounting_status)) {
    return fail(res, 409, "invalid_state", `Order is "${order.accounting_status}"; report the document first`);
  }
  const { number, status, exported_at: exportedAt } = req.body ?? {};
  if (!["exported_unsigned", "signed"].includes(status)) return fail(res, 400, "invalid_status", "status must be exported_unsigned or signed");
  let touched = 0;
  const docs = order.accounting_documents.map((d) => {
    if (number && d.number !== String(number)) return d;
    touched += 1;
    return { ...d, export_status: status, exported_at: exportedAt ?? new Date().toISOString() };
  });
  if (!touched) return fail(res, 404, "document_not_found", "No document with that number on this order");
  const allSigned = docs.every((d) => d.export_status === "signed");
  const allExported = docs.every((d) => d.export_status);
  const next = allSigned ? "signed" : allExported ? "exported_unsigned" : "document_created";
  await pool.query(
    "UPDATE orders SET accounting_documents = $2::jsonb, accounting_status = $3, accounting_error = NULL, accounting_updated_at = now() WHERE id = $1",
    [order.id, JSON.stringify(docs), next]
  );
  res.json({ id: orderRef(order.id), waybill_status: next, documents: docs });
});

// "Not enough stock" and similar: Lily stops and reports instead of guessing.
integrationRouter.post("/orders/:id/problem", async (req, res) => {
  const order = await loadOrder(req, res);
  if (!order) return;
  if (order.accounting_status === "signed") return fail(res, 409, "invalid_state", "A signed order cannot be flagged");
  const { code, message, details } = req.body ?? {};
  if (!code || !message) return fail(res, 400, "invalid_body", "code and message are required");
  const error = { code: String(code), message: String(message), details: details ?? null, reported_at: new Date().toISOString() };
  await pool.query(
    "UPDATE orders SET accounting_status = 'needs_attention', accounting_error = $2::jsonb, accounting_updated_at = now() WHERE id = $1",
    [order.id, JSON.stringify(error)]
  );
  res.json({ id: orderRef(order.id), waybill_status: "needs_attention", error });
});

// KAD product -> HC code. Read-only for Lily; management maintains it in KAD.
integrationRouter.get("/product-mapping", async (req, res) => {
  const unmappedOnly = req.query.unmapped === "1" || req.query.unmapped === "true";
  const { rows } = await pool.query(
    `SELECT id, sku, name, brand, unit, hc_code FROM products WHERE active = true ${unmappedOnly ? "AND hc_code IS NULL" : ""} ORDER BY id`
  );
  res.json({
    products: rows.map((p) => ({ kad_product_id: p.id, kad_sku: p.sku, name: p.name, brand: p.brand, unit: p.unit, hc_code: p.hc_code })),
  });
});
