// Documents for signature, the KAD OS side (e-signature design, kad-gmm docs/e-signature.md section 10 = the exact contract). Mounted inside
// partner.js at /api/partner/documents, after its login + "linked to a customer" guard: every call belongs to req.partner.customerId, and a
// document of another customer answers 404.
//   GET  /?state=open|done|all&limit&offset   { documents: [document without content], total, has_more }
//   GET  /:id                                   document (with content); the first read moves sent -> viewed
//   GET  /:id/pdf                               the PDF (the signed one once signed)
//   POST /:id/sign      { fingerprint, signer: { name, role, user_ref }, signature_png, pin_verified: true, device: { ua, app_version }, remarks }
//   POST /:id/dispute   { fingerprint, signer, reason, comment, remarks }
//   POST /request       { kind: "reconciliation", note } -> { ok: true }
// Errors: 409 { code: "changed" } when the fingerprint is not the current version's, 409 { code: "already_decided" } when not open.
import fs from "node:fs";
import { Router } from "express";
import {
  DocumentError, listForCustomer, loadDocument, markViewed, presentDocument, pdfPathFor, signDocument, disputeDocument, requestDocument,
} from "../partnerDocuments.js";

export const partnerDocumentsRouter = Router();

// The PDF itself (the signed one once signed). Sent from memory, not res.sendFile: a few hundred KB, and no path rules to trip over.
export async function sendDocumentPdf(res, doc) {
  const pdf = await fs.promises.readFile(await pdfPathFor(doc));
  res.set({ "Content-Type": "application/pdf", "Cache-Control": "private, no-cache", "Content-Disposition": `inline; filename="${doc.number}-v${doc.version}.pdf"` }).send(pdf);
}

export function sendDocumentError(res, err) {
  if (!(err instanceof DocumentError)) throw err;
  return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
}

async function ownDocument(req, res) {
  const id = Number(req.params.id);
  const doc = Number.isInteger(id) ? await loadDocument(id) : null;
  if (!doc || doc.customer_id !== req.partner.customerId) {
    res.status(404).json({ error: "Document not found", code: "not_found" });
    return null;
  }
  return doc;
}

const meta = (req) => ({ ip: req.ip, ua: req.get("user-agent") });

partnerDocumentsRouter.get("/", async (req, res) => {
  const state = ["open", "done", "all"].includes(req.query.state) ? req.query.state : "open";
  res.json(await listForCustomer(req.partner.customerId, { state, limit: req.query.limit, offset: req.query.offset }));
});

partnerDocumentsRouter.post("/request", async (req, res) => {
  try {
    await requestDocument({ customerId: req.partner.customerId, kind: req.body?.kind, note: req.body?.note, userId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    sendDocumentError(res, err);
  }
});

partnerDocumentsRouter.get("/:id", async (req, res) => {
  const doc = await ownDocument(req, res);
  if (!doc) return;
  res.json(presentDocument(await markViewed(doc)));
});

partnerDocumentsRouter.get("/:id/pdf", async (req, res) => {
  const doc = await ownDocument(req, res);
  if (doc) await sendDocumentPdf(res, doc);
});

partnerDocumentsRouter.post("/:id/sign", async (req, res) => {
  const doc = await ownDocument(req, res);
  if (!doc) return;
  try {
    res.json(presentDocument(await signDocument({ id: doc.id, customerId: req.partner.customerId, body: req.body ?? {}, meta: meta(req) })));
  } catch (err) {
    sendDocumentError(res, err);
  }
});

partnerDocumentsRouter.post("/:id/dispute", async (req, res) => {
  const doc = await ownDocument(req, res);
  if (!doc) return;
  try {
    res.json(presentDocument(await disputeDocument({ id: doc.id, customerId: req.partner.customerId, body: req.body ?? {}, meta: meta(req) })));
  } catch (err) {
    sendDocumentError(res, err);
  }
});
