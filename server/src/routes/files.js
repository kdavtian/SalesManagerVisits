// Customer documents API: add (photo of an order blank / payment slip / other), list per customer, the accountant's inbox, view / rotate / delete.
// The file itself lives in the uploads folder; this table row says whose it is and which orders it proves.
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { photoUpload, uploadDirPath } from "../upload.js";
import { matchesDeclaredImageType } from "../utils/imageSniff.js";
import { thumbnailPathFor, removeThumbnail } from "../utils/imageThumbs.js";
import { periodTimestampCondition, PERIOD_KEYS } from "../utils/periodWindows.js";
import { canAddCustomerFiles, seesAllCustomerFiles } from "../roles.js";
import { scheduleAiCheck, checkFileWithAi, getAiCheckSettings, isAiConfigured } from "../aiBlankCheck.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { pdfPreviewPath, pdfBufferPreview } from "../pdfPreview.js";
import { FILE_KINDS, FILE_COLUMNS, visibleFilesCondition, canDeleteFile, canRotateFile, parseOrderIds } from "../customerFiles.js";

export const filesRouter = Router();
filesRouter.use(requireAuth);

const PAGE = 60;
const FROM = `FROM customer_files f JOIN customers c ON c.id = f.customer_id JOIN users u ON u.id = f.created_by`;

// All documents of one customer, newest first (what this user may see).
filesRouter.get("/customer/:customerId", async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "Invalid customer id" });
  const params = [customerId];
  const visible = visibleFilesCondition(req.user, params);
  const { rows } = await pool.query(`SELECT ${FILE_COLUMNS} ${FROM} WHERE f.customer_id = $1 AND ${visible} ORDER BY f.created_at DESC, f.id DESC`, params);
  res.json(rows);
});

// The documents proving one order (the order sheet's Documents block).
filesRouter.get("/order/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "Invalid order id" });
  const params = [orderId];
  const visible = visibleFilesCondition(req.user, params);
  const { rows } = await pool.query(`SELECT ${FILE_COLUMNS} ${FROM} WHERE $1 = ANY(f.order_ids) AND ${visible} ORDER BY f.created_at DESC, f.id DESC`, params);
  res.json(rows);
});

