// Purchases (owner, 2026-11-07): supplier invoices typed in the app with the Excel Purchase_IN columns (invoice no., date, supplier,
// product, packs, USD per pack, the invoice's USD rate), and the side-by-side check against the Purchase_IN rows the bot sends
// (erp_purchase_lines). Excel stays the source of stock until the owner switches the module over (docs/KDS-excel-off-single-erp.md, P4).
// An invoice is matched app <-> Excel by its number (case and spaces ignored) and date; it "matches" when the packs and the USD total agree.
import { pool } from "../db/pool.js";
import { APP_STOCK_SQL } from "../orders/appStock.js";

const USD_TOLERANCE = 0.05; // rounding in the workbook's own SUM column
const keyOf = (invoiceNo, date) => `${String(invoiceNo ?? "").trim().toLowerCase().replace(/\s+/g, " ")}|${String(date).slice(0, 10)}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
// a supplier's name as both sides write it: case and extra spaces ignored ("Sole  Trans " = "sole trans")
const supplierKey = (name) => String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export class PurchaseError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra); // code ("duplicate"), existingId
  }
}
// The same invoice number the Excel copy is compared by: case and extra spaces ignored (SQL form of keyOf)
const SQL_KEY = (col) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;
// supplierKey in SQL: tabs, new lines and no-break spaces count as spaces too, the same as JavaScript's \s (review, 2026-11-20)
const SQL_SUPPLIER_KEY = (col) => `lower(btrim(regexp_replace(COALESCE(${col}, ''), '[[:space:]' || chr(160) || ']+', ' ', 'g')))`;

function cleanLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new PurchaseError("At least one line is required");
  if (lines.length > 500) throw new PurchaseError("At most 500 lines");
  return lines.map((l) => {
    const qty = Number(l?.qty);
    const cost = Number(l?.cost_usd);
    const productId = l?.product_id == null || l.product_id === "" ? null : Number(l.product_id);
    if (!Number.isFinite(qty) || qty <= 0) throw new PurchaseError("Every line needs a positive number of packs");
    if (!Number.isFinite(cost) || cost < 0) throw new PurchaseError("Every line needs a USD price per pack (0 or more)");
    if (productId !== null && !Number.isInteger(productId)) throw new PurchaseError("product_id must be a whole number");
    return { product_id: productId, qty, cost_usd: cost, product_name: l?.product_name ? String(l.product_name).trim().slice(0, 200) : null, brand: l?.brand ?? null, size_l: l?.size_l ?? null };
  });
}

/** Creates or updates one invoice (id = null: new). Returns the invoice id. A repeated client_ref returns the invoice it already made. */
export const PURCHASE_STATUSES = ["ordered", "in_transit", "arrived"];

export async function savePurchase(body, userId, id = null, db = pool) {
  const invoiceNo = String(body?.invoice_no ?? "").trim();
  const date = String(body?.invoice_date ?? "").slice(0, 10);
  const rawRate = body?.usd_rate === null || body?.usd_rate === undefined || body?.usd_rate === "" ? null : Number(body.usd_rate);
  // Ordered -> On the way -> Arrived (P5, owner 2026-11-20). An Ordered purchase needs no invoice number or rate yet; the others do.
  const askedStatus = body?.status === undefined ? null : String(body.status);
  if (askedStatus !== null && !PURCHASE_STATUSES.includes(askedStatus)) throw new PurchaseError("status must be ordered, in_transit or arrived");
  const expected = body?.expected_date ? String(body.expected_date).slice(0, 10) : null;
  if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) throw new PurchaseError("expected_date must be YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PurchaseError("invoice_date must be YYYY-MM-DD");
  if (rawRate !== null && (!Number.isFinite(rawRate) || rawRate <= 0 || rawRate > 10000)) throw new PurchaseError("usd_rate must be a positive number");
  const lines = cleanLines(body?.lines);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = id ? (await client.query("SELECT status FROM purchase_invoices WHERE id = $1 FOR UPDATE", [id])).rows[0] : null;
    if (id && !current) throw new PurchaseError("Purchase not found");
    const status = askedStatus ?? current?.status ?? "arrived";
    const rate = rawRate;
    if (status !== "ordered") {
      if (!invoiceNo) throw new PurchaseError("The invoice number is required");
      if (rate === null) throw new PurchaseError("usd_rate must be a positive number");
    }
    if (!id && body?.client_ref) {
      const { rows } = await client.query("SELECT id FROM purchase_invoices WHERE client_ref = $1", [String(body.client_ref)]);
      if (rows[0]) {
        await client.query("ROLLBACK");
        return rows[0].id;
      }
    }
    let supplierId = body?.supplier_id ? Number(body.supplier_id) : null;
    if (!supplierId) {
      const name = String(body?.supplier_name ?? "").trim();
      if (!name) throw new PurchaseError("Choose the supplier");
      const { rows } = await client.query(
        "INSERT INTO suppliers (name) VALUES ($1) ON CONFLICT (lower(name)) DO UPDATE SET name = suppliers.name RETURNING id",
        [name.slice(0, 120)]
      );
      supplierId = rows[0].id;
    }
    // The same supplier's same invoice number on the same day is almost always a second typing of one invoice (owner, 2026-11-07: ultra
    // version). Refused with the existing one named; the form offers "Save anyway" for the rare real repeat (allow_duplicate).
    if (!body?.allow_duplicate && invoiceNo) {
      // two people saving the same paper invoice at the same moment: one waits for the other, then sees it (the lock ends with the transaction)
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`purchase:${supplierId}:${keyOf(invoiceNo, date)}`]);
      const { rows: same } = await client.query(
        `SELECT id FROM purchase_invoices WHERE supplier_id = $1 AND invoice_date = $2::date AND ${SQL_KEY("invoice_no")} = ${SQL_KEY("$3::text")} AND id <> $4 LIMIT 1`,
        [supplierId, date, invoiceNo, id ?? 0]
      );
      if (same[0]) throw new PurchaseError("This supplier's invoice with this number and date is already entered", { code: "duplicate", existingId: same[0].id });
    }
    // each line keeps the product's name, brand and size as they were (the catalog can change later)
    const ids = lines.map((l) => l.product_id).filter(Boolean);
    const { rows: products } = ids.length ? await client.query("SELECT id, name, brand, unit, size_l FROM products WHERE id = ANY($1)", [ids]) : { rows: [] };
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const l of lines) {
      const p = l.product_id ? byId.get(l.product_id) : null;
      if (l.product_id && !p) throw new PurchaseError("A line names a product that does not exist");
      l.product_name = p?.name ?? (l.product_name ? String(l.product_name).trim().slice(0, 200) : null);
      if (!l.product_name) throw new PurchaseError("Every line needs a product");
      // a line without a catalogue product (an Excel line the app does not know, a product deleted later) keeps its own brand and litres
      const ownSize = Number(l.size_l);
      l.brand = p ? p.brand ?? null : l.brand ? String(l.brand).trim().slice(0, 80) : null;
      l.size_l = p ? (Number(p.size_l) || Number(String(p.unit ?? "").replace(",", ".").match(/[\d.]+/)?.[0]) || null) : Number.isFinite(ownSize) && ownSize > 0 && ownSize <= 1000 ? ownSize : null;
    }
    let invoiceId = id;
    const before = id ? await invoiceFacts(client, id) : null;
    // the office marks it Arrived from the form: who and when, as the receiving screen would
    const becomesArrived = status === "arrived" && (!current || current.status !== "arrived");
    const counted = new Map();
    if (id) {
      // the pieces counted on arrival stay with their product through an edit (the lines are written again)
      const { rows: old } = await client.query("SELECT product_id, received_qty FROM purchase_lines WHERE invoice_id = $1 AND received_qty IS NOT NULL ORDER BY id", [id]);
      for (const o of old) if (o.product_id && !counted.has(o.product_id)) counted.set(o.product_id, o.received_qty);
      const { rowCount } = await client.query(
        `UPDATE purchase_invoices SET invoice_no = $2, invoice_date = $3, supplier_id = $4, usd_rate = $5, note = $6, updated_by = $7, updated_at = now(),
                status = $8, expected_date = $9,
                arrived_at = CASE WHEN $10 THEN now() ELSE arrived_at END, arrived_by = CASE WHEN $10 THEN $7::int ELSE arrived_by END
          WHERE id = $1`,
        [id, invoiceNo || null, date, supplierId, rate, body?.note ? String(body.note).slice(0, 1000) : null, userId, status, expected, becomesArrived]
      );
      if (!rowCount) throw new PurchaseError("Purchase not found");
      await client.query("DELETE FROM purchase_lines WHERE invoice_id = $1", [id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, note, client_ref, created_by, updated_by, status, expected_date, arrived_at, arrived_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, CASE WHEN $8 = 'arrived' THEN now() END, CASE WHEN $8 = 'arrived' THEN $7::int END) RETURNING id`,
        [invoiceNo || null, date, supplierId, rate, body?.note ? String(body.note).slice(0, 1000) : null, body?.client_ref ? String(body.client_ref) : null, userId, status, expected]
      );
      invoiceId = rows[0].id;
    }
    for (const l of lines) {
      const got = l.product_id && counted.has(l.product_id) ? counted.get(l.product_id) : null;
      if (l.product_id) counted.delete(l.product_id);
      await client.query(
        "INSERT INTO purchase_lines (invoice_id, product_id, product_name, brand, size_l, qty, cost_usd, received_qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [invoiceId, l.product_id, l.product_name, l.brand, l.size_l, l.qty, l.cost_usd, got]
      );
    }
    const after = await invoiceFacts(client, invoiceId);
    await logPurchase(client, { invoiceId, action: id ? "update" : "create", userId, facts: after, details: id ? changesOf(before, after) : { after: totalsOf(after) } });
    await client.query("COMMIT");
    return invoiceId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- history (purchase_log, migration 218; owner plan P3, 2026-11-20) ------------------------------------------------------------------
