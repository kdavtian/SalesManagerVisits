// Purchases (owner, 2026-11-07): supplier invoices typed in the app with the Excel Purchase_IN columns (invoice no., date, supplier,
// product, packs, USD per pack, the invoice's USD rate), and the side-by-side check against the Purchase_IN rows the bot sends
// (erp_purchase_lines). Excel stays the source of stock until the owner switches the module over (docs/KDS-excel-off-single-erp.md, P4).
// An invoice is matched app <-> Excel by its number (case and spaces ignored) and date; it "matches" when the packs and the USD total agree.
import { pool } from "../db/pool.js";
import { APP_STOCK_SQL } from "../orders/appStock.js";

const USD_TOLERANCE = 0.05; // rounding in the workbook's own SUM column
const keyOf = (invoiceNo, date) => `${String(invoiceNo ?? "").trim().toLowerCase().replace(/\s+/g, " ")}|${String(date).slice(0, 10)}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export class PurchaseError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra); // code ("duplicate"), existingId
  }
}
// The same invoice number the Excel copy is compared by: case and extra spaces ignored (SQL form of keyOf)
const SQL_KEY = (col) => `lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g'))`;

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
    return { product_id: productId, qty, cost_usd: cost, product_name: l?.product_name ? String(l.product_name).trim().slice(0, 200) : null };
  });
}

