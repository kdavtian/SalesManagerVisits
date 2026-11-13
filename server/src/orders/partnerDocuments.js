// Documents for signature, the engine (e-signature step 1, owner 2026-11-13; design: kad-gmm docs/e-signature.md, contract in section 10).
// KAD Motors makes a DOCUMENT for a customer: a frozen copy of the numbers (content), a number (ACT-YYYY-NNNNNN), a fingerprint (SHA-256 of
// the canonical content, documentFingerprint.js) and KAD's side already signed (the creating person's saved signature). The customer's
// KAD OS reads it through /api/partner/documents and its chosen signer signs it (drawn signature + PIN checked in KAD OS) or disputes it.
// A correction is always a new version (same number, version + 1); the old one becomes 'replaced' and stays as history.
//   states: sent -> viewed -> signed | signed_remarks | disputed;  sent | viewed | disputed -> replaced | cancelled
// PDFs: the unsigned one is built when the document is made (pdf_path), the signed one when the customer signs (signed_pdf_path, also a
// customer_files row of kind 'signed_document', so it shows in the customer card's Files and the Documents inbox).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { uploadDirPath } from "../shared/upload.js";
import { notifyUser } from "../shared/notifications.js";
import { rolesWhere, answersPartnerDocuments } from "../shared/roles.js";
import { getDocumentTexts } from "../shared/documentTexts.js";
import { warmPdfPreview } from "../shared/pdfPreview.js";
import { createOpsTask, systemCreatorId } from "../team/opsTasks.js";
import { documentFingerprint } from "./documentFingerprint.js";
import { buildPartnerDocumentPdf } from "./partnerDocumentPdf.js";
import { signaturePng } from "./signedActs.js";
import { COMPANY_NAME, cleanCustomerName } from "./orderBlankPdf.js";
import { hyCommon } from "../../../client/public/js/i18n/hy/common.js";
import { hySettings } from "../../../client/public/js/i18n/hy/settings.js";

export const DOCUMENT_KINDS = ["delivery", "payment", "reconciliation", "return", "deal", "agreement"];
export const DOCUMENT_STATES = ["sent", "viewed", "signed", "signed_remarks", "disputed", "replaced", "cancelled"];
export const OPEN_STATES = ["sent", "viewed"];
export const REMARK_ISSUES = ["short", "damaged", "wrong", "unknown", "amount"];
// days the customer has to sign, per kind (design section 5; Settings gets them in a later step)
const DUE_DAYS = { delivery: 3, payment: 3, reconciliation: 7, return: 3, deal: 7, agreement: 14 };
const DAY = 24 * 60 * 60 * 1000;

export class DocumentError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const fail = (status, code, message, extra) => {
  throw new DocumentError(status, code, message, extra);
};

// ---- input cleaning --------------------------------------------------------------------------------------------------------------------
// control characters (a NUL breaks Postgres JSONB) are dropped, so odd input is a clean text and never a 500
const str = (v, max) => (v === null || v === undefined ? "" : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max));
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (v) => (num(v) === null ? null : Math.round(num(v)));

/** The content in the exact shape of the contract (unknown keys dropped), or a 400 invalid_content. */
export function cleanContent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_content", "content must be an object");
  const list = (v, max, name) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max) fail(400, "invalid_content", `content.${name} must be a list of at most ${max}`);
    return v.map((x) => (x && typeof x === "object" ? x : fail(400, "invalid_content", `content.${name} holds a non-object`)));
  };
  const lines = list(raw.lines, 500, "lines").map((l, i) => ({
    key: str(l.key ?? i + 1, 60) || String(i + 1),
    name: str(l.name, 300),
    qty: num(l.qty),
    unit: str(l.unit, 20),
    price_amd: money(l.price_amd),
    amount_amd: money(l.amount_amd),
    note: str(l.note, 300),
  }));
  if (new Set(lines.map((l) => l.key)).size !== lines.length) fail(400, "invalid_content", "content.lines keys must be unique");
  return {
    summary: list(raw.summary, 40, "summary").map((s) => ({ label: str(s.label, 120), value: str(s.value, 300) })),
    lines,
    totals: list(raw.totals, 20, "totals").map((x) => ({ label: str(x.label, 120), amount_amd: money(x.amount_amd) })),
    text: str(raw.text, 8000),
    lines_disputable: raw.lines_disputable === true,
  };
}