// The head and the totals of one invoice: what an entry of the history compares.
export async function invoiceFacts(db, id) {
  const { rows: [f] } = await db.query(
    `SELECT i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, s.name AS supplier, i.usd_rate::float8 AS usd_rate, i.status,
            to_char(i.expected_date, 'YYYY-MM-DD') AS expected_date,
            count(l.id)::int AS lines, COALESCE(sum(l.qty), 0)::float8 AS packs, COALESCE(sum(l.qty * l.cost_usd), 0)::float8 AS usd
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN purchase_lines l ON l.invoice_id = i.id
      WHERE i.id = $1 GROUP BY i.id, s.name`,
    [id]
  );
  return f ?? null;
}
const totalsOf = (f) => (f ? { lines: f.lines, packs: Math.round(f.packs * 1000) / 1000, usd: round2(f.usd) } : null);
// what an edit changed: the head fields that differ, and the totals before and after
function changesOf(before, after) {
  const fields = {};
  for (const k of ["invoice_no", "invoice_date", "supplier", "usd_rate", "status", "expected_date"]) {
    if (before && after && String(before[k] ?? "") !== String(after[k] ?? "")) fields[k] = [before[k], after[k]];
  }
  return { fields, before: totalsOf(before), after: totalsOf(after) };
}
export async function logPurchase(db, { invoiceId, action, userId, facts = null, details = null }) {
  await db.query(
    "INSERT INTO purchase_log (invoice_id, invoice_no, supplier, action, user_id, details) VALUES ($1, $2, $3, $4, $5, $6)",
    [invoiceId, facts?.invoice_no ?? null, facts?.supplier ?? null, action, userId ?? null, details ? JSON.stringify(details) : null]
  );
}
export async function purchaseLog(id, db = pool) {
  const { rows } = await db.query(
    `SELECT g.action, g.at, g.details, u.name AS user_name FROM purchase_log g LEFT JOIN users u ON u.id = g.user_id
      WHERE g.invoice_id = $1 ORDER BY g.at DESC, g.id DESC LIMIT 100`,
    [id]
  );
  return rows;
}
// the files (a photo / PDF of the paper) of one invoice
export async function purchaseFiles(id, db = pool) {
  const { rows } = await db.query(
    `SELECT f.id, f.mime, f.size_bytes, f.original_name, f.created_at, u.name AS created_by_name
       FROM purchase_files f LEFT JOIN users u ON u.id = f.created_by WHERE f.invoice_id = $1 ORDER BY f.id`,
    [id]
  );
  return rows;
}

