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
import { balanceBeforeVisit } from "../../src/signedActs.js";

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
  // the payments the "Payment collected" visits made
  await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE customer_id = $1)", [customer.id]);
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [`SIGT${customer.id}`]);
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

// Owner, 2026-10-27: money collected without a delivery makes a signed payment slip; with a delivery the payment is written on the act.
test("payment collected without a delivery: a signed payment slip, its picture, and 2-per-page printing", async () => {
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd, synced_at) VALUES ($1, 500000, now()) ON CONFLICT (erp_customer_id) DO UPDATE SET debt_amd = 500000, synced_at = now()", [customer.erp_customer_id ?? `SIGT${customer.id}`]);
  if (!customer.erp_customer_id) await pool.query("UPDATE customers SET erp_customer_id = $2 WHERE id = $1", [customer.id, `SIGT${customer.id}`]);
  const pay = async (amount) => {
    const form = new FormData();
    form.set("customer_id", String(customer.id));
    form.set("lat", "40.18");
    form.set("lng", "44.51");
    form.set("outcomes", JSON.stringify(["payment_collected"]));
    form.set("amount_collected_amd", String(amount));
    form.append("customer_signature", new Blob([await png()], { type: "image/png" }), "s.png");
    const res = await apiFormRequest("/api/checkins", { form, cookie: await login("rep") });
    if (res.status === 201) trackCheckin(res.data.id);
    return res;
  };
  // 500,000 from Excel + the orders earlier tests delivered in the app (excelBalance.test.js checks that rule itself)
  const before = await balanceBeforeVisit(pool, customer.id);
  const amd = (v) => v.toLocaleString("en-US");
  const first = await pay(120000);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.ok(first.data.payment_slip?.id, "a slip was made");
  assert.equal(first.data.payment_slip_error, undefined);
  const { rows: [slip] } = await pool.query("SELECT kind, mime, payment_id, checkin_id, file_path FROM customer_files WHERE id = $1", [first.data.payment_slip.id]);
  assert.equal(slip.kind, "payment_slip");
  assert.equal(slip.checkin_id, first.data.id);
  assert.ok(slip.payment_id, "linked to the payment the visit created");
  const { execFileSync } = await import("node:child_process");
  const text = execFileSync("pdftotext", [path.join(uploadDirPath, slip.file_path), "-"]).toString();
  assert.match(text, /ՎՃԱՐՄԱՆ ԱՆԴՈՐՐԱԳԻՐ/);
  assert.match(text, /120,000/);
  assert.ok(text.includes(amd(before)), "previous debt");
  assert.ok(text.includes(amd(before - 120000)), "current balance = previous - 120,000");
  assert.doesNotMatch(text, /Պատվերի ամսաթիվ/);

  // the picture of it: what the viewer shows and "Save" stores
  const pic = await fetch(`${baseUrl}/api/files/${first.data.payment_slip.id}/preview?v=1`, { headers: { Cookie: await login("rep") } });
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("content-type"), "image/jpeg");
  assert.ok((await pic.arrayBuffer()).byteLength > 10000);

  // a second payment starts from the balance the first one left
  const second = await pay(30000);
  const { rows: [slip2] } = await pool.query("SELECT file_path FROM customer_files WHERE id = $1", [second.data.payment_slip.id]);
  assert.match(execFileSync("pdftotext", [path.join(uploadDirPath, slip2.file_path), "-"]).toString(), new RegExp(amd(before - 150000)));

  // two slips, one A4 sheet
  const printed = await fetch(`${baseUrl}/api/files/print-slips`, {
    method: "POST",
    headers: { Cookie: await login("admin"), "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent((await login("admin")).match(/csrf_token=([^;]+)/)?.[1] ?? "") },
    body: JSON.stringify({ ids: [first.data.payment_slip.id, second.data.payment_slip.id] }),
  });
  assert.equal(printed.status, 200);
  const pdf = Buffer.from(await printed.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const pages = execFileSync("pdfinfo", ["-"], { input: pdf }).toString().match(/Pages:\s+(\d+)/)[1];
  assert.equal(pages, "1");
});

