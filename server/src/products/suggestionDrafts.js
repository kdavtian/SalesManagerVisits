// Drafts of Smart purchase suggestions (owner, 2026-11-27, migration 227): the quantities chosen for one supplier, saved to open later.
// One draft per supplier (case and spaces ignored); saving again replaces it. Purchasing roles only (the purchases router checks).
import { pool } from "../db/pool.js";

export class DraftError extends Error {}

const MAX_LINES = 500;
const supplierOf = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

/** Checks a draft body; returns clean values or throws DraftError. */
export function cleanDraft(body) {
  const supplier = supplierOf(body?.supplier);
  const raw = Array.isArray(body?.lines) ? body.lines : null;
  if (!raw) throw new DraftError("lines must be a list");
  if (raw.length > MAX_LINES) throw new DraftError("Too many products");
  const seen = new Set();
  const lines = [];
  for (const l of raw) {
    const productId = Number(l?.product_id);
    const qty = Number(l?.qty);
    if (!Number.isInteger(productId) || productId <= 0) throw new DraftError("product_id must be a product id");
    if (!Number.isFinite(qty) || qty < 0 || qty > 1e7) throw new DraftError("qty must be a number from 0");
    if (seen.has(productId)) continue;
    seen.add(productId);
    lines.push({ product_id: productId, qty });
  }
  const days = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365 ? Number(v) : null);
  const total = Number(body?.total_usd);
  return {
    supplier,
    lines,
    leadDays: days(body?.lead_days),
    coverDays: days(body?.cover_days),
    totalUsd: Number.isFinite(total) && total >= 0 ? Math.round(total * 100) / 100 : null,
  };
}

const COLUMNS = `d.id, d.supplier, d.lines, d.lead_days, d.cover_days, d.products, d.pieces::float8 AS pieces, d.total_usd::float8 AS total_usd,
  d.created_at, d.updated_at, COALESCE(u.name, '') AS saved_by`;

export async function listDrafts(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM purchase_suggestion_drafts d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.updated_at DESC`);
  return rows;
}

/** Saves (or replaces) the draft of a supplier. */
export async function saveDraft(draft, userId, db = pool) {
  const ordered = draft.lines.filter((l) => l.qty > 0);
  const { rows } = await db.query(
    `INSERT INTO purchase_suggestion_drafts (supplier, lines, lead_days, cover_days, products, pieces, total_usd, created_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (lower(btrim(supplier))) DO UPDATE SET supplier = EXCLUDED.supplier, lines = EXCLUDED.lines, lead_days = EXCLUDED.lead_days,
       cover_days = EXCLUDED.cover_days, products = EXCLUDED.products, pieces = EXCLUDED.pieces, total_usd = EXCLUDED.total_usd,
       created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING id`,
    [draft.supplier, JSON.stringify(draft.lines), draft.leadDays, draft.coverDays, ordered.length, ordered.reduce((a, l) => a + l.qty, 0), draft.totalUsd, userId]
  );
  const [saved] = await db.query(`SELECT ${COLUMNS} FROM purchase_suggestion_drafts d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [rows[0].id]).then((r) => r.rows);
  return saved;
}

export async function deleteDraft(id, db = pool) {
  const { rowCount } = await db.query("DELETE FROM purchase_suggestion_drafts WHERE id = $1", [id]);
  return rowCount > 0;
}