// ---- receiving (P5, owner 2026-11-20) --------------------------------------------------------------------------------------------------
// The purchases on their way (Ordered / On the way) and the ones that arrived in the last 7 days, for the warehouse: quantities, no money.
export async function incomingPurchases(db = pool) {
  const { rows: invoices } = await db.query(
    `SELECT i.id, i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, s.name AS supplier, i.status, to_char(i.expected_date, 'YYYY-MM-DD') AS expected_date,
            i.arrived_at, i.arrival_note
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status <> 'arrived' OR i.arrived_at >= now() - interval '7 days'
      ORDER BY (i.status = 'arrived'), COALESCE(i.expected_date, i.invoice_date), i.id
      LIMIT 200`
  );
  if (!invoices.length) return [];
  const { rows: lines } = await db.query(
    `SELECT id, invoice_id, product_id, product_name, brand, size_l::float8 AS size_l, qty::float8 AS qty, received_qty::float8 AS received_qty
       FROM purchase_lines WHERE invoice_id = ANY($1) ORDER BY id`,
    [invoices.map((i) => i.id)]
  );
  const byInvoice = new Map(invoices.map((i) => [i.id, { ...i, lines: [] }]));
  for (const l of lines) byInvoice.get(l.invoice_id)?.lines.push(l);
  return [...byInvoice.values()];
}