function cleanSigner(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const name = str(s.name, 120);
  if (!name) fail(400, "signer_required", "signer.name is required");
  return { name, role: str(s.role, 120), user_ref: str(s.user_ref, 120) };
}

// What the customer marked: only on a document whose lines can be disputed, one remark per line key that exists.
function cleanRemarks(raw, content) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 500) fail(400, "invalid_remarks", "remarks must be a list");
  if (!raw.length) return [];
  if (!content.lines_disputable) fail(400, "remarks_not_allowed", "This document's lines cannot be marked");
  const keys = new Set((content.lines ?? []).map((l) => String(l.key)));
  const seen = new Set();
  return raw.map((r) => {
    const key = str(r?.key, 60);
    if (!keys.has(key)) fail(400, "invalid_remarks", `remark for an unknown line ${key}`);
    if (seen.has(key)) fail(400, "invalid_remarks", `two remarks for line ${key}`);
    seen.add(key);
    if (!REMARK_ISSUES.includes(r.issue)) fail(400, "invalid_remarks", `issue must be one of ${REMARK_ISSUES.join(", ")}`);
    return { key, issue: r.issue, qty: num(r.qty), comment: str(r.comment, 500) };
  });
}

function cleanRelated(related = {}) {
  const ids = Array.isArray(related.order_ids) ? [...new Set(related.order_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100) : [];
  const id = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return { order_ids: ids, payment_id: id(related.payment_id), return_id: id(related.return_id) };
}

// ---- people --------------------------------------------------------------------------------------------------------------------------
export const roleLabel = (role, roleTitle) => hySettings[`role_${roleTitle || role}`] ?? hyCommon[`role_${roleTitle || role}`] ?? role ?? "";

// KAD Motors' side: the person who sends the document, with their saved signature (drawn once in Settings, as for the delivery acts).
async function kadSignerFor(db, userId, at) {
  if (!userId) return null;
  const { rows } = await db.query("SELECT id, name, name_hy, role, role_title, signature_path FROM users WHERE id = $1", [userId]);
  const u = rows[0];
  if (!u) return null;
  return { user_id: u.id, name: u.name_hy || u.name, role: roleLabel(u.role, u.role_title), signed_at: at.toISOString(), signature_path: u.signature_path ?? null };
}

async function answererIds(db = pool) {
  const { rows } = await db.query("SELECT id FROM users WHERE role = ANY($1) AND status = 'active' ORDER BY id", [rolesWhere(answersPartnerDocuments)]);
  return rows.map((r) => r.id);
}

async function tellAnswerers(type, message, db = pool) {
  for (const id of await answererIds(db)) await notifyUser(id, type, message).catch((err) => console.error(`${type} notification failed:`, err.message));
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------
const COLUMNS = "d.*, c.name AS customer_name, c.erp_customer_id, u.name AS created_by_name";
const FROM = "FROM partner_documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN users u ON u.id = d.created_by";
const SELECT = `SELECT ${COLUMNS} ${FROM}`;

export async function loadDocument(id, db = pool) {
  if (!Number.isInteger(Number(id))) return null;
  const { rows } = await db.query(`${SELECT} WHERE d.id = $1`, [Number(id)]);
  return rows[0] ?? null;
}

/** The customer's first read: sent -> viewed (any later read changes nothing). */
export async function markViewed(doc) {
  if (doc.state !== "sent") return doc;
  await pool.query("UPDATE partner_documents SET state = 'viewed', viewed_at = now() WHERE id = $1 AND state = 'sent'", [doc.id]);
  return loadDocument(doc.id);
}

const pickSigner = (s) => (s ? { name: s.name ?? "", role: s.role ?? "", signed_at: s.signed_at ?? null } : null);
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** A document as the contract (section 10) gives it to KAD OS; staff: true adds the audit and the links staff screens need. */
export function presentDocument(row, { withContent = true, staff = false } = {}) {
  const out = {
    id: row.id,
    number: row.number,
    kind: row.kind,
    version: row.version,
    state: row.state,
    title: row.title,
    created_at: iso(row.created_at),
    sent_at: iso(row.sent_at),
    viewed_at: iso(row.viewed_at),
    due_at: iso(row.due_at),
    signed_at: iso(row.signed_at),
    fingerprint: row.fingerprint,
    kad_signer: pickSigner(row.kad_signer),
    customer_signer: pickSigner(row.customer_signer),
    remarks: row.remarks ?? [],
    dispute: row.dispute
      ? { reason: row.dispute.reason ?? "", comment: row.dispute.comment ?? "", answered_at: row.dispute.answered_at ?? null, answer: row.dispute.answer ?? null }
      : null,
    replaces_id: row.replaces_id ?? null,
    replaced_by_id: row.replaced_by_id ?? null,
    cancelled_reason: row.cancelled_reason ?? null,
  };
  if (withContent) out.content = row.content;
  if (staff) {
    const kad = { ...row.kad_signer };
    delete kad.signature_path;
    Object.assign(out, {
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      kad_signer: row.kad_signer ? kad : null,
      customer_signer: row.customer_signer ?? null,
      dispute: row.dispute ?? null,
      order_ids: row.order_ids ?? [],
      payment_id: row.payment_id ?? null,
      return_id: row.return_id ?? null,
      created_by: row.created_by,
      created_by_name: row.created_by_name ?? null,
      cancelled_at: iso(row.cancelled_at),
      has_signature: Boolean(row.signature_path),
      overdue: OPEN_STATES.includes(row.state) && row.due_at ? new Date(row.due_at) < new Date() : false,
    });
  }
  return out;
}

const STATE_GROUPS = { open: OPEN_STATES, done: DOCUMENT_STATES.filter((s) => !OPEN_STATES.includes(s)), all: DOCUMENT_STATES };
const pageOf = (limit, offset, max = 100) => [Math.min(max, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0)];

/** KAD OS: this customer's documents, without the content. state = open | done | all. */
export async function listForCustomer(customerId, { state = "open", limit, offset } = {}) {
  const states = STATE_GROUPS[state] ?? STATE_GROUPS.open;
  const [lim, off] = pageOf(limit, offset);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS}, count(*) OVER () AS total_count ${FROM} WHERE d.customer_id = $1 AND d.state = ANY($2)
     ORDER BY d.created_at DESC, d.id DESC LIMIT $3 OFFSET $4`,
    [customerId, states, lim, off]
  );
  const total = rows[0] ? Number(rows[0].total_count) : (await pool.query("SELECT count(*)::int AS n FROM partner_documents WHERE customer_id = $1 AND state = ANY($2)", [customerId, states])).rows[0].n;
  return { documents: rows.map((r) => presentDocument(r, { withContent: false })), total, has_more: off + rows.length < total };
}

/** Staff: every document, filtered by kind / state (a group or one state) / customer / customer name, with the counts for the state tabs. */
export async function listForStaff({ kind, state, customerId, q, limit, offset } = {}) {
  const params = [];
  const where = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (DOCUMENT_KINDS.includes(kind)) add("d.kind = ?", kind);
  if (Number.isInteger(Number(customerId)) && Number(customerId) > 0) add("d.customer_id = ?", Number(customerId));
  if (q && String(q).trim()) add("c.name ILIKE ?", `%${String(q).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows: countRows } = await pool.query(
    `SELECT d.state, count(*)::int AS n FROM partner_documents d JOIN customers c ON c.id = d.customer_id ${base} GROUP BY d.state`,
    params
  );
  const byState = Object.fromEntries(countRows.map((r) => [r.state, r.n]));
  const sum = (states) => states.reduce((s, x) => s + (byState[x] ?? 0), 0);
  const counts = { open: sum(OPEN_STATES), disputed: sum(["disputed"]), signed: sum(["signed", "signed_remarks"]), all: sum(DOCUMENT_STATES) };
  const states = state === "signed" ? ["signed", "signed_remarks"] : STATE_GROUPS[state] ?? (DOCUMENT_STATES.includes(state) ? [state] : STATE_GROUPS.all);
  const [lim, off] = pageOf(limit, offset, 200);
  const { rows } = await pool.query(
    `${SELECT} ${base ? `${base} AND` : "WHERE"} d.state = ANY($${params.length + 1})
     ORDER BY CASE WHEN d.state = 'disputed' THEN 0 WHEN d.state IN ('sent', 'viewed') THEN 1 ELSE 2 END, d.created_at DESC, d.id DESC
     LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    [...params, states, lim + 1, off]
  );
  return { documents: rows.slice(0, lim).map((r) => presentDocument(r, { withContent: false, staff: true })), counts, has_more: rows.length > lim };
}

/** Every version of a document's number, oldest first (the detail's history). */
export async function versionsOf(number) {
  const { rows } = await pool.query("SELECT id, version, state, created_at, signed_at FROM partner_documents WHERE number = $1 ORDER BY version", [number]);
  return rows.map((r) => ({ id: r.id, version: r.version, state: r.state, created_at: iso(r.created_at), signed_at: iso(r.signed_at) }));
}

// ---- PDFs ----------------------------------------------------------------------------------------------------------------------------
async function writePdf(row, { signed }) {
  const { rows } = await pool.query("SELECT name, erp_customer_id FROM customers WHERE id = $1", [row.customer_id]);
  const [kad, customer] = await Promise.all([signaturePng(row.kad_signer?.signature_path), signed ? signaturePng(row.signature_path) : null]);
  const view = { ...row, customer_signer: signed ? row.customer_signer : null, remarks: signed ? row.remarks : [] };
  const pdf = await buildPartnerDocumentPdf(view, rows[0] ?? {}, { kad, customer });
  const fileName = `${crypto.randomUUID()}.pdf`;
  await fs.promises.writeFile(path.join(uploadDirPath, fileName), pdf);
  warmPdfPreview(path.join(uploadDirPath, fileName));
  return { fileName, size: pdf.length };
}

const isSigned = (row) => row.state === "signed" || row.state === "signed_remarks";

/** The PDF to serve (the signed one once signed), built now when it is missing. Returns the absolute path. */
export async function pdfPathFor(row) {
  const signed = isSigned(row);
  const current = signed ? row.signed_pdf_path : row.pdf_path;
  if (current && fs.existsSync(path.join(uploadDirPath, current))) return path.join(uploadDirPath, current);
  const { fileName, size } = await writePdf(row, { signed });
  await pool.query(`UPDATE partner_documents SET ${signed ? "signed_pdf_path" : "pdf_path"} = $2 WHERE id = $1`, [row.id, fileName]);
  if (signed) await keepAsCustomerFile(row, fileName, size); // the signed PDF failed once: the card's Files still get it
  return path.join(uploadDirPath, fileName);
}

// The signed PDF as a customer document, once per document (the card's Files, the Documents inbox).
async function keepAsCustomerFile(row, fileName, size) {
  const { rows } = await pool.query("SELECT id FROM customer_files WHERE partner_document_id = $1 LIMIT 1", [row.id]);
  if (rows[0]) {
    await pool.query("UPDATE customer_files SET file_path = $2, size_bytes = $3 WHERE id = $1", [rows[0].id, fileName, size]);
    return;
  }
  const createdBy = row.created_by ?? (await systemCreatorId());
  if (!createdBy) return;
  await pool.query(
    `INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, payment_id, note, created_by, partner_document_id)
     VALUES ($1, 'signed_document', $2, 'application/pdf', $3, $4, $5, $6, $7, $8)`,
    [row.customer_id, fileName, size, row.order_ids ?? [], row.payment_id, `${row.title} ${row.number} v${row.version}`.slice(0, 300), createdBy, row.id]
  );
}

// The signed PDF, also kept as a customer document (the card's Files, the Documents inbox).
async function storeSignedPdf(row) {
  const { fileName, size } = await writePdf(row, { signed: true });
  await pool.query("UPDATE partner_documents SET signed_pdf_path = $2 WHERE id = $1", [row.id, fileName]);
  await keepAsCustomerFile(row, fileName, size);
}

// ---- making documents ----------------------------------------------------------------------------------------------------------------
async function nextNumber(db, at) {
  const { rows } = await db.query("SELECT nextval('partner_document_number_seq') AS n");
  const year = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", year: "numeric" }).format(at);
  return `ACT-${year}-${String(rows[0].n).padStart(6, "0")}`;
}

async function insertVersion(db, { customerId, kind, number, version, title, content, dueDays, related, createdBy, replacesId = null }) {
  const at = new Date();
  const days = dueDays !== null && dueDays !== undefined && dueDays !== "" && Number.isFinite(Number(dueDays)) && Number(dueDays) >= 0 && Number(dueDays) <= 365 ? Number(dueDays) : DUE_DAYS[kind];
  const fingerprint = documentFingerprint({ content, customerId, kind, number, version });
  const { rows } = await db.query(
    `INSERT INTO partner_documents (customer_id, kind, number, version, state, title, content, fingerprint, due_at, sent_at, kad_signer,
       order_ids, payment_id, return_id, replaces_id, created_by)
     VALUES ($1, $2, $3, $4, 'sent', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [customerId, kind, number, version, title, JSON.stringify(content), fingerprint, new Date(at.getTime() + days * DAY), at,
      JSON.stringify(await kadSignerFor(db, createdBy, at)), related.order_ids, related.payment_id, related.return_id, replacesId, createdBy ?? null]
  );
  return rows[0].id;
}

// The unsigned PDF right away (so KAD OS can show it at once); a failure here never undoes the document (GET .../pdf builds it again).
async function afterCreate(id) {
  const row = await loadDocument(id);
  try {
    await pdfPathFor(row);
  } catch (err) {
    console.error(`Document ${row.number} PDF failed:`, err.message);
  }
  return loadDocument(id);
}

export async function createDocument({ customerId, kind, title, content, dueDays, related = {}, createdBy }) {
  if (!DOCUMENT_KINDS.includes(kind)) fail(400, "invalid_kind", `kind must be one of ${DOCUMENT_KINDS.join(", ")}`);
  const cleanTitle = str(title, 200);
  if (!cleanTitle) fail(400, "title_required", "title is required");
  const { rows } = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!rows[0]) fail(404, "customer_not_found", "Customer not found");
  const frozen = cleanContent(content);
  const number = await nextNumber(pool, new Date());
  const id = await insertVersion(pool, { customerId, kind, number, version: 1, title: cleanTitle, content: frozen, dueDays, related: cleanRelated(related), createdBy });
  return afterCreate(id);
}

