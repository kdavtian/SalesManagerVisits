// Electronic signature of the delivery-acceptance act (owner, 2026-10-26). The rep hands the phone to the customer, who signs once for every
// order delivered at the visit; the rep's own signature (kept on their profile) is applied silently. Each order gets its own signed PDF,
// kept as a customer document (kind signed_act) and the order is locked: only admin and CEO may change it afterwards.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { uploadDirPath } from "../shared/upload.js";
import { approves } from "../shared/roles.js";
import { loadBlankOrders } from "./orderBlankData.js";
import { liveBalance } from "../money/liveDebt.js";
import { buildOrderBlanksPdf, buildPaymentSlipsPdf } from "./orderBlankPdf.js";
import { OFFICE_PHONE } from "../products/pricelistPdf.js";
import { warmPdfPreview } from "../shared/pdfPreview.js";
import { getDocumentTexts } from "../shared/documentTexts.js";

// The customer's debt before this visit, written on the signed act and the payment slip as "previous debt": the LIVE debt (owner,
// 2026-11-03), the same number the customer card shows -- the Excel debt + delivered app orders the Excel does not have yet - app payments
// the Excel does not have yet (money/liveDebt.js has the exact rules). The orders and the payment of THIS visit are left out (they are
// written on the paper as this visit's own amounts). null when the customer has no Excel debt figure.
export function balanceBeforeVisit(db, customerId, options = {}) {
  return liveBalance(db, customerId, options);
}

// admin and CEO keep the right to change a signed order.
export const canChangeSignedOrder = (role) => approves("signedDocuments", role);

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
export async function signaturePng(relativePath) {
  if (!relativePath) return null;
  try {
    // Loaded on use, like the thumbnails: a server without the image library must still start.
    const sharp = (await import("sharp")).default;
    return await sharp(path.join(uploadDirPath, relativePath), { limitInputPixels: 9_000_000 }).png().toBuffer();
  } catch {
    return null;
  }
}

// One signed PDF per order. Returns [{ id, order_id, order_code }] (the customer_files rows made).
// paymentAmd: money collected at the same visit (owner, 2026-10-27: payment and delivery on one blank, all four amounts filled). It is written
// on the first act; with several orders each act starts from the balance the previous one left.
export async function createSignedActs({ orderIds, customerId, checkinId = null, customerSignaturePath, signerId, signedAt = new Date(), paymentAmd = null, db = pool }) {
  const { orders, blank } = await loadBlankOrders(orderIds, db);
  if (!orders.length) return [];
  let balance = await balanceBeforeVisit(db, customerId, { excludeOrderIds: orders.map((o) => o.id), checkinId });
  const { pdf_warning: warning } = await getDocumentTexts(db);
  const { rows: signerRows } = await db.query("SELECT name, name_hy, signature_path FROM users WHERE id = $1", [signerId]);
  const signer = signerRows[0] ?? {};
  const [customerPng, repPng] = await Promise.all([signaturePng(customerSignaturePath), signaturePng(signer.signature_path)]);
  const made = [];
  for (const [i, order] of orders.entries()) {
    const payment = i === 0 && paymentAmd ? Number(paymentAmd) : paymentAmd ? 0 : null;
    const pdf = await buildOrderBlanksPdf([
      blank(order.id, "full", {
        printedAt: signedAt,
        previousDebtAmd: balance,
        paymentAmd: payment,
        signatures: { signerName: signer.name_hy || signer.name || "", rep: repPng, customer: customerPng, signedAt },
      }),
    ], { warning });
    if (balance !== null) balance = balance + Number(order.total_amd ?? 0) - (payment ?? 0);
    const fileName = `${crypto.randomUUID()}.pdf`;
    await fs.promises.writeFile(path.join(uploadDirPath, fileName), pdf);
    warmPdfPreview(path.join(uploadDirPath, fileName)); // the first look at it is then instant
    const { rows } = await db.query(
      `INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, checkin_id, created_by)
       VALUES ($1, 'signed_act', $2, 'application/pdf', $3, $4, $5, $6) RETURNING id`,
      [customerId, fileName, pdf.length, [order.id], checkinId, signerId]
    );
    made.push({ id: rows[0].id, order_id: order.id, order_code: order.order_code });
  }
  return made;
}

// The payment slip of money collected at a visit without a delivery (owner, 2026-10-27): ready to look at, save as an image and share,
// signed by the customer the same way as the act. Kept as a customer document (kind payment_slip) linked to the payment and the visit.
export async function createPaymentSlip({ paymentId, customerId, checkinId = null, amountAmd, paidAt = new Date(), customerSignaturePath = null, signerId, db = pool }) {
  const [{ rows: [c] }, { rows: [signer] }] = await Promise.all([
    db.query("SELECT name, erp_customer_id, tin, legal_name, address, phone FROM customers WHERE id = $1", [customerId]),
    db.query("SELECT name, name_hy, phone, signature_path FROM users WHERE id = $1", [signerId]),
  ]);
  const [customerPng, repPng] = await Promise.all([signaturePng(customerSignaturePath), signaturePng(signer?.signature_path)]);
  const signerName = signer?.name_hy || signer?.name || "";
  const { pdf_warning: warning } = await getDocumentTexts(db);
  const pdf = await buildPaymentSlipsPdf([
    {
      number: paymentId ? `P-${paymentId}` : "",
      paidAt,
      amountAmd: Number(amountAmd),
      previousDebtAmd: await balanceBeforeVisit(db, customerId, { excludePaymentIds: [paymentId], checkinId }),
      customer: c ?? {},
      rep: { name: signerName, phone: signer?.phone, officePhone: OFFICE_PHONE },
      signatures: customerPng || repPng ? { signerName, rep: repPng, customer: customerPng, signedAt: customerPng ? paidAt : null } : null,
    },
  ], { warning });
  const fileName = `${crypto.randomUUID()}.pdf`;
  await fs.promises.writeFile(path.join(uploadDirPath, fileName), pdf);
  warmPdfPreview(path.join(uploadDirPath, fileName));
  const { rows } = await db.query(
    `INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, payment_id, checkin_id, created_by)
     VALUES ($1, 'payment_slip', $2, 'application/pdf', $3, $4, $5, $6) RETURNING id`,
    [customerId, fileName, pdf.length, paymentId ?? null, checkinId, signerId]
  );
  return { id: rows[0].id, payment_id: paymentId ?? null };
}

// The user's own signature: drawn once on the phone, applied silently to every act they hand over. The previous file is removed.
export async function saveOwnSignature(userId, file) {
  const { rows } = await pool.query("SELECT signature_path FROM users WHERE id = $1", [userId]);
  const previousPath = rows[0]?.signature_path;
  await pool.query("UPDATE users SET signature_path = $1 WHERE id = $2", [file.filename, userId]);
  if (previousPath) fs.unlink(path.join(uploadDirPath, previousPath), () => {});
}
