// Documents for signature (e-signature engine, owner 2026-11-13; contract: kad-gmm docs/e-signature.md section 10): KAD Motors sends a
// document, the customer's KAD OS lists / reads / signs / disputes it through /api/partner/documents, only its own customer's, and the staff
// screens (/api/sign-documents) are for management and the accountant only.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDocument, remindOverdueDocuments } from "../../src/orders/partnerDocuments.js";
import { documentFingerprint } from "../../src/orders/documentFingerprint.js";

const stamp = Date.now();
let admin, accountant, director, rep, partnerA, partnerB;
let adminCookie, accountantCookie, directorCookie, repCookie, partnerACookie, partnerBCookie;
let shopA, shopB, unlinked;
let signaturePng;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  accountant = await createUser("accountant");
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  partnerA = await createUser("sales_manager", { name: "KAD OS - Doc Shop A" });
  partnerB = await createUser("sales_manager", { name: "KAD OS - Doc Shop B" });
  [adminCookie, accountantCookie, directorCookie, repCookie, partnerACookie, partnerBCookie] = await Promise.all(
    [admin, accountant, director, rep, partnerA, partnerB].map((u) => loginAs(u.email))
  );
  shopA = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `PD Shop A ${stamp}`, erp_customer_id: `PDA-${stamp}` });
  shopB = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `PD Shop B ${stamp}` });
  unlinked = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `PD Unlinked ${stamp}` });
  await pool.query("INSERT INTO partner_links (user_id, customer_id) VALUES ($1, $2), ($3, $4)", [partnerA.id, shopA.id, partnerB.id, shopB.id]);
  signaturePng = (await sharp({ create: { width: 240, height: 90, channels: 4, background: { r: 10, g: 20, b: 120, alpha: 1 } } }).png().toBuffer()).toString("base64");
});

test.after(async () => {
  const ids = [shopA.id, shopB.id, unlinked.id];
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'document_unsigned' AND customer_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM partner_links WHERE user_id = ANY($1)", [[partnerA.id, partnerB.id]]);
  await pool.query("DELETE FROM customer_files WHERE customer_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM partner_documents WHERE customer_id = ANY($1)", [ids]);
  await cleanupAll();
  await stopTestServer();
});

const signBody = (fingerprint, extra = {}) => ({
  fingerprint,
  signer: { name: "Արամ Պետրոսյան", role: "Տնօրեն", user_ref: "kados-user-7" },
  signature_png: signaturePng,
  pin_verified: true,
  device: { ua: "Mozilla/5.0 (iPhone) KAD OS", app_version: "0.99.0" },
  remarks: [],
  ...extra,
});
const sign = (cookie, id, body) => apiRequest(`/api/partner/documents/${id}/sign`, { method: "POST", cookie, body });

let agreement;

