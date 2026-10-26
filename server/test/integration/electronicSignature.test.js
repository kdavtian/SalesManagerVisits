// Electronic signature of the delivery-acceptance act (owner, 2026-10-26): the customer signs once on the rep's phone for all orders delivered
// at the visit, one signed PDF per order is kept as a customer document, the rep's own signature comes from their profile, and the order is
// locked afterwards (only admin and CEO may change it).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiFormRequest, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/upload.js";

let baseUrl;
const users = {};
const cookies = {};
const login = async (key) => (cookies[key] ??= await loginAs(users[key].email));
let customer;
const orderIds = [];

test.before(async () => {
  baseUrl = await startTestServer();
  for (const [key, role] of Object.entries({ rep: "sales_manager", admin: "admin", director: "sales_director" })) users[key] = await createUser(role);
  customer = await createCustomer({ created_by: users.rep.id, assigned_manager_id: users.rep.id, lat: 40.18, lng: 44.51 });
});
test.after(async () => {
  const { rows } = await pool.query("SELECT file_path FROM customer_files WHERE customer_id = $1", [customer.id]);
  for (const r of rows) fs.rmSync(path.join(uploadDirPath, r.file_path), { force: true });
  await pool.query("DELETE FROM customer_files WHERE customer_id = $1", [customer.id]);
  await pool.query("UPDATE orders SET signature_id = NULL WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM customer_signatures WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM order_status_history WHERE order_id = ANY($1)", [orderIds]);
  await pool.query("DELETE FROM order_items WHERE order_id = ANY($1)", [orderIds]);
  await pool.query("DELETE FROM orders WHERE id = ANY($1)", [orderIds]);
  await pool.query("UPDATE users SET signature_path = NULL WHERE id = $1", [users.rep.id]);
  await cleanupAll();
  await stopTestServer();
});

async function png(color = "#102a6b") {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(`<svg width="300" height="120" xmlns="http://www.w3.org/2000/svg"><path d="M10 90 C 60 10, 100 110, 150 40 S 250 100, 290 30" stroke="${color}" stroke-width="6" fill="none"/></svg>`)).png().toBuffer();
}

async function newOrder(total = 25000) {
  const { rows } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'confirmed', $3, $4) RETURNING id", [
    customer.id,
    users.rep.id,
    total,
    `SIG-${Date.now()}-${orderIds.length}`,
  ]);
  await pool.query("INSERT INTO order_items (order_id, product_name, brand, unit_price_amd, quantity, line_total_amd) VALUES ($1, 'Edge 5W-30', 'Castrol', $2, 1, $2)", [rows[0].id, total]);
  orderIds.push(rows[0].id);
  return rows[0].id;
}

async function deliver(ids, files) {
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["customer_unavailable"]));
  form.set("delivered_order_ids", JSON.stringify(ids));
  for (const [field, bytes] of files) form.append(field, new Blob([bytes], { type: "image/png" }), `${field}.png`);
  const res = await apiFormRequest("/api/checkins", { form, cookie: await login("rep") });
  if (res.status === 201) trackCheckin(res.data.id);
  return res;
}

test("one customer signature signs every delivered order: a PDF each, the rep's signature saved, orders locked", async () => {
  const a = await newOrder();
  const b = await newOrder(40000);
  const res = await deliver([a, b], [["customer_signature", await png()], ["rep_signature", await png("#7a1010")]]);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.delivered_orders.length, 2);
  assert.equal(res.data.signed_acts.length, 2);
  assert.equal(res.data.rep_signature_saved, true);
  assert.equal(res.data.signed_act_error, undefined);

  const { rows: files } = await pool.query("SELECT kind, mime, order_ids, checkin_id, file_path, size_bytes FROM customer_files WHERE customer_id = $1 AND kind = 'signed_act' ORDER BY id", [customer.id]);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.order_ids[0]).sort(), [a, b].sort());
  assert.ok(files.every((f) => f.mime === "application/pdf" && f.checkin_id === res.data.id && f.size_bytes > 1000));
  const head = fs.readFileSync(path.join(uploadDirPath, files[0].file_path)).subarray(0, 5).toString();
  assert.equal(head, "%PDF-");

  const { rows: orders } = await pool.query("SELECT signed_at, signature_id FROM orders WHERE id = ANY($1)", [[a, b]]);
  assert.ok(orders.every((o) => o.signed_at && o.signature_id));
  assert.equal(orders[0].signature_id, orders[1].signature_id, "one signature for the whole visit");

  // The rep's signature is on their profile now; only they can read it back.
  assert.equal((await apiRequest("/api/me", { cookie: await login("rep") })).data.has_signature, true);
  assert.equal((await fetch(`${baseUrl}/api/me/signature`, { headers: { Cookie: await login("rep") } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/me/signature`, { headers: { Cookie: await login("admin") } })).status, 404, "everyone gets only their own");
});

test("a signed order is locked: the rep cannot change it, admin can", async () => {
  const { rows } = await pool.query("SELECT id FROM orders WHERE customer_id = $1 AND signed_at IS NOT NULL ORDER BY id LIMIT 1", [customer.id]);
  const id = rows[0].id;
  const byRep = await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: await login("rep"), body: { note: "changed" } });
  assert.equal(byRep.status, 423);
  assert.equal(byRep.data.code, "order_signed_locked");
  const byDirector = await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: await login("director"), body: { note: "changed" } });
  assert.equal(byDirector.status, 423);
  const byAdmin = await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: await login("admin"), body: { note: "admin may" } });
  assert.notEqual(byAdmin.status, 423);
  assert.equal((await apiRequest(`/api/orders/${id}`, { cookie: await login("rep") })).data.signed_at != null, true);
});

test("the next visit reuses the stored rep signature; a signature without a delivered order is refused or dropped", async () => {
  const c = await newOrder(18000);
  const res = await deliver([c], [["customer_signature", await png()]]);
  assert.equal(res.status, 201);
  assert.equal(res.data.signed_acts.length, 1);
  assert.equal(res.data.rep_signature_saved, undefined, "already on the profile");

  const noDelivery = await deliver([], [["customer_signature", await png()]]);
  assert.equal(noDelivery.status, 201);
  assert.equal(noDelivery.data.signed_acts.length, 0, "nothing was delivered, nothing to sign");

  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["follow_up_required"]));
  form.append("customer_signature", new Blob([await png()], { type: "image/png" }), "s.png");
  const wrongOutcome = await apiFormRequest("/api/checkins", { form, cookie: await login("rep") });
  assert.equal(wrongOutcome.status, 400);
});