/** A corrected version: same number, version + 1; the old one becomes 'replaced'. Only while the customer has not signed it. */
export async function replaceDocument(id, { title, content, dueDays, createdBy }) {
  const client = await pool.connect();
  let newId;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM partner_documents WHERE id = $1 FOR UPDATE", [id]);
    const old = rows[0];
    if (!old) fail(404, "not_found", "Document not found");
    if (![...OPEN_STATES, "disputed"].includes(old.state)) fail(409, "already_decided", `The document is ${old.state}`, { state: old.state });
    const frozen = content === undefined ? old.content : cleanContent(content);
    newId = await insertVersion(client, {
      customerId: old.customer_id, kind: old.kind, number: old.number, version: old.version + 1, title: str(title, 200) || old.title, content: frozen, dueDays,
      related: { order_ids: old.order_ids, payment_id: old.payment_id, return_id: old.return_id }, createdBy, replacesId: old.id,
    });
    await client.query("UPDATE partner_documents SET state = 'replaced', replaced_by_id = $2 WHERE id = $1", [old.id, newId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const doc = await afterCreate(newId);
  await closeRepTaskIfDone(doc.customer_id);
  return doc;
}

export async function cancelDocument(id, { reason }) {
  const why = str(reason, 500);
  if (!why) fail(400, "reason_required", "A reason is required");
  const { rows } = await pool.query(
    `UPDATE partner_documents SET state = 'cancelled', cancelled_reason = $2, cancelled_at = now() WHERE id = $1 AND state IN ('sent', 'viewed', 'disputed') RETURNING customer_id`,
    [id, why]
  );
  if (!rows[0]) {
    const doc = await loadDocument(id);
    if (!doc) fail(404, "not_found", "Document not found");
    fail(409, "already_decided", `The document is ${doc.state}`, { state: doc.state });
  }
  await closeRepTaskIfDone(rows[0].customer_id);
  return loadDocument(id);
}

/** KAD's answer to a dispute (a comment with the proof); a corrected document is a new version (replaceDocument). */
export async function answerDispute(id, { answer, by }) {
  const text = str(answer, 2000);
  if (!text) fail(400, "answer_required", "An answer is required");
  const { rows } = await pool.query(
    `UPDATE partner_documents SET dispute = dispute || jsonb_build_object('answer', $2::text, 'answered_at', now(), 'answered_by', $3::int)
     WHERE id = $1 AND state = 'disputed' RETURNING id`,
    [id, text, by]
  );
  if (!rows[0]) {
    const doc = await loadDocument(id);
    if (!doc) fail(404, "not_found", "Document not found");
    fail(409, "not_disputed", "Only a disputed document can be answered", { state: doc.state });
  }
  return loadDocument(id);
}

// ---- the agreement on electronic documents (one per customer) ------------------------------------------------------------------------
export const AGREEMENT_TITLE = "Համաձայնագիր էլեկտրոնային փաստաթղթաշրջանառության մասին";

export async function agreementContent(customerId) {
  const [{ rows }, texts] = await Promise.all([pool.query("SELECT name, legal_name FROM customers WHERE id = $1", [customerId]), getDocumentTexts()]);
  const customer = rows[0]?.legal_name?.trim() || cleanCustomerName(rows[0]?.name);
  const company = `${COMPANY_NAME} (KAD Motors)`;
  return cleanContent({
    summary: [
      { label: "Կողմեր", value: `${company} և ${customer}` },
      { label: "Փաստաթղթերը", value: "Հանձնման-ընդունման ակտ, վճարման անդորրագիր, համադրման ակտ, վերադարձի ակտ, գների և վարկային պայմանների համաձայնագիր" },
      { label: "Ստորագրման եղանակը", value: "KAD OS-ում նկարած ստորագրություն + անձնական PIN կոդ" },
    ],
    lines: [],
    totals: [],
    text: texts.e_agreement.replaceAll("[customer]", customer).replaceAll("[company]", company),
    lines_disputable: false,
  });
}

/** The customer's agreement that is in force or on its way (null when there is none, or only replaced / cancelled ones). */
export async function currentAgreement(customerId) {
  const { rows } = await pool.query(
    "SELECT id, state FROM partner_documents WHERE customer_id = $1 AND kind = 'agreement' AND state NOT IN ('replaced', 'cancelled') ORDER BY id DESC LIMIT 1",
    [customerId]
  );
  return rows[0] ?? null;
}

export async function isKadOsCustomer(customerId) {
  const { rows } = await pool.query("SELECT 1 FROM partner_links WHERE customer_id = $1 LIMIT 1", [customerId]);
  return Boolean(rows[0]);
}

export async function createAgreement({ customerId, createdBy }) {
  if (!(await isKadOsCustomer(customerId))) fail(409, "not_linked", "This customer has no KAD OS link: it cannot sign electronically yet");
  // one at a time per customer: a double tap (or two people at once) sends ONE agreement, the second hears "agreement_exists"
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('partner-agreement'), $1)", [Number(customerId)]);
    const existing = await currentAgreement(customerId);
    if (existing) fail(409, "agreement_exists", "This customer already has an agreement", { id: existing.id, state: existing.state });
    return await createDocument({ customerId, kind: "agreement", title: AGREEMENT_TITLE, content: await agreementContent(customerId), createdBy });
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('partner-agreement'), $1)", [Number(customerId)]).catch(() => {});
    lock.release();
  }
}