// The count of a purchase that came: each line's pieces received, then Arrived. A count that differs from the invoice is written in the
// history and gives every accountant a task (owner decision: "Show + task"). Returns { differences }.
export async function receivePurchase(id, body, user, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: [inv] } = await client.query("SELECT id, status FROM purchase_invoices WHERE id = $1 FOR UPDATE", [id]);
    if (!inv) throw new PurchaseError("Purchase not found");
    const { rows: lines } = await client.query("SELECT id, product_name, brand, qty::float8 AS qty, received_qty FROM purchase_lines WHERE invoice_id = $1 ORDER BY id", [id]);
    if (inv.status === "arrived" && lines.every((l) => l.received_qty !== null)) throw new PurchaseError("This purchase is already received", { code: "received" });
    const given = new Map((Array.isArray(body?.lines) ? body.lines : []).map((l) => [Number(l?.id), l?.received_qty]));
    const differences = [];
    for (const l of lines) {
      const raw = given.get(l.id);
      const got = raw === undefined || raw === null || raw === "" ? l.qty : Number(raw); // a line not counted = all came
      if (!Number.isFinite(got) || got < 0 || got > 1e9) throw new PurchaseError("Every line needs the pieces received (0 or more)");
      await client.query("UPDATE purchase_lines SET received_qty = $2 WHERE id = $1", [l.id, got]);
      if (Math.abs(got - l.qty) > 0.0005) differences.push({ product: [l.brand, l.product_name].filter(Boolean).join(" "), invoiced: l.qty, received: got });
    }
    const note = body?.note ? String(body.note).trim().slice(0, 1000) : null;
    await client.query("UPDATE purchase_invoices SET status = 'arrived', arrived_at = now(), arrived_by = $2, arrival_note = $3, updated_at = now() WHERE id = $1", [id, user.id, note]);
    const facts = await invoiceFacts(client, id);
    await logPurchase(client, { invoiceId: id, action: "receive", userId: user.id, facts, details: { differences, note } });
    if (differences.length) {
      const { rows: accountants } = await client.query("SELECT id FROM users WHERE role = 'accountant' AND status = 'active' ORDER BY id");
      const title = `Գնման տարբերություն՝ ${facts?.supplier ?? ""}${facts?.invoice_no ? ` № ${facts.invoice_no}` : ""}`.slice(0, 120);
      for (const a of accountants) {
        const { rows: [t] } = await client.query(
          "INSERT INTO tasks (title, creator_id, assignee_id, due_date, auto_kind) VALUES ($1, $2, $2, CURRENT_DATE, 'purchase_difference') RETURNING id",
          [title, a.id]
        );
        for (const [k, d] of differences.entries()) {
          await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [t.id, `${d.product}: հաշվում ${d.invoiced}, ստացվել է ${d.received}`.slice(0, 300), k]);
        }
        if (note) await client.query("INSERT INTO task_items (task_id, text, sort_order) VALUES ($1, $2, $3)", [t.id, `Նշում՝ ${note}`.slice(0, 300), differences.length]);
      }
    }
    await client.query("COMMIT");
    return { differences };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Pieces already Ordered / On the way per product: Warehouse > To order subtracts them (owner decision P5)
