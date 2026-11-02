// Payments redesign, release 3b (owner, 2026-11-02: "keep both, upgrade +"): the Payments "+" sheet sends the customer's proof -- a
// signature on the phone and / or a photo of the signed paper slip -- like a check-in. A rep's payment always says how the customer
// confirmed it; a retry of the same queued payment (client_ref) keeps one payment and no extra files.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let rep, accountant, cookies, customer;

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  accountant = await createUser("accountant");
  cookies = { rep: await loginAs(rep.email), accountant: await loginAs(accountant.email) };
  customer = await createCustomer({ created_by: rep.id });
});
test.after(async () => {
  await pool.query("DELETE FROM customer_files WHERE customer_id = $1", [customer.id]);
  await cleanupAll();
  await stopTestServer();
});

const files = (paymentId) => pool.query("SELECT kind, mime FROM customer_files WHERE payment_id = $1 ORDER BY mime", [paymentId]).then((r) => r.rows);

test("signed on the phone + a slip photo: one payment, confirmation 'signed', the photo and the signed slip PDF; a retry adds nothing", async () => {
  const form = () => {
    const f = new FormData();
    f.set("customer_id", String(customer.id));
    f.set("amount", "45000"); // the queued payment's field name
    f.set("client_ref", `proof-${Date.now()}`);
    f.append("customer_signature", new Blob([PNG], { type: "image/png" }), "customer-signature.png");
    f.append("payment_slip_photos", new Blob([PNG], { type: "image/png" }), "slip.png");
    return f;
  };
  const first = form();
  const r = await apiFormRequest("/api/payments", { form: first, cookie: cookies.rep });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackPayment(r.data.id);
  const { rows: [p] } = await pool.query("SELECT amount_amd, customer_confirmation, sales_manager_id FROM payments WHERE id = $1", [r.data.id]);
  assert.equal(Number(p.amount_amd), 45000);
  assert.equal(p.customer_confirmation, "signed");
  assert.equal(p.sales_manager_id, rep.id);
  const made = await files(r.data.id);
  assert.deepEqual(made.map((f) => f.mime).sort(), ["application/pdf", "image/png"]);
  assert.ok(made.every((f) => f.kind === "payment_slip"));
  // the same queued payment sent again (lost answer): same payment, no new files
  const again = new FormData();
  for (const [k, v] of first.entries()) again.append(k, v);
  const r2 = await apiFormRequest("/api/payments", { form: again, cookie: cookies.rep });
  assert.equal(r2.data.id, r.data.id);
  assert.equal((await files(r.data.id)).length, 2);
});

test("a rep without proof: confirmation 'none' (shown as Not confirmed); the accountant typing a payment for a rep leaves it empty", async () => {
  const own = await apiRequest("/api/payments", { method: "POST", cookie: cookies.rep, body: { customer_id: customer.id, amount_amd: 17000 } });
  assert.equal(own.status, 201);
  trackPayment(own.data.id);
  assert.equal((await pool.query("SELECT customer_confirmation FROM payments WHERE id = $1", [own.data.id])).rows[0].customer_confirmation, "none");
  const typed = await apiRequest("/api/payments", { method: "POST", cookie: cookies.accountant, body: { customer_id: customer.id, amount_amd: 18000, sales_manager_id: rep.id } });
  assert.equal(typed.status, 201);
  trackPayment(typed.data.id);
  assert.equal((await pool.query("SELECT customer_confirmation FROM payments WHERE id = $1", [typed.data.id])).rows[0].customer_confirmation, null);
});

test("a file that is not an image is refused and nothing is saved", async () => {
  const f = new FormData();
  f.set("customer_id", String(customer.id));
  f.set("amount", "9000");
  f.append("payment_slip_photos", new Blob([Buffer.from("not an image")], { type: "image/png" }), "x.png");
  const r = await apiFormRequest("/api/payments", { form: f, cookie: cookies.rep });
  assert.equal(r.status, 400);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payments WHERE customer_id = $1 AND amount_amd = 9000", [customer.id])).rows[0].n, 0);
});