/** KAD OS customers and where their agreement stands (the "Send agreement" list). */
export async function agreementCandidates() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id) c.id, c.name, a.id AS agreement_id, a.state AS agreement_state
       FROM partner_links l JOIN customers c ON c.id = l.customer_id
       LEFT JOIN partner_documents a ON a.customer_id = c.id AND a.kind = 'agreement' AND a.state NOT IN ('replaced', 'cancelled')
      ORDER BY c.id, a.id DESC`
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- the customer's decision (partner API) -------------------------------------------------------------------------------------------
// The open document under a row lock, or the contract's 409: changed (a newer version exists / the fingerprint is not the current one's),
// already_decided (signed, disputed or cancelled).
async function lockOpen(client, id, customerId, fingerprint) {
  const { rows } = await client.query("SELECT * FROM partner_documents WHERE id = $1 AND customer_id = $2 FOR UPDATE", [id, customerId]);
  const doc = rows[0];
  if (!doc) fail(404, "not_found", "Document not found");
  if (doc.state === "replaced") fail(409, "changed", "The document was replaced by a new version", { replaced_by_id: doc.replaced_by_id, fingerprint: null });
  if (!OPEN_STATES.includes(doc.state)) fail(409, "already_decided", `The document is already ${doc.state}`, { state: doc.state });
  if (String(fingerprint ?? "") !== doc.fingerprint) fail(409, "changed", "The fingerprint is not the current version's", { fingerprint: doc.fingerprint });
  return doc;
}

const MAX_SIGNATURE_BYTES = 1.5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The drawn signature (base64 PNG, a data: URL prefix allowed), normalised to a clean PNG and kept with the delivery signatures.
async function saveSignaturePng(base64) {
  const raw = String(base64 ?? "").replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, "");
  if (!raw) fail(400, "signature_required", "signature_png is required");
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 67 || buf.length > MAX_SIGNATURE_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) fail(400, "invalid_signature", "signature_png must be a PNG image (base64, at most 1.5 MB)");
  // a small file can declare a huge picture (16000 x 16000 = 1 GB unpacked): the size in the PNG header is checked before anything decodes it
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 3000 || height > 3000) fail(400, "invalid_signature", "signature_png is too large (at most 3000 x 3000 pixels)");
  let png = buf;
  let sharp = null;
  try {
    sharp = (await import("sharp")).default; // loaded on use, like the thumbnails: a server without the image library keeps the PNG as sent
  } catch {
    sharp = null;
  }
  if (sharp) {
    try {
      png = await sharp(buf, { limitInputPixels: 9_000_000 }).resize({ width: 1200, withoutEnlargement: true }).png().toBuffer();
    } catch {
      fail(400, "invalid_signature", "signature_png could not be read as an image");
    }
  }
  const rel = path.join("signatures", `${crypto.randomUUID()}.png`);
  await fs.promises.mkdir(path.join(uploadDirPath, "signatures"), { recursive: true });
  await fs.promises.writeFile(path.join(uploadDirPath, rel), png);
  return rel;
}

const audit = (body, meta, at) => {
  const device = body.device && typeof body.device === "object" ? body.device : {};
  return {
    signed_at: at.toISOString(),
    ip: str(meta.ip, 80),
    ua: str(device.ua, 400),
    app_version: str(device.app_version, 40),
    request_ua: str(meta.ua, 400),
  };
};

const shortTitle = (doc, customerName) => `${doc.title} ${doc.number}${doc.version > 1 ? ` v${doc.version}` : ""} · ${cleanCustomerName(customerName)}`.slice(0, 140);

export async function signDocument({ id, customerId, body = {}, meta = {} }) {
  const signer = cleanSigner(body.signer);
  if (body.pin_verified !== true) fail(400, "pin_not_verified", "pin_verified must be true (the PIN is checked in KAD OS)");
  const signaturePath = await saveSignaturePng(body.signature_png);
  const client = await pool.connect();
  let decided;
  try {
    await client.query("BEGIN");
    const doc = await lockOpen(client, id, customerId, body.fingerprint);
    const remarks = cleanRemarks(body.remarks, doc.content);
    const at = new Date();
    const customerSigner = { ...signer, ...audit(body, meta, at), pin_verified: true, fingerprint: doc.fingerprint };
    const { rows } = await client.query(
      `UPDATE partner_documents SET state = $2, signed_at = $3, customer_signer = $4, signature_path = $5, remarks = $6 WHERE id = $1 RETURNING *`,
      [doc.id, remarks.length ? "signed_remarks" : "signed", at, JSON.stringify(customerSigner), signaturePath, JSON.stringify(remarks)]
    );
    decided = rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    fs.unlink(path.join(uploadDirPath, signaturePath), () => {});
    throw err;
  } finally {
    client.release();
  }
  try {
    await storeSignedPdf(decided);
  } catch (err) {
    console.error(`Signed PDF of ${decided.number} failed (GET .../pdf builds it again):`, err.message);
  }
  const doc = await loadDocument(decided.id);
  await closeRepTaskIfDone(doc.customer_id);
  await tellAnswerers("partner_document_signed", {
    title: `${decided.remarks?.length ? "Ստորագրվեց նշումներով" : "Ստորագրվեց"}՝ ${shortTitle(doc, doc.customer_name)}`,
    body: `${signer.name}${signer.role ? `, ${signer.role}` : ""}`.slice(0, 140),
    url: `/#/sign-documents?open=${doc.id}`,
  });
  return doc;
}

