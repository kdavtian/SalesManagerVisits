// API coverage for Check-ins, GPS, and photos (server/src/routes/checkins.js).
// Offline-queue duplicate resubmission (client_ref idempotency) is already
// covered by offlineIdempotency.test.js and deliberately not repeated here.
//
// POST /api/checkins is multipart (multer), so every submission here goes
// through helpers.js's apiFormRequest() rather than apiRequest().
import test from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  cleanupAll,
  createUser,
  createCustomer,
  apiRequest,
  apiFormRequest,
  loginAs,
  trackCheckin,
} from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let manager;
let cookie;
let customer;

test.before(async () => {
  await startTestServer();
  manager = await createUser("sales_manager");
  cookie = await loginAs(manager.email);
  customer = await createCustomer({ created_by: manager.id, lat: 40.18, lng: 44.51 });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

function checkinForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

// --- Valid requests + GPS radius (non-blocking) --------------------------------

test("POST /api/checkins: submitting right at the customer's own coordinates records within_range: true", async () => {
  const res = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({ customer_id: customer.id, lat: String(customer.lat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(res.status, 201);
  trackCheckin(res.data.id);
  assert.equal(res.data.within_range, true);
});

test("POST /api/checkins: submitting far from the customer still succeeds, just flagged within_range: false (non-blocking)", async () => {
  // ~5.5km north of the customer -- far past any plausible configured radius.
  const farLat = customer.lat + 0.05;
  const res = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({ customer_id: customer.id, lat: String(farLat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(res.status, 201, "an out-of-range check-in must still save, not be rejected");
  trackCheckin(res.data.id);
  assert.equal(res.data.within_range, false);
});

// --- payment_collected outcome auto-creates a linked payment --------------------

test("POST /api/checkins: a payment_collected outcome auto-creates a linked payments row in the same transaction", async () => {
  const res = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({
      customer_id: customer.id,
      lat: String(customer.lat),
      lng: String(customer.lng),
      outcomes: JSON.stringify(["payment_collected"]),
      amount_collected_amd: "15000",
    }),
  });
  assert.equal(res.status, 201);
  trackCheckin(res.data.id);

  const { rows } = await pool.query("SELECT amount_amd, customer_id FROM payments WHERE client_ref = $1", [`checkin-${res.data.id}`]);
  assert.equal(rows.length, 1, "exactly one linked payment must be created");
  assert.equal(Number(rows[0].amount_amd), 15000);
  assert.equal(rows[0].customer_id, customer.id);

  await pool.query("DELETE FROM payments WHERE client_ref = $1", [`checkin-${res.data.id}`]);
});

test("POST /api/checkins: payment_collected without a positive amount_collected_amd is a 400", async () => {
  const missing = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({ customer_id: customer.id, lat: String(customer.lat), lng: String(customer.lng), outcomes: JSON.stringify(["payment_collected"]) }),
  });
  assert.equal(missing.status, 400);

  const zero = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({
      customer_id: customer.id,
      lat: String(customer.lat),
      lng: String(customer.lng),
      outcomes: JSON.stringify(["payment_collected"]),
      amount_collected_amd: "0",
    }),
  });
  assert.equal(zero.status, 400);
});

// --- Invalid / boundary input -----------------------------------------------------

test("POST /api/checkins: missing customer_id/lat/lng/outcomes is a 400", async () => {
  const res = await apiFormRequest("/api/checkins", { cookie, form: checkinForm({ lat: "40.18", lng: "44.51" }) });
  assert.equal(res.status, 400);
});

test("POST /api/checkins: a nonexistent customer_id is a 404", async () => {
  const res = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({ customer_id: "999999999", lat: "40.18", lng: "44.51", outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(res.status, 404);
});

// --- Photos: valid + boundary (MAX_PHOTOS_PER_CHECKIN = 5) ------------------------

function tinyPngBlob() {
  // A 1x1 transparent PNG -- small, valid image bytes for multer/sharp
  // (if any image processing runs) to accept without choking on garbage.
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const bytes = Buffer.from(base64, "base64");
  return new Blob([bytes], { type: "image/png" });
}

test("POST /api/checkins: a single photo upload succeeds and is reflected in photo_count", async () => {
  const form = checkinForm({ customer_id: customer.id, lat: String(customer.lat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) });
  form.append("photos", tinyPngBlob(), "test.png");

  const res = await apiFormRequest("/api/checkins", { cookie, form });
  assert.equal(res.status, 201);
  trackCheckin(res.data.id);
  assert.equal(res.data.photo_count, 1);
});

test("POST /api/checkins: exceeding MAX_PHOTOS_PER_CHECKIN (5) is rejected with a 400, not silently truncated", async () => {
  const form = checkinForm({ customer_id: customer.id, lat: String(customer.lat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) });
  for (let i = 0; i < 6; i++) form.append("photos", tinyPngBlob(), `test${i}.png`);

  const res = await apiFormRequest("/api/checkins", { cookie, form });
  assert.equal(res.status, 400);
});

// --- Unauthenticated ---------------------------------------------------------------

test("POST and GET /api/checkins reject an unauthenticated request with 401", async () => {
  const getRes = await apiRequest("/api/checkins");
  assert.equal(getRes.status, 401);

  const postRes = await apiFormRequest("/api/checkins", {
    form: checkinForm({ customer_id: customer.id, lat: String(customer.lat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(postRes.status, 401);
});