test("staff send the agreement; only to a KAD OS customer, only once", async () => {
  const r = await apiRequest("/api/sign-documents/agreement", { method: "POST", cookie: accountantCookie, body: { customer_id: shopA.id } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  agreement = r.data;
  assert.equal(agreement.kind, "agreement");
  assert.equal(agreement.state, "sent");
  assert.equal(agreement.version, 1);
  assert.match(agreement.number, /^ACT-\d{4}-\d{6}$/);
  assert.match(agreement.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(agreement.kad_signer.name, accountant.name);
  assert.ok(agreement.content.text.includes(`PD Shop A ${stamp}`), "the customer's name is in the agreement text");
  assert.equal(agreement.content.lines_disputable, false);
  // the fingerprint is the documented hash of the frozen content
  assert.equal(agreement.fingerprint, documentFingerprint({ content: agreement.content, customerId: shopA.id, kind: "agreement", number: agreement.number, version: 1 }));

  const again = await apiRequest("/api/sign-documents/agreement", { method: "POST", cookie: adminCookie, body: { customer_id: shopA.id } });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "agreement_exists");
  const noLink = await apiRequest("/api/sign-documents/agreement", { method: "POST", cookie: adminCookie, body: { customer_id: unlinked.id } });
  assert.equal(noLink.status, 409);
  assert.equal(noLink.data.code, "not_linked");
});

test("the partner lists it (no content), reads it (sent -> viewed) and gets the unsigned PDF", async () => {
  const open = await apiRequest("/api/partner/documents?state=open", { cookie: partnerACookie });
  assert.equal(open.status, 200);
  const row = open.data.documents.find((d) => d.id === agreement.id);
  assert.ok(row, "listed as open");
  assert.equal(row.content, undefined, "the list carries no content");
  assert.equal(row.state, "sent");
  assert.equal(open.data.total, 1);
  assert.equal(open.data.has_more, false);
  assert.equal((await apiRequest("/api/partner/documents?state=done", { cookie: partnerACookie })).data.documents.length, 0);

  const detail = await apiRequest(`/api/partner/documents/${agreement.id}`, { cookie: partnerACookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.state, "viewed");
  assert.equal(detail.data.fingerprint, agreement.fingerprint);
  assert.deepEqual(detail.data.content, agreement.content);
  assert.equal(detail.data.customer_signer, null);
  const pdf = await apiRequest(`/api/partner/documents/${agreement.id}/pdf`, { cookie: partnerACookie });
  assert.equal(pdf.status, 200);
  assert.ok(String(pdf.data).startsWith("%PDF"));
});

test("another customer's partner gets 404 on every call, and does not list it", async () => {
  for (const [method, path] of [["GET", ""], ["GET", "/pdf"], ["POST", "/sign"], ["POST", "/dispute"]]) {
    const r = await apiRequest(`/api/partner/documents/${agreement.id}${path}`, { method, cookie: partnerBCookie, body: method === "POST" ? signBody(agreement.fingerprint, { reason: "x" }) : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  const list = await apiRequest("/api/partner/documents?state=all", { cookie: partnerBCookie });
  assert.equal(list.data.documents.some((d) => d.id === agreement.id), false);
  assert.equal((await apiRequest("/api/partner/documents", { cookie: repCookie })).status, 403, "an unlinked account has no partner access");
});

test("sign: wrong fingerprint 409 changed, PIN / signer / remarks checked, then signed with the audit, the PDF and a customer file", async () => {
  const wrong = await sign(partnerACookie, agreement.id, signBody("0".repeat(64)));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.code, "changed");
  assert.equal((await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint, { pin_verified: false }))).data.code, "pin_not_verified");
  assert.equal((await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint, { signer: {} }))).data.code, "signer_required");
  assert.equal((await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint, { signature_png: "bm90IGEgcG5n" }))).data.code, "invalid_signature");
  const remarks = await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint, { remarks: [{ key: "1", issue: "short", qty: 1 }] }));
  assert.equal(remarks.status, 400);
  assert.equal(remarks.data.code, "remarks_not_allowed", "the agreement has no lines to mark");

  const ok = await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.state, "signed");
  assert.equal(ok.data.customer_signer.name, "Արամ Պետրոսյան");
  assert.equal(ok.data.customer_signer.role, "Տնօրեն");
  assert.ok(ok.data.signed_at);
  assert.equal(ok.data.customer_signer.ip, undefined, "the partner view carries only name, role, signed_at");

  const again = await sign(partnerACookie, agreement.id, signBody(agreement.fingerprint));
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "already_decided");

  const staff = await apiRequest(`/api/sign-documents/${agreement.id}`, { cookie: accountantCookie });
  assert.equal(staff.status, 200);
  const audit = staff.data.customer_signer;
  assert.equal(audit.pin_verified, true);
  assert.equal(audit.user_ref, "kados-user-7");
  assert.equal(audit.app_version, "0.99.0");
  assert.equal(audit.fingerprint, agreement.fingerprint);
  assert.ok(audit.ip, "the network address as it reached KAD Motors");
  assert.equal(staff.data.has_signature, true);
  assert.equal(staff.data.versions.length, 1);

  const pdf = await apiRequest(`/api/partner/documents/${agreement.id}/pdf`, { cookie: partnerACookie });
  assert.ok(String(pdf.data).startsWith("%PDF"));
  const { rows } = await pool.query("SELECT kind, mime FROM customer_files WHERE partner_document_id = $1", [agreement.id]);
  assert.deepEqual(rows, [{ kind: "signed_document", mime: "application/pdf" }]);
  const { rows: notes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'partner_document_signed'", [accountant.id]);
  assert.equal(notes.length, 1, "the accountant is told");
  // the customer card lists it
  const card = await apiRequest(`/api/sign-documents/customer/${shopA.id}`, { cookie: directorCookie });
  assert.equal(card.status, 200);
  assert.equal(card.data.kad_os_linked, true);
  assert.equal(card.data.agreement.state, "signed");
  assert.equal(card.data.documents[0].id, agreement.id);
});

