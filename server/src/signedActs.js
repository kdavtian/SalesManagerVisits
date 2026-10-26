// Electronic signature of the delivery-acceptance act (owner, 2026-10-26). The rep hands the phone to the customer, who signs once for every
// order delivered at the visit; the rep's own signature (kept on their profile) is applied silently. Each order gets its own signed PDF,
// kept as a customer document (kind signed_act) and the order is locked: only admin and CEO may change it afterwards.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "./db/pool.js";
import { uploadDirPath } from "./upload.js";
import { loadBlankOrders } from "./orderBlankData.js";
import { buildOrderBlanksPdf } from "./orderBlankPdf.js";

// admin and CEO keep the right to change a signed order.
export const canChangeSignedOrder = (role) => ["admin", "ceo"].includes(role);

export const SIGNED_ORDER_ERROR = {
  error: "The customer already signed this order -- only the admin or the CEO can change it",
  code: "order_signed_locked",
};

// Stores the customer's signature and locks the delivered orders. Runs inside the check-in's (or the delivery's) transaction, so the lock
// holds even if the PDF below fails to build.
export async function lockSignedOrders(db, { customerId, checkinId = null, filePath, createdBy, orderIds, signedAt = new Date() }) {
  const { rows } = await db.query(
    "INSERT INTO customer_signatures (customer_id, checkin_id, file_path, signed_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [customerId, checkinId, filePath, signedAt, createdBy]
  );
  const signatureId = rows[0].id;
  await db.query("UPDATE orders SET signed_at = $2, signature_id = $3 WHERE id = ANY($1) AND signed_at IS NULL", [orderIds, signedAt, signatureId]);
  return signatureId;
}

// pdfkit only embeds JPEG and PNG: every signature is turned into a PNG first (a phone may send WebP).
async function signaturePng(relativePath) {
  if (!relativePath) return null;
  try {
    // Loaded on use, like the thumbnails: a server without the image library must still start.
    const sharp = (await import("sharp")).default;
    return await sharp(path.join(uploadDirPath, relativePath)).png().toBuffer();
  } catch {
    return null;
  }
}

// One signed PDF per order. Returns [{ id, order_id, order_code }] (the customer_files rows made).
export async function createSignedActs({ orderIds, customerId, checkinId = null, customerSignaturePath, signerId, signedAt = new Date(), db = pool }) {
  const { orders, blank } = await loadBlankOrders(orderIds, db);
  if (!orders.length) return [];
  const { rows: signerRows } = await db.query("SELECT name, name_hy, signature_path FROM users WHERE id = $1", [signerId]);
  const signer = signerRows[0] ?? {};
  const [customerPng, repPng] = await Promise.all([signaturePng(customerSignaturePath), signaturePng(signer.signature_path)]);
  const made = [];
  for (const order of orders) {
    const pdf = await buildOrderBlanksPdf([
      blank(order.id, "full", {
        printedAt: signedAt,
        signatures: { signerName: signer.name_hy || signer.name || "", rep: repPng, customer: customerPng, signedAt },
      }),
    ]);
    const fileName = `${crypto.randomUUID()}.pdf`;
    await fs.promises.writeFile(path.join(uploadDirPath, fileName), pdf);
    const { rows } = await db.query(
      `INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, checkin_id, created_by)
       VALUES ($1, 'signed_act', $2, 'application/pdf', $3, $4, $5, $6) RETURNING id`,
      [customerId, fileName, pdf.length, [order.id], checkinId, signerId]
    );
    made.push({ id: rows[0].id, order_id: order.id, order_code: order.order_code });
  }
  return made;
}

// The user's own signature: drawn once on the phone, applied silently to every act they hand over. The previous file is removed.
export async function saveOwnSignature(userId, file) {
  const { rows } = await pool.query("SELECT signature_path FROM users WHERE id = $1", [userId]);
  const previousPath = rows[0]?.signature_path;
  await pool.query("UPDATE users SET signature_path = $1 WHERE id = $2", [file.filename, userId]);
  if (previousPath) fs.unlink(path.join(uploadDirPath, previousPath), () => {});
}