// The inbox: every document with filters (period, rep, type, not linked to an order / payment, problems found by the AI check).
filesRouter.get("/", async (req, res) => {
  const { period, user_id, kind, linked, issues, customer_id, offset } = req.query;
  const params = [];
  const conditions = [visibleFilesCondition(req.user, params)];
  if (PERIOD_KEYS.includes(period)) conditions.push(periodTimestampCondition("f.created_at", period, params));
  if (Number.isInteger(Number(user_id)) && Number(user_id) > 0) {
    params.push(Number(user_id));
    conditions.push(`f.created_by = $${params.length}`);
  }
  if (FILE_KINDS.includes(kind)) {
    params.push(kind);
    conditions.push(`f.kind = $${params.length}`);
  }
  if (Number.isInteger(Number(customer_id)) && Number(customer_id) > 0) {
    params.push(Number(customer_id));
    conditions.push(`f.customer_id = $${params.length}`);
  }
  if (linked === "0") conditions.push("cardinality(f.order_ids) = 0 AND f.payment_id IS NULL");
  if (issues === "1") conditions.push("f.ai_status IN ('issues', 'unreadable')");
  params.push(PAGE + 1, Math.max(0, Number(offset) || 0));
  const { rows } = await pool.query(
    `SELECT ${FILE_COLUMNS}, c.name AS customer_name ${FROM} WHERE ${conditions.join(" AND ")}
     ORDER BY f.created_at DESC, f.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, PAGE), has_more: rows.length > PAGE });
});

async function loadFile(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid file id" });
    return null;
  }
  const params = [id];
  const visible = visibleFilesCondition(req.user, params);
  const { rows } = await pool.query(`SELECT f.*, c.name AS customer_name FROM customer_files f JOIN customers c ON c.id = f.customer_id WHERE f.id = $1 AND ${visible}`, params);
  if (!rows[0]) {
    res.status(404).json({ error: "File not found" });
    return null;
  }
  return rows[0];
}

// The file itself. ?size=thumb is a small copy for grids; the id + version never changes its content, so the phone keeps it for a year.
filesRouter.get("/:id/content", async (req, res) => {
  const file = await loadFile(req, res);
  if (!file) return;
  let target = path.join(uploadDirPath, file.file_path);
  if (req.query.size === "thumb" && file.mime.startsWith("image/")) target = (await thumbnailPathFor(uploadDirPath, file.file_path)) || target;
  res.sendFile(target, { headers: { "Cache-Control": "private, max-age=31536000, immutable", "Content-Type": req.query.size === "thumb" && target.endsWith(".jpg") ? "image/jpeg" : file.mime } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
  });
});

// A PDF document as one JPEG (pdfPreview.js): what the viewer shows at once, and what "Save" puts in the phone's photos. 501 = this server
// cannot render PDFs (the viewer then opens the PDF itself). Same id + version = same picture, so the phone keeps it.
filesRouter.get("/:id/preview", async (req, res) => {
  const file = await loadFile(req, res);
  if (!file) return;
  if (file.mime !== "application/pdf") return res.status(400).json({ error: "Not a PDF" });
  const jpg = await pdfPreviewPath(path.join(uploadDirPath, file.file_path));
  if (!jpg) return res.status(501).json({ error: "Preview not available" });
  res.sendFile(jpg, { headers: { "Cache-Control": "private, max-age=31536000, immutable", "Content-Type": "image/jpeg" } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
  });
});

// Any PDF the app just built on the phone (order blanks, a debt statement) as one JPEG, for "Save as image" (owner, 2026-10-27).
// Rendering is CPU work: a person saves a few documents a minute, never hundreds.
const pdfPreviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => Boolean(process.env.E2E_RATE_LIMIT_BYPASS_TOKEN) && req.get("x-e2e-rate-limit-bypass") === process.env.E2E_RATE_LIMIT_BYPASS_TOKEN,
  message: { error: "Too many documents at once -- try again in a minute" },
});
filesRouter.post("/pdf-preview", pdfPreviewLimiter, express.raw({ type: "application/pdf", limit: "15mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.subarray(0, 5).toString() !== "%PDF-") return res.status(400).json({ error: "Send a PDF" });
  const jpg = await pdfBufferPreview(req.body);
  if (!jpg) return res.status(501).json({ error: "Preview not available" });
  res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(jpg);
});

// Payment slips for printing, two to an A4 sheet (owner, 2026-10-27). Each stored slip is a half-A4 page; its picture is placed in one half,
// so the printed sheet is exactly what was signed. ids: the slips on screen (up to 40), in that order.
filesRouter.post("/print-slips", async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 40);
  if (!ids.length) return res.status(400).json({ error: "Choose the payment slips" });
  const params = [ids];
  const visible = visibleFilesCondition(req.user, params);
  const { rows } = await pool.query(
    `SELECT f.id, f.file_path FROM customer_files f JOIN customers c ON c.id = f.customer_id
     WHERE f.id = ANY($1) AND f.kind = 'payment_slip' AND f.mime = 'application/pdf' AND ${visible}`,
    params
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pictures = [];
  for (const id of ids) {
    const row = byId.get(id);
    const jpg = row ? await pdfPreviewPath(path.join(uploadDirPath, row.file_path)) : null;
    if (jpg) pictures.push(jpg);
  }
  if (!pictures.length) return res.status(rows.length ? 501 : 404).json({ error: rows.length ? "Preview not available" : "No payment slips found" });
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: "Payment slips", Author: "KAD Motors" } });
  const chunks = [];
  doc.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const W = 595.28;
  const H = 841.89;
  pictures.forEach((jpg, i) => {
    if (i && i % 2 === 0) doc.addPage({ size: "A4", margin: 0 });
    const top = i % 2 === 0 ? 0 : H / 2;
    doc.image(jpg, 0, top, { fit: [W, H / 2], align: "center", valign: "center" });
    if (i % 2 === 1 || i === pictures.length - 1) {
      doc.save().moveTo(20, H / 2).lineTo(W - 20, H / 2).dash(4, { space: 3 }).lineWidth(0.5).strokeColor("#9A9A9A").stroke().undash().restore();
    }
  });
  doc.end();
  const pdf = await done;
  res.set("Content-Type", "application/pdf").set("Cache-Control", "no-store").send(pdf);
});

// Add a document to a customer: one image (a photo of a signed order blank, a payment slip, ...).
filesRouter.post("/customer/:customerId", (req, res, next) => {
  if (!canAddCustomerFiles(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  photoUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const customerId = Number(req.params.customerId);
  const file = req.file;
  const discard = () => file && fs.unlink(file.path, () => {});
  if (!Number.isInteger(customerId) || !file) {
    discard();
    return res.status(400).json({ error: "customer and file are required" });
  }
  if (!matchesDeclaredImageType(file.path, file.mimetype)) {
    discard();
    return res.status(400).json({ error: "The file is not a valid image" });
  }
  const kind = FILE_KINDS.includes(req.body?.kind) && req.body.kind !== "signed_act" ? req.body.kind : "other";
  const orderIds = parseOrderIds(req.body?.order_ids);
  const { rows: c } = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!c[0]) {
    discard();
    return res.status(404).json({ error: "Customer not found" });
  }
  if (orderIds.length) {
    // An order link must be an order of this very customer.
    const { rows: own } = await pool.query("SELECT id FROM orders WHERE id = ANY($1) AND customer_id = $2", [orderIds, customerId]);
    if (own.length !== orderIds.length) {
      discard();
      return res.status(400).json({ error: "An order does not belong to this customer" });
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [customerId, kind, file.filename, file.mimetype, file.size, orderIds, String(req.body?.note ?? "").trim().slice(0, 500) || null, req.user.id]
  );
  res.status(201).json({ id: rows[0].id });
  scheduleAiCheck(rows[0].id); // only an order-blank photo is read, and only while the AI check is switched on
});

// Turn a photo by 90 / 180 / 270 degrees (a page that was photographed sideways). The stored file is replaced by a new one with the
// version raised, so every phone fetches the corrected picture.
filesRouter.post("/:id/rotate", async (req, res) => {
  const file = await loadFile(req, res);
  if (!file) return;
  if (!canRotateFile(req.user, file)) return res.status(403).json({ error: "Not allowed" });
  const degrees = Number(req.body?.degrees);
  if (![90, 180, 270].includes(degrees)) return res.status(400).json({ error: "degrees must be 90, 180 or 270" });
  if (!file.mime.startsWith("image/")) return res.status(400).json({ error: "Only photos can be rotated" });
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return res.status(503).json({ error: "Image processing is not available" });
  }
  const newName = `${crypto.randomUUID()}.jpg`;
  try {
    await sharp(path.join(uploadDirPath, file.file_path), { failOn: "none" }).rotate(degrees).jpeg({ quality: 90 }).toFile(path.join(uploadDirPath, newName));
  } catch {
    return res.status(422).json({ error: "The photo could not be rotated" });
  }
  await pool.query("UPDATE customer_files SET file_path = $2, mime = 'image/jpeg', version = version + 1, ai_status = NULL, ai_result = NULL WHERE id = $1", [file.id, newName]);
  fs.unlink(path.join(uploadDirPath, file.file_path), () => {});
  removeThumbnail(uploadDirPath, file.file_path);
  res.json({ id: file.id, version: file.version + 1 });
  scheduleAiCheck(file.id); // a turned photo is read again
});

// Check a document with the AI again (management; the switch in App configuration must be on).
filesRouter.post("/:id/ai-check", async (req, res) => {
  if (!seesAllCustomerFiles(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const file = await loadFile(req, res);
  if (!file) return;
  if (!(await getAiCheckSettings()).enabled) return res.status(409).json({ error: "The AI check is switched off", code: "ai_check_off" });
  if (!isAiConfigured()) return res.status(503).json({ error: "The AI key is not set on the server", code: "ai_not_configured" });
  const verdict = await checkFileWithAi(file.id, { force: true });
  if (!verdict) return res.status(422).json({ error: "The document could not be checked (a photo of an order blank, or the monthly cap is reached)", code: "ai_check_skipped" });
  res.json({ ai_status: verdict.status, ai_result: verdict });
});

filesRouter.delete("/:id", async (req, res) => {
  if (!canDeleteFile(req.user)) return res.status(403).json({ error: "Only the admin or the CEO can delete a document" });
  const { rows } = await pool.query("DELETE FROM customer_files WHERE id = $1 RETURNING file_path", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "File not found" });
  fs.unlink(path.join(uploadDirPath, rows[0].file_path), () => {});
  removeThumbnail(uploadDirPath, rows[0].file_path);
  fs.unlink(path.join(uploadDirPath, `${rows[0].file_path}.preview.jpg`), () => {}); // the picture of a PDF (pdfPreview.js)
  res.status(204).end();
});