export async function incomingQtyByProduct(db = pool) {
  const { rows } = await db.query(
    `SELECT l.product_id, sum(l.qty)::float8 AS qty FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id
      WHERE i.status IN ('ordered', 'in_transit') AND l.product_id IS NOT NULL GROUP BY l.product_id`
  );
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

// ---- export (owner plan P3): every line of the period, app and Excel-only invoices, one row each ---------------------------------------
export async function exportPurchaseRows({ from = null, to = null } = {}, db = pool) {
  const invoices = await listPurchases({ from, to }, db);
  const appIds = invoices.filter((r) => r.id).map((r) => r.id);
  const { rows: appLines } = appIds.length
    ? await db.query(
        "SELECT invoice_id, product_name, brand, size_l::float8 AS size_l, qty::float8 AS qty, cost_usd::float8 AS cost_usd FROM purchase_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, id",
        [appIds]
      )
    : { rows: [] };
  const byInvoice = new Map();
  for (const l of appLines) {
    if (!byInvoice.has(l.invoice_id)) byInvoice.set(l.invoice_id, []);
    byInvoice.get(l.invoice_id).push(l);
  }
  const out = [];
  for (const r of invoices) {
    const lines = r.id ? byInvoice.get(r.id) ?? [] : await getExcelInvoice(r.invoice_no, r.invoice_date, db, r.supplier);
    for (const l of lines) {
      out.push({
        date: r.invoice_date,
        invoice_no: r.invoice_no,
        supplier: r.supplier ?? "",
        status: r.status,
        brand: l.brand ?? "",
        product: l.product_name ?? "",
        size_l: l.size_l ?? null,
        qty: l.qty ?? 0,
        cost_usd: l.cost_usd ?? 0,
        usd: round2((Number(l.qty) || 0) * (Number(l.cost_usd) || 0)),
        liters: l.size_l ? round2((Number(l.qty) || 0) * Number(l.size_l)) : null,
        usd_rate: r.usd_rate ?? null,
      });
    }
  }
  return out;
}

/** The Purchase_IN rows the bot sends replace the previous copy. Rows without a date or an invoice number are skipped. */
export async function applyExcelPurchases(rows, db = pool) {
  if (!Array.isArray(rows)) throw new PurchaseError("rows must be an array");
  const clean = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const date = String(r?.date ?? "").slice(0, 10);
    const invoiceNo = String(r?.invoice_id ?? r?.invoice_no ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !invoiceNo) {
      skipped += 1;
      return;
    }
    const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    clean.push([invoiceNo.slice(0, 80), date, r?.supplier ? String(r.supplier).trim().slice(0, 120) : null, r?.product_id ? String(r.product_id).trim() : null, r?.brand ? String(r.brand).trim() : null, r?.product_name ? String(r.product_name).trim() : null, num(r?.size_l), num(r?.qty), num(r?.cost_usd), num(r?.amount_amd), r?.info ? String(r.info).slice(0, 500) : null, Number(r?.excel_row) || i + 1]);
  });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM erp_purchase_lines");
    const cols = (k) => clean.map((c) => c[k]);
    if (clean.length) {
      await client.query(
        `INSERT INTO erp_purchase_lines (invoice_no, invoice_date, supplier, erp_product_id, brand, product_name, size_l, qty, cost_usd, amount_amd, info, excel_row)
         SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::text[], $12::int[])`,
        [cols(0), cols(1), cols(2), cols(3), cols(4), cols(5), cols(6), cols(7), cols(8), cols(9), cols(10), cols(11)]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { rows: clean.length, skipped };
}

/**
 * Every invoice of the period, from the app and from Excel, each with its comparison:
 * status "match" | "diff" | "app_only" | "excel_only". Newest first. `from` / `to` are YYYY-MM-DD (inclusive).
 */
export async function listPurchases({ from = null, to = null, supplierId = null } = {}, db = pool) {
  const params = [from, to];
  const [{ rows: app }, { rows: excel }] = await Promise.all([
    db.query(
      `SELECT i.id, i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.usd_rate::float8 AS usd_rate, i.note, s.id AS supplier_id, s.name AS supplier,
              i.status AS flow, to_char(i.expected_date, 'YYYY-MM-DD') AS expected_date,
              bool_or(l.received_qty IS NOT NULL AND l.received_qty <> l.qty) AS has_difference,
              count(l.id)::int AS lines, COALESCE(sum(l.qty), 0)::float8 AS qty, COALESCE(sum(l.qty * l.cost_usd), 0)::float8 AS usd,
              COALESCE(sum(l.qty * l.size_l), 0)::float8 AS liters, COALESCE(sum(l.qty * l.cost_usd) FILTER (WHERE l.size_l > 0), 0)::float8 AS liquid_usd,
              u.name AS created_by_name
         FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN purchase_lines l ON l.invoice_id = i.id
         LEFT JOIN users u ON u.id = i.created_by
        WHERE ($1::date IS NULL OR i.invoice_date >= $1::date) AND ($2::date IS NULL OR i.invoice_date <= $2::date) ${supplierId ? "AND i.supplier_id = $3" : ""}
        GROUP BY i.id, s.id, u.name`,
      supplierId ? [...params, supplierId] : params
    ),
    db.query(
      `SELECT min(invoice_no) AS invoice_no, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, min(supplier) AS supplier, count(*)::int AS lines,
              COALESCE(sum(qty), 0)::float8 AS qty, COALESCE(sum(qty * cost_usd), 0)::float8 AS usd, COALESCE(sum(amount_amd), 0)::float8 AS amd,
              COALESCE(sum(qty * size_l), 0)::float8 AS liters, COALESCE(sum(qty * cost_usd) FILTER (WHERE size_l > 0), 0)::float8 AS liquid_usd
         FROM erp_purchase_lines
        WHERE ($1::date IS NULL OR invoice_date >= $1::date) AND ($2::date IS NULL OR invoice_date <= $2::date)
        GROUP BY ${SQL_KEY("invoice_no")}, invoice_date, ${SQL_SUPPLIER_KEY("supplier")}`,
      params
    ),
  ]);
  // Every app invoice is its own row (two suppliers' invoices with the same number and date used to share one and hide the other,
  // review 2026-11-20). An Excel invoice pairs with the app invoice of the same number, date and supplier; when the supplier is written
  // differently on the two sides, with the only app invoice of that number and date that is still unpaired.
  const pairs = app.map((a) => ({ app: a, excel: null }));
  const byKey = new Map();
  for (const p of pairs) {
    if (!String(p.app.invoice_no ?? "").trim()) continue; // no number yet (Ordered, P5): nothing in the Excel is this purchase
    const k = keyOf(p.app.invoice_no, p.app.invoice_date);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  let supplierName = null;
  if (supplierId) supplierName = app.find((a) => a.supplier_id === supplierId)?.supplier ?? (await db.query("SELECT name FROM suppliers WHERE id = $1", [supplierId])).rows[0]?.name ?? null;
  const rows = [...pairs];
  // with a supplier filter, the other suppliers' invoices of the same number and date still count (a lone fallback pairing must be lone)
  const appPerKey = new Map();
  if (supplierId) {
    const { rows: allApp } = await db.query(
      `SELECT invoice_no, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date FROM purchase_invoices
        WHERE ($1::date IS NULL OR invoice_date >= $1::date) AND ($2::date IS NULL OR invoice_date <= $2::date)`,
      params
    );
    for (const a of allApp) appPerKey.set(keyOf(a.invoice_no, a.invoice_date), (appPerKey.get(keyOf(a.invoice_no, a.invoice_date)) ?? 0) + 1);
  }
  const excelPerKey = new Map();
  for (const e of excel) excelPerKey.set(keyOf(e.invoice_no, e.invoice_date), (excelPerKey.get(keyOf(e.invoice_no, e.invoice_date)) ?? 0) + 1);
  // the Excel invoices of the same supplier first, so a name match is never taken by a looser one
  const sameName = (e, a) => supplierKey(e.supplier) === supplierKey(a.supplier);
  const excelSorted = [...excel].sort((x, y) => Number((byKey.get(keyOf(y.invoice_no, y.invoice_date)) ?? []).some((p) => sameName(y, p.app))) - Number((byKey.get(keyOf(x.invoice_no, x.invoice_date)) ?? []).some((p) => sameName(x, p.app))));
  for (const e of excelSorted) {
    const k = keyOf(e.invoice_no, e.invoice_date);
    const all = byKey.get(k) ?? [];
    const candidates = all.filter((p) => !p.excel);
    // a supplier written differently on the two sides still pairs, but only when that number and date is one invoice on each side
    const appCount = supplierId ? appPerKey.get(k) ?? 0 : all.length;
    const hit = candidates.find((p) => sameName(e, p.app)) ?? (appCount === 1 && candidates.length === 1 && (excelPerKey.get(k) ?? 0) === 1 ? candidates[0] : null);
    if (hit) {
      hit.excel = e;
      continue;
    }
    if (supplierId && supplierKey(e.supplier) !== supplierKey(supplierName)) continue;
    rows.push({ app: null, excel: e });
  }
  const out = rows.map(({ app: a, excel: e }) => {
    const status = a && e ? (Math.abs(a.qty - e.qty) < 0.001 && Math.abs(a.usd - e.usd) <= USD_TOLERANCE ? "match" : "diff") : a ? "app_only" : "excel_only";
    const base = a ?? e;
    return {
      id: a?.id ?? null,
      invoice_no: base.invoice_no,
      invoice_date: base.invoice_date,
      supplier: a?.supplier ?? e?.supplier ?? null,
      status,
      lines: base.lines,
      qty: base.qty,
      liters: round2(base.liters),
      usd: round2(base.usd),
      // the dollars of the lines that have litres: the base of "USD per litre" (a stand or a filter adds dollars, no litres)
      liquid_usd: round2(base.liquid_usd ?? base.usd),
      amd: a ? Math.round(a.usd * a.usd_rate) : Math.round(e.amd || 0),
      usd_rate: a?.usd_rate ?? null,
      // P5: ordered | in_transit | arrived (an Excel-only invoice has arrived); the expected date; a count that differs from the invoice
      flow: a?.flow ?? "arrived",
      expected_date: a?.expected_date ?? null,
      has_difference: Boolean(a?.has_difference),
      paper_missing: Boolean(a && (!a.invoice_no || a.usd_rate === null)),
      created_by_name: a?.created_by_name ?? null,
      excel: e ? { qty: e.qty, usd: round2(e.usd), lines: e.lines } : null,
    };
  });
  out.sort((x, y) => y.invoice_date.localeCompare(x.invoice_date) || String(y.invoice_no ?? "").localeCompare(String(x.invoice_no ?? "")));
  return out;
}

/** One invoice with its lines, and the Excel lines of the same invoice number and date beside them. */
export async function getPurchase(id, db = pool) {
  const { rows: [inv] } = await db.query(
    `SELECT i.id, i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.usd_rate::float8 AS usd_rate, i.note, i.supplier_id, s.name AS supplier,
            i.status, to_char(i.expected_date, 'YYYY-MM-DD') AS expected_date, i.arrived_at, i.arrival_note, ua.name AS arrived_by_name,
            i.created_at, i.updated_at, u.name AS created_by_name
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN users u ON u.id = i.created_by LEFT JOIN users ua ON ua.id = i.arrived_by WHERE i.id = $1`,
    [id]
  );
  if (!inv) return null;
  const [{ rows: lines }, { rows: excel }] = await Promise.all([
    db.query("SELECT id, product_id, product_name, brand, size_l::float8 AS size_l, qty::float8 AS qty, cost_usd::float8 AS cost_usd, received_qty::float8 AS received_qty FROM purchase_lines WHERE invoice_id = $1 ORDER BY id", [id]),
    db.query(
      `SELECT erp_product_id, supplier, brand, product_name, size_l::float8 AS size_l, qty::float8 AS qty, cost_usd::float8 AS cost_usd, amount_amd::float8 AS amount_amd, info
         FROM erp_purchase_lines WHERE invoice_date = $1::date AND lower(regexp_replace(trim(invoice_no), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))
        ORDER BY excel_row`,
      [inv.invoice_date, inv.invoice_no]
    ),
  ]);
  if (!inv.invoice_no) excel.length = 0; // no number yet (Ordered): nothing in the Excel can be this purchase
  const [files, log] = await Promise.all([purchaseFiles(id, db), purchaseLog(id, db)]);
  return { ...inv, lines, excel_lines: ofSupplier(excel, inv.supplier), files, log };
}

export async function listSuppliers(db = pool) {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.brands, s.active, to_char(max(i.invoice_date), 'YYYY-MM-DD') AS last_invoice_date, count(i.id)::int AS invoices,
            (SELECT usd_rate::float8 FROM purchase_invoices x WHERE x.supplier_id = s.id ORDER BY x.invoice_date DESC, x.id DESC LIMIT 1) AS last_usd_rate,
            (SELECT invoice_no FROM purchase_invoices x WHERE x.supplier_id = s.id ORDER BY x.invoice_date DESC, x.id DESC LIMIT 1) AS last_invoice_no
       FROM suppliers s LEFT JOIN purchase_invoices i ON i.supplier_id = s.id
      GROUP BY s.id ORDER BY s.active DESC, max(i.invoice_date) DESC NULLS LAST, s.name`
  );
  // the Excel's suppliers: each one's latest invoice number (the next number is suggested from it) and the names not yet in the list,
  // so the first invoices can pick them
  const { rows: excelLast } = await db.query(
    `SELECT DISTINCT ON (lower(supplier)) supplier, invoice_no, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
       FROM erp_purchase_lines WHERE supplier IS NOT NULL AND supplier <> '' ORDER BY lower(supplier), invoice_date DESC, excel_row DESC`
  );
  const excelBy = new Map(excelLast.map((r) => [r.supplier.toLowerCase(), r]));
  for (const r of rows) {
    const e = excelBy.get(r.name.toLowerCase());
    const appDay = r.last_invoice_date ?? "";
    // the newer of the app's and the Excel's last invoice names the number to continue from
    if (e && (!r.last_invoice_no || e.invoice_date > appDay)) {
      r.last_invoice_no = e.invoice_no;
      r.last_invoice_date = e.invoice_date;
    }
  }
  const known = new Set(rows.map((r) => r.name.toLowerCase()));
  const excelNames = excelLast.map((r) => r.supplier).filter((n) => !known.has(n.toLowerCase())).sort();
  const extra = excelNames.map((name) => {
    const e = excelBy.get(name.toLowerCase());
    return { name, last_invoice_no: e.invoice_no, last_invoice_date: e.invoice_date };
  });
  const { rows: [recent] } = await db.query("SELECT usd_rate::float8 AS usd_rate FROM purchase_invoices ORDER BY invoice_date DESC, id DESC LIMIT 1");
  return { suppliers: rows, excel_names: excelNames, excel_suppliers: extra, default_usd_rate: recent?.usd_rate ?? null };
}

/** What the Excel copy holds and when it arrived: the Purchases screen says so, and offers the file import when it is empty. */
export async function excelStatus(db = pool) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS lines, count(DISTINCT (invoice_no, invoice_date))::int AS invoices, to_char(min(invoice_date), 'YYYY-MM-DD') AS from_date,
            to_char(max(invoice_date), 'YYYY-MM-DD') AS to_date, max(synced_at) AS synced_at FROM erp_purchase_lines`
  );
  const { rows: [a] } = await db.query("SELECT count(*)::int AS invoices FROM purchase_invoices");
  return { excel_lines: r.lines, excel_invoices: r.invoices, from: r.from_date, to: r.to_date, synced_at: r.synced_at, app_invoices: a.invoices };
}

/**
 * What was bought before, per product (the Purchases form shows it beside each line, owner 2026-11-07: "I don't see the already bought
 * products data"): the last purchase (date, supplier, packs, USD per pack), the one before it (for the price change), what was bought in the
 * last 12 months, and the stock the app knows now. App and Excel purchases together; an invoice in both counts once.
 */
export async function productHistory(ids, { excludeNo = null, excludeDate = null } = {}, db = pool) {
  const wanted = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647))].slice(0, 100); // a product id is an int4
  if (!wanted.length) return {};
  const [{ rows: lines }, { rows: stock }] = await Promise.all([
    db.query(
      `SELECT l.product_id AS pid, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, l.qty::float8 AS qty, l.cost_usd::float8 AS cost_usd, s.name AS supplier, i.invoice_no, 'app' AS source
         FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id JOIN suppliers s ON s.id = i.supplier_id
        WHERE l.product_id = ANY($1) AND NOT ($2::text IS NOT NULL AND i.invoice_date = $3::date AND ${SQL_KEY("i.invoice_no")} = ${SQL_KEY("$2::text")})
       UNION ALL
       SELECT p.id, to_char(e.invoice_date, 'YYYY-MM-DD'), e.qty::float8, e.cost_usd::float8, e.supplier, e.invoice_no, 'excel'
         FROM erp_purchase_lines e JOIN products p ON p.erp_product_id = e.erp_product_id
        WHERE p.id = ANY($1) AND e.qty > 0 AND e.cost_usd IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM purchase_invoices x WHERE x.invoice_date = e.invoice_date AND ${SQL_KEY("x.invoice_no")} = ${SQL_KEY("e.invoice_no")})
          AND NOT ($2::text IS NOT NULL AND e.invoice_date = $3::date AND ${SQL_KEY("e.invoice_no")} = ${SQL_KEY("$2::text")})
        ORDER BY 2 DESC`,
      [wanted, excludeNo && excludeDate ? excludeNo : null, excludeNo && excludeDate ? excludeDate : null]
    ),
    db.query(`SELECT p.id, (${APP_STOCK_SQL})::float8 AS stock FROM products p WHERE p.id = ANY($1)`, [wanted]),
  ]);
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const out = {};
  for (const id of wanted) out[id] = { product_id: id, last: null, prev_cost_usd: null, purchases: 0, packs_12m: 0, usd_12m: 0, stock_qty: null };
  for (const r of stock) if (out[r.id]) out[r.id].stock_qty = r.stock == null ? null : Math.round(r.stock * 1000) / 1000;
  for (const r of lines) {
    const o = out[r.pid];
    if (!o) continue;
    o.purchases += 1;
    if (!o.last) o.last = { day: r.day, supplier: r.supplier, qty: r.qty, cost_usd: r.cost_usd, invoice_no: r.invoice_no, source: r.source };
    else if (o.prev_cost_usd == null) o.prev_cost_usd = r.cost_usd;
    if (r.day >= yearAgo) {
      o.packs_12m += r.qty;
      o.usd_12m += r.qty * r.cost_usd;
    }
  }
  for (const o of Object.values(out)) {
    o.packs_12m = Math.round(o.packs_12m * 1000) / 1000;
    o.usd_12m = round2(o.usd_12m);
  }
  return out;
}