/** Creates or updates one invoice (id = null: new). Returns the invoice id. A repeated client_ref returns the invoice it already made. */
export async function savePurchase(body, userId, id = null, db = pool) {
  const invoiceNo = String(body?.invoice_no ?? "").trim();
  const date = String(body?.invoice_date ?? "").slice(0, 10);
  const rate = Number(body?.usd_rate);
  if (!invoiceNo) throw new PurchaseError("The invoice number is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PurchaseError("invoice_date must be YYYY-MM-DD");
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new PurchaseError("usd_rate must be a positive number");
  const lines = cleanLines(body?.lines);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
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
    if (!body?.allow_duplicate) {
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
      l.product_name = p?.name ?? l.product_name;
      if (!l.product_name) throw new PurchaseError("Every line needs a product");
      l.brand = p?.brand ?? null;
      l.size_l = p ? (Number(p.size_l) || Number(String(p.unit ?? "").replace(",", ".").match(/[\d.]+/)?.[0]) || null) : null;
    }
    let invoiceId = id;
    if (id) {
      const { rowCount } = await client.query(
        "UPDATE purchase_invoices SET invoice_no = $2, invoice_date = $3, supplier_id = $4, usd_rate = $5, note = $6, updated_by = $7, updated_at = now() WHERE id = $1",
        [id, invoiceNo, date, supplierId, rate, body?.note ? String(body.note).slice(0, 1000) : null, userId]
      );
      if (!rowCount) throw new PurchaseError("Purchase not found");
      await client.query("DELETE FROM purchase_lines WHERE invoice_id = $1", [id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO purchase_invoices (invoice_no, invoice_date, supplier_id, usd_rate, note, client_ref, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [invoiceNo, date, supplierId, rate, body?.note ? String(body.note).slice(0, 1000) : null, body?.client_ref ? String(body.client_ref) : null, userId]
      );
      invoiceId = rows[0].id;
    }
    for (const l of lines) {
      await client.query(
        "INSERT INTO purchase_lines (invoice_id, product_id, product_name, brand, size_l, qty, cost_usd) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [invoiceId, l.product_id, l.product_name, l.brand, l.size_l, l.qty, l.cost_usd]
      );
    }
    await client.query("COMMIT");
    return invoiceId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
              count(l.id)::int AS lines, COALESCE(sum(l.qty), 0)::float8 AS qty, COALESCE(sum(l.qty * l.cost_usd), 0)::float8 AS usd,
              COALESCE(sum(l.qty * l.size_l), 0)::float8 AS liters, u.name AS created_by_name
         FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN purchase_lines l ON l.invoice_id = i.id
         LEFT JOIN users u ON u.id = i.created_by
        WHERE ($1::date IS NULL OR i.invoice_date >= $1::date) AND ($2::date IS NULL OR i.invoice_date <= $2::date) ${supplierId ? "AND i.supplier_id = $3" : ""}
        GROUP BY i.id, s.id, u.name`,
      supplierId ? [...params, supplierId] : params
    ),
    db.query(
      `SELECT invoice_no, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, min(supplier) AS supplier, count(*)::int AS lines,
              COALESCE(sum(qty), 0)::float8 AS qty, COALESCE(sum(qty * cost_usd), 0)::float8 AS usd, COALESCE(sum(amount_amd), 0)::float8 AS amd,
              COALESCE(sum(qty * size_l), 0)::float8 AS liters
         FROM erp_purchase_lines
        WHERE ($1::date IS NULL OR invoice_date >= $1::date) AND ($2::date IS NULL OR invoice_date <= $2::date)
        GROUP BY invoice_no, invoice_date`,
      params
    ),
  ]);
  const byKey = new Map();
  for (const a of app) byKey.set(keyOf(a.invoice_no, a.invoice_date), { app: a, excel: null });
  let supplierName = null;
  if (supplierId) supplierName = app.find((a) => a.supplier_id === supplierId)?.supplier ?? (await db.query("SELECT name FROM suppliers WHERE id = $1", [supplierId])).rows[0]?.name ?? null;
  for (const e of excel) {
    if (supplierId && String(e.supplier ?? "").toLowerCase() !== String(supplierName ?? "").toLowerCase() && !byKey.has(keyOf(e.invoice_no, e.invoice_date))) continue;
    const k = keyOf(e.invoice_no, e.invoice_date);
    const hit = byKey.get(k);
    if (hit) hit.excel = e;
    else byKey.set(k, { app: null, excel: e });
  }
  const out = [...byKey.values()].map(({ app: a, excel: e }) => {
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
      amd: a ? Math.round(a.usd * a.usd_rate) : Math.round(e.amd || 0),
      usd_rate: a?.usd_rate ?? null,
      created_by_name: a?.created_by_name ?? null,
      excel: e ? { qty: e.qty, usd: round2(e.usd), lines: e.lines } : null,
    };
  });
  out.sort((x, y) => y.invoice_date.localeCompare(x.invoice_date) || String(y.invoice_no).localeCompare(String(x.invoice_no)));
  return out;
}

/** One invoice with its lines, and the Excel lines of the same invoice number and date beside them. */
export async function getPurchase(id, db = pool) {
  const { rows: [inv] } = await db.query(
    `SELECT i.id, i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.usd_rate::float8 AS usd_rate, i.note, i.supplier_id, s.name AS supplier,
            i.created_at, i.updated_at, u.name AS created_by_name
       FROM purchase_invoices i JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN users u ON u.id = i.created_by WHERE i.id = $1`,
    [id]
  );
  if (!inv) return null;
  const [{ rows: lines }, { rows: excel }] = await Promise.all([
    db.query("SELECT id, product_id, product_name, brand, size_l::float8 AS size_l, qty::float8 AS qty, cost_usd::float8 AS cost_usd FROM purchase_lines WHERE invoice_id = $1 ORDER BY id", [id]),
    db.query(
      `SELECT erp_product_id, brand, product_name, size_l::float8 AS size_l, qty::float8 AS qty, cost_usd::float8 AS cost_usd, amount_amd::float8 AS amount_amd, info
         FROM erp_purchase_lines WHERE invoice_date = $1::date AND lower(regexp_replace(trim(invoice_no), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))
        ORDER BY excel_row`,
      [inv.invoice_date, inv.invoice_no]
    ),
  ]);
  return { ...inv, lines, excel_lines: excel };
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
export async function getExcelInvoice(invoiceNo, date, db = pool) {
  const { rows } = await db.query(
    `SELECT e.invoice_no, to_char(e.invoice_date, 'YYYY-MM-DD') AS invoice_date, e.supplier, e.erp_product_id, e.brand, e.product_name, e.size_l::float8 AS size_l,
            e.qty::float8 AS qty, e.cost_usd::float8 AS cost_usd, e.amount_amd::float8 AS amount_amd, e.info, p.id AS product_id, p.name AS app_product_name
       FROM erp_purchase_lines e LEFT JOIN products p ON p.erp_product_id = e.erp_product_id
      WHERE e.invoice_date = $1::date AND lower(regexp_replace(trim(e.invoice_no), '\\s+', ' ', 'g')) = lower(regexp_replace(trim($2), '\\s+', ' ', 'g'))
      ORDER BY e.excel_row`,
    [date, invoiceNo]
  );
  return rows;
}