test("money without the customer's signature or a slip photo is saved after the warning, marked not confirmed and found by the filter; a photographed paper slip is the slip", async () => {
  const send = async ({ outcome = "payment_collected", slipPhoto = false } = {}) => {
    const form = new FormData();
    form.set("customer_id", String(customer.id));
    form.set("lat", "40.18");
    form.set("lng", "44.51");
    form.set("outcomes", JSON.stringify([outcome]));
    if (outcome === "payment_collected") form.set("amount_collected_amd", "1000");
    if (slipPhoto) form.append("payment_slip_photos", new Blob([await png("#888888")], { type: "image/png" }), "slip.png");
    const res = await apiFormRequest("/api/checkins", { form, cookie: await login("rep") });
    if (res.status === 201) trackCheckin(res.data.id);
    return res;
  };
  const paymentOf = async (checkinId) => (await pool.query("SELECT id, customer_confirmation FROM payments WHERE client_ref = $1", [`checkin-${checkinId}`])).rows[0];

  // nothing: saved (the phone only warns), marked "none", the unsigned slip is still made
  const bare = await send();
  assert.equal(bare.status, 201, JSON.stringify(bare.data));
  assert.equal(bare.data.customer_confirmation, "none");
  const barePayment = await paymentOf(bare.data.id);
  assert.equal(barePayment.customer_confirmation, "none");
  assert.ok(bare.data.payment_slip?.id, "the slip is still made, without a customer signature");
  const found = (await apiRequest("/api/payments?confirmation=none", { cookie: await login("admin") })).data.rows;
  assert.ok(found.some((p) => p.id === barePayment.id), "found with the Not confirmed filter");
  assert.ok(found.every((p) => p.customer_confirmation === "none"));

  // a photo of the signed paper slip: stored as the payment's slip, no second (unsigned) one is made, it prints 2 per page too
  const photo = await send({ slipPhoto: true });
  assert.equal(photo.status, 201, JSON.stringify(photo.data));
  assert.equal(photo.data.customer_confirmation, "photo");
  assert.equal(photo.data.payment_slip, undefined);
  const photoPayment = await paymentOf(photo.data.id);
  assert.equal(photoPayment.customer_confirmation, "photo");
  const { rows: [file] } = await pool.query("SELECT id, kind, mime, payment_id FROM customer_files WHERE checkin_id = $1", [photo.data.id]);
  assert.deepEqual([file.kind, file.mime, file.payment_id], ["payment_slip", "image/png", photoPayment.id]);
  const printed = await fetch(`${baseUrl}/api/files/print-slips`, {
    method: "POST",
    headers: { Cookie: await login("admin"), "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent((await login("admin")).match(/csrf_token=([^;]+)/)?.[1] ?? "") },
    body: JSON.stringify({ ids: [file.id, bare.data.payment_slip.id] }),
  });
  assert.equal(printed.status, 200);
  assert.equal(Buffer.from(await printed.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await apiRequest("/api/payments?confirmation=photo", { cookie: await login("admin") })).data.rows.some((p) => p.id === photoPayment.id), true);

  // a slip photo belongs to money collected
  assert.equal((await send({ outcome: "follow_up_required", slipPhoto: true })).status, 400);
});

test("payment and delivery at one visit: the payment is written on the act, no separate slip", async () => {
  const id = await newOrder(70000);
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["customer_unavailable", "payment_collected"]));
  form.set("delivered_order_ids", JSON.stringify([id]));
  form.set("amount_collected_amd", "50000");
  form.append("customer_signature", new Blob([await png()], { type: "image/png" }), "s.png");
  const res = await apiFormRequest("/api/checkins", { form, cookie: await login("rep") });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);
  assert.equal(res.data.signed_acts.length, 1);
  assert.equal(res.data.payment_slip, undefined);
  const { rows: [act] } = await pool.query("SELECT file_path FROM customer_files WHERE id = $1", [res.data.signed_acts[0].id]);
  const { execFileSync } = await import("node:child_process");
  const text = execFileSync("pdftotext", ["-layout", path.join(uploadDirPath, act.file_path), "-"]).toString();
  assert.match(text, /Վճարում՝\s+50,000/);
  assert.match(text, /Պատվեր՝\s+70,000/);
});
