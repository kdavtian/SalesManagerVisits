// Documents for signature, KAD Motors' side (e-signature engine, owner 2026-11-13): management and the accountant (canManagePartnerDocuments)
// see every document, send the one-time agreement on electronic documents to a KAD OS customer, cancel, make a new version, answer a dispute.
//   GET  /?kind&state=open|disputed|signed|done|all|<state>&customer_id&q&offset   { documents, counts, has_more }
//   GET  /agreement-candidates     the KAD OS customers and where their agreement stands
//   GET  /customer/:customerId     one customer's documents (the customer card) + whether it has a KAD OS link
//   GET  /:id                      the document with its content, the signature audit and every version of its number
//   GET  /:id/pdf                  the PDF (the signed one once signed)
//   POST /agreement                { customer_id } -> the agreement (409 agreement_exists / not_linked)
//   POST /:id/cancel               { reason }
//   POST /:id/replace              { title?, content?, due_days? } -> version + 1 (the agreement: from today's agreement text when no content)
//   POST /:id/answer               { answer } -> KAD's comment on a dispute
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canManagePartnerDocuments } from "../../shared/roles.js";
import {
  listForStaff, loadDocument, presentDocument, versionsOf, createAgreement, agreementCandidates, agreementContent, cancelDocument,
  replaceDocument, answerDispute, isKadOsCustomer, currentAgreement,
} from "../partnerDocuments.js";
import { sendDocumentError, sendDocumentPdf } from "./partnerDocuments.js";

export const signDocumentsRouter = Router();
signDocumentsRouter.use(requireAuth);
signDocumentsRouter.use((req, res, next) => {
  if (!canManagePartnerDocuments(req.user.role)) return res.status(403).json({ error: "Not allowed", code: "forbidden" });
  next();
});

const idOf = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const guarded = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendDocumentError(res, err);
  }
};

signDocumentsRouter.get("/", async (req, res) => {
  const { kind, state, customer_id: customerId, q, offset, limit } = req.query;
  res.json(await listForStaff({ kind, state, customerId, q, offset, limit }));
});

signDocumentsRouter.get("/agreement-candidates", async (req, res) => {
  res.json({ customers: await agreementCandidates() });
});

signDocumentsRouter.get("/customer/:customerId", async (req, res) => {
  const customerId = idOf(req.params.customerId);
  if (!customerId) return res.status(400).json({ error: "Invalid customer id" });
  const [list, linked, agreement] = await Promise.all([listForStaff({ customerId, state: "all", limit: 50 }), isKadOsCustomer(customerId), currentAgreement(customerId)]);
  res.json({ documents: list.documents, has_more: list.has_more, kad_os_linked: linked, agreement });
});

signDocumentsRouter.post("/agreement", guarded(async (req, res) => {
  const customerId = idOf(req.body?.customer_id);
  if (!customerId) return res.status(400).json({ error: "customer_id is required" });
  const doc = await createAgreement({ customerId, createdBy: req.user.id });
  res.status(201).json(presentDocument(doc, { staff: true }));
}));

async function found(req, res) {
  const doc = await loadDocument(idOf(req.params.id));
  if (!doc) res.status(404).json({ error: "Document not found", code: "not_found" });
  return doc;
}

signDocumentsRouter.get("/:id", async (req, res) => {
  const doc = await found(req, res);
  if (!doc) return;
  res.json({ ...presentDocument(doc, { staff: true }), versions: await versionsOf(doc.number) });
});

signDocumentsRouter.get("/:id/pdf", async (req, res) => {
  const doc = await found(req, res);
  if (doc) await sendDocumentPdf(res, doc);
});

signDocumentsRouter.post("/:id/cancel", guarded(async (req, res) => {
  const doc = await found(req, res);
  if (!doc) return;
  res.json(presentDocument(await cancelDocument(doc.id, { reason: req.body?.reason }), { staff: true }));
}));

signDocumentsRouter.post("/:id/replace", guarded(async (req, res) => {
  const doc = await found(req, res);
  if (!doc) return;
  let content = req.body?.content;
  // Only the agreement can be corrected by hand for now (the other kinds get their content from their own step: deliveries, payments, ...).
  if (doc.kind !== "agreement") return res.status(400).json({ error: "Only the agreement can be corrected here for now", code: "kind_not_editable" });
  if (content === undefined) content = await agreementContent(doc.customer_id);
  const next = await replaceDocument(doc.id, { title: req.body?.title, content, dueDays: req.body?.due_days, createdBy: req.user.id });
  res.status(201).json(presentDocument(next, { staff: true }));
}));

signDocumentsRouter.post("/:id/answer", guarded(async (req, res) => {
  const doc = await found(req, res);
  if (!doc) return;
  res.json(presentDocument(await answerDispute(doc.id, { answer: req.body?.answer, by: req.user.id }), { staff: true }));
}));