export async function disputeDocument({ id, customerId, body = {}, meta = {} }) {
  const signer = cleanSigner(body.signer);
  const reason = str(body.reason, 500);
  if (!reason) fail(400, "reason_required", "reason is required");
  const client = await pool.connect();
  let decided;
  try {
    await client.query("BEGIN");
    const doc = await lockOpen(client, id, customerId, body.fingerprint);
    const remarks = cleanRemarks(body.remarks, doc.content);
    const at = new Date();
    const dispute = { reason, comment: str(body.comment, 2000), at: at.toISOString(), by: { ...signer, ...audit(body, meta, at) }, answer: null, answered_at: null };
    const { rows } = await client.query("UPDATE partner_documents SET state = 'disputed', dispute = $2, remarks = $3 WHERE id = $1 RETURNING *", [doc.id, JSON.stringify(dispute), JSON.stringify(remarks)]);
    decided = rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const doc = await loadDocument(decided.id);
  await closeRepTaskIfDone(doc.customer_id);
  await tellAnswerers("partner_document_disputed", {
    title: `Չհամաձայնեց՝ ${shortTitle(doc, doc.customer_name)}`,
    body: `${reason}${body.comment ? ` — ${str(body.comment, 100)}` : ""}`.slice(0, 140),
    url: `/#/sign-documents?open=${doc.id}`,
  });
  return doc;
}

/** "Send me a debt act now" (KAD OS): recorded, the accountants are told. */
export async function requestDocument({ customerId, kind = "reconciliation", note, userId }) {
  const k = kind || "reconciliation";
  if (!DOCUMENT_KINDS.includes(k)) fail(400, "invalid_kind", `kind must be one of ${DOCUMENT_KINDS.join(", ")}`);
  const text = str(note, 500);
  // the same request again within an hour (an impatient double tap, a loop) is not recorded nor told again
  const { rows: recent } = await pool.query(
    "SELECT 1 FROM partner_document_requests WHERE customer_id = $1 AND kind = $2 AND handled_at IS NULL AND created_at > now() - interval '1 hour' LIMIT 1", [customerId, k]
  );
  if (recent[0]) return;
  await pool.query("INSERT INTO partner_document_requests (customer_id, kind, note, requested_by) VALUES ($1, $2, $3, $4)", [customerId, k, text || null, userId]);
  const { rows } = await pool.query("SELECT name FROM customers WHERE id = $1", [customerId]);
  await tellAnswerers("partner_document_request", {
    title: `${cleanCustomerName(rows[0]?.name)}՝ ${k === "reconciliation" ? "խնդրում է համադրման ակտ" : "խնդրում է փաստաթուղթ"}`.slice(0, 120),
    body: text.slice(0, 140),
    url: `/#/customers/${customerId}`,
  });
}

// ---- past the deadline: the rep's task (nothing is accepted by silence, design decision 4) ---------------------------------------------
const TASK_KIND = "document_unsigned";

async function closeRepTaskIfDone(customerId) {
  const { rows } = await pool.query("SELECT 1 FROM partner_documents WHERE customer_id = $1 AND state IN ('sent', 'viewed') AND due_at < now() LIMIT 1", [customerId]);
  if (rows[0]) return;
  const { rows: closed } = await pool.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), completion_note = $2, updated_at = now()
     WHERE auto_kind = $1 AND customer_id = $3 AND status = 'open' RETURNING id`,
    [TASK_KIND, "Փաստաթղթերը ստորագրված են կամ փակված", customerId]
  );
  for (const r of closed) await pool.query("UPDATE task_items SET done = true, done_at = COALESCE(done_at, now()) WHERE task_id = $1", [r.id]);
}

/** The job (jobs/index.js): open documents past their deadline -> the customer's sales manager gets a task (once) and a reminder every 2 days (the customer's KAD OS reminds before the deadline). */
export async function remindOverdueDocuments(now = new Date()) {
  const { rows } = await pool.query(
    `SELECT d.id, d.number, d.version, d.title, d.customer_id, c.name AS customer_name, c.assigned_manager_id
       FROM partner_documents d JOIN customers c ON c.id = d.customer_id
      WHERE d.state IN ('sent', 'viewed') AND d.due_at < $1 AND (d.last_reminded_at IS NULL OR d.last_reminded_at <= $1::timestamptz - interval '2 days')
      ORDER BY d.customer_id, d.due_at`,
    [now]
  );
  const byCustomer = new Map();
  for (const r of rows) byCustomer.set(r.customer_id, [...(byCustomer.get(r.customer_id) ?? []), r]);
  let reminded = 0;
  for (const docs of byCustomer.values()) {
    const { customer_id: customerId, customer_name: name, assigned_manager_id: repId } = docs[0];
    const items = docs.map((d) => `${d.title} ${d.number}${d.version > 1 ? ` v${d.version}` : ""}`);
    const message = { title: `Չստորագրված փաստաթուղթ՝ ${cleanCustomerName(name)}`.slice(0, 120), body: items.join("; ").slice(0, 140), url: `/#/customers/${customerId}` };
    const taskId = repId ? await createOpsTask({ kind: TASK_KIND, title: `Ստորագրել տալ փաստաթուղթը KAD OS-ում՝ ${cleanCustomerName(name)}`.slice(0, 200), assigneeId: repId, customerId, items }) : null;
    if (!taskId) {
      if (repId) await notifyUser(repId, "partner_document_overdue", message).catch((err) => console.error("Overdue document reminder failed:", err.message));
      else await tellAnswerers("partner_document_overdue", message);
    }
    await pool.query("UPDATE partner_documents SET last_reminded_at = $2 WHERE id = ANY($1)", [docs.map((d) => d.id), now]);
    reminded += docs.length;
  }
  return { reminded };
}