test("dispute: reason required, marked lines kept, KAD answers; it cannot be signed afterwards", async () => {
  const doc = await createDocument({
    customerId: shopA.id,
    kind: "reconciliation",
    title: "Փոխադարձ հաշվարկների համադրման ակտ",
    content: {
      summary: [{ label: "Ժամանակահատված", value: "01.10.2026 - 31.10.2026" }],
      lines: [
        { key: "o-1", name: "Առաքում #1", amount_amd: 120000 },
        { key: "p-1", name: "Վճարում", amount_amd: -50000 },
      ],
      totals: [{ label: "Վերջնական մնացորդ", amount_amd: 70000 }],
      text: "Համաձայն եմ մնացորդին։",
      lines_disputable: true,
    },
    createdBy: admin.id,
  });
  const fp = doc.fingerprint;
  const noReason = await apiRequest(`/api/partner/documents/${doc.id}/dispute`, { method: "POST", cookie: partnerACookie, body: { fingerprint: fp, signer: { name: "Արամ" } } });
  assert.equal(noReason.data.code, "reason_required");
  const r = await apiRequest(`/api/partner/documents/${doc.id}/dispute`, {
    method: "POST",
    cookie: partnerACookie,
    body: { fingerprint: fp, signer: { name: "Արամ", role: "Տնօրեն" }, reason: "Վճարումը չի երևում", comment: "Վճարել ենք 80,000", remarks: [{ key: "p-1", issue: "amount", comment: "80000" }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state, "disputed");
  assert.equal(r.data.dispute.reason, "Վճարումը չի երևում");
  assert.equal(r.data.dispute.answer, null);
  assert.equal(r.data.remarks[0].key, "p-1");
  assert.equal((await sign(partnerACookie, doc.id, signBody(fp))).data.code, "already_decided");
  const { rows: notes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'partner_document_disputed'", [accountant.id]);
  assert.equal(notes.length, 1);

  const answer = await apiRequest(`/api/sign-documents/${doc.id}/answer`, { method: "POST", cookie: accountantCookie, body: { answer: "Վճարումը գրանցված է 05.10-ին, տե՛ս կցված քաղվածքը" } });
  assert.equal(answer.status, 200);
  assert.match(answer.data.dispute.answer, /05\.10/);
  const seen = await apiRequest(`/api/partner/documents/${doc.id}`, { cookie: partnerACookie });
  assert.ok(seen.data.dispute.answered_at);
  assert.match(seen.data.dispute.answer, /05\.10/);

  const list = await apiRequest("/api/sign-documents?state=disputed", { cookie: adminCookie });
  assert.ok(list.data.documents.some((d) => d.id === doc.id));
  assert.ok(list.data.counts.disputed >= 1);
});

test("replace: version 2 with the same number, version 1 replaced (signing it answers 409 changed), version 2 signs", async () => {
  const sent = await apiRequest("/api/sign-documents/agreement", { method: "POST", cookie: adminCookie, body: { customer_id: shopB.id } });
  assert.equal(sent.status, 201);
  const v1 = sent.data;
  const r = await apiRequest(`/api/sign-documents/${v1.id}/replace`, { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v2 = r.data;
  assert.equal(v2.number, v1.number);
  assert.equal(v2.version, 2);
  assert.equal(v2.replaces_id, v1.id);
  assert.notEqual(v2.fingerprint, v1.fingerprint, "the version is part of the fingerprint");
  const old = await apiRequest(`/api/partner/documents/${v1.id}`, { cookie: partnerBCookie });
  assert.equal(old.data.state, "replaced");
  assert.equal(old.data.replaced_by_id, v2.id);
  const stale = await sign(partnerBCookie, v1.id, signBody(v1.fingerprint));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "changed");
  assert.equal(stale.data.replaced_by_id, v2.id);
  const ok = await sign(partnerBCookie, v2.id, signBody(v2.fingerprint));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.state, "signed");
  const signedReplace = await apiRequest(`/api/sign-documents/${v2.id}/replace`, { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(signedReplace.status, 409);
  assert.equal(signedReplace.data.code, "already_decided");
  const staff = await apiRequest(`/api/sign-documents/${v2.id}`, { cookie: adminCookie });
  assert.deepEqual(staff.data.versions.map((v) => [v.version, v.state]), [[1, "replaced"], [2, "signed"]]);
});

test("cancel needs a reason; the partner then sees it under done", async () => {
  const doc = await createDocument({ customerId: shopB.id, kind: "payment", title: "Վճարման անդորրագիր", content: { totals: [{ label: "Վճարված", amount_amd: 50000 }] }, createdBy: admin.id });
  assert.equal((await apiRequest(`/api/sign-documents/${doc.id}/cancel`, { method: "POST", cookie: adminCookie, body: {} })).data.code, "reason_required");
  const r = await apiRequest(`/api/sign-documents/${doc.id}/cancel`, { method: "POST", cookie: adminCookie, body: { reason: "Սխալ գումար" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.state, "cancelled");
  const done = await apiRequest("/api/partner/documents?state=done&limit=1", { cookie: partnerBCookie });
  assert.equal(done.data.documents.length, 1);
  assert.equal(done.data.total, 3, "v1 replaced, v2 signed, the cancelled payment");
  assert.equal(done.data.has_more, true);
  assert.equal((await apiRequest(`/api/sign-documents/${doc.id}/cancel`, { method: "POST", cookie: adminCookie, body: { reason: "again" } })).data.code, "already_decided");
  assert.equal((await apiRequest(`/api/sign-documents/${doc.id}/replace`, { method: "POST", cookie: adminCookie, body: {} })).data.code, "kind_not_editable");
});

test("request: recorded and the accountant is told", async () => {
  const r = await apiRequest("/api/partner/documents/request", { method: "POST", cookie: partnerACookie, body: { kind: "reconciliation", note: "Խնդրում ենք հոկտեմբերի ակտը" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  const { rows } = await pool.query("SELECT kind, note FROM partner_document_requests WHERE customer_id = $1", [shopA.id]);
  assert.deepEqual(rows, [{ kind: "reconciliation", note: "Խնդրում ենք հոկտեմբերի ակտը" }]);
  const { rows: notes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'partner_document_request'", [accountant.id]);
  assert.equal(notes.length, 1);
  assert.equal((await apiRequest("/api/partner/documents/request", { method: "POST", cookie: partnerACookie, body: { kind: "nonsense" } })).status, 400);
});

test("RBAC: a sales manager and a KAD OS account cannot use the staff routes; the sales director can", async () => {
  for (const [method, path, body] of [["GET", "/api/sign-documents"], ["GET", `/api/sign-documents/${agreement.id}`], ["POST", "/api/sign-documents/agreement", { customer_id: unlinked.id }], ["POST", `/api/sign-documents/${agreement.id}/cancel`, { reason: "x" }]]) {
    assert.equal((await apiRequest(path, { method, cookie: repCookie, body })).status, 403, `rep ${method} ${path}`);
    assert.equal((await apiRequest(path, { method, cookie: partnerACookie, body })).status, 403, `partner ${method} ${path}`);
  }
  const list = await apiRequest("/api/sign-documents?kind=agreement", { cookie: directorCookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.documents.every((d) => d.kind === "agreement"));
  assert.ok(list.data.documents.some((d) => d.id === agreement.id && d.customer_name === shopA.name));
  const candidates = await apiRequest("/api/sign-documents/agreement-candidates", { cookie: directorCookie });
  assert.ok(candidates.data.customers.some((c) => c.id === shopA.id && c.agreement_state === "signed"));
});

test("past the deadline: the rep gets one task, a reminder at most once a day, and the task closes when it is signed", async () => {
  const doc = await createDocument({ customerId: shopB.id, kind: "deal", title: "Գնային համաձայնագիր", content: { text: "Զեղչ 5%" }, dueDays: 0, createdBy: admin.id });
  await pool.query("UPDATE partner_documents SET due_at = now() - interval '2 hours' WHERE id = $1", [doc.id]);
  const first = await remindOverdueDocuments(new Date());
  assert.ok(first.reminded >= 1);
  const { rows: tasks } = await pool.query("SELECT id, status FROM tasks WHERE auto_kind = 'document_unsigned' AND customer_id = $1 AND assignee_id = $2", [shopB.id, rep.id]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "open");
  const { rows: [{ n: before }] } = await pool.query("SELECT count(*)::int AS n FROM partner_documents WHERE id = $1 AND last_reminded_at IS NOT NULL", [doc.id]);
  assert.equal(before, 1);
  await remindOverdueDocuments(new Date());
  const { rows: overdueNotes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'partner_document_overdue'", [rep.id]);
  assert.equal(overdueNotes.length, 0, "the same day: no second reminder (the task was the first one)");
  // a day later the rep is reminded (the task already exists)
  await remindOverdueDocuments(new Date(Date.now() + 25 * 3600 * 1000));
  const { rows: later } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'partner_document_overdue'", [rep.id]);
  assert.equal(later.length, 1);

  const ok = await sign(partnerBCookie, doc.id, signBody(doc.fingerprint));
  assert.equal(ok.status, 200);
  const { rows: closed } = await pool.query("SELECT status FROM tasks WHERE id = $1", [tasks[0].id]);
  assert.equal(closed[0].status, "done");
});