/** The Excel lines of one invoice (number + date), each with the app product it names (by the Excel ProductID), to copy it into the app. */
// The Excel lines of one number + date can belong to two suppliers: when some are this supplier's, only those (review, 2026-11-20).
function ofSupplier(lines, supplier) {
  if (!supplier) return lines;
  const own = lines.filter((l) => supplierKey(l.supplier) === supplierKey(supplier));
  if (own.length) return own;
  // none written as this supplier: the lines only when they are one other spelling (the same lone pairing the list makes), else none
  return new Set(lines.map((l) => supplierKey(l.supplier))).size === 1 ? lines : [];
}

export async function getExcelInvoice(invoiceNo, date, db = pool, supplier = null) {
  const { rows } = await db.query(
    `SELECT e.invoice_no, to_char(e.invoice_date, 'YYYY-MM-DD') AS invoice_date, e.supplier, e.erp_product_id, e.brand, e.product_name, e.size_l::float8 AS size_l,
            e.qty::float8 AS qty, e.cost_usd::float8 AS cost_usd, e.amount_amd::float8 AS amount_amd, e.info, p.id AS product_id, p.name AS app_product_name
       FROM erp_purchase_lines e LEFT JOIN products p ON p.erp_product_id = e.erp_product_id
      WHERE e.invoice_date = $1::date AND lower(regexp_replace(trim(e.invoice_no), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))
      ORDER BY e.excel_row`,
    [date, invoiceNo]
  );
  return ofSupplier(rows, supplier);
}
