// API coverage for Check-ins, GPS, and photos (server/src/field/routes/checkins.js).
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

test("POST /api/checkins: a sales manager far from the customer is refused (Check-in allowance), nothing is saved", async () => {
  // ~5.5km north of the customer -- far past the allowance.
  const farLat = customer.lat + 0.05;
  const res = await apiFormRequest("/api/checkins", {
    cookie,
    form: checkinForm({ customer_id: customer.id, lat: String(farLat), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(res.status, 422);
  assert.equal(res.data.code, "checkin_too_far");
  assert.ok(res.data.distance_meters > 5000);
  assert.ok(res.data.allowance_meters >= 10);
  const { rows } = await pool.query("SELECT 1 FROM checkins WHERE customer_id = $1 AND user_id = $2 AND NOT within_range", [customer.id, manager.id]);
  assert.equal(rows.length, 0);
});

test("POST /api/checkins: GPS accuracy up to 100 m is forgiven when judging the allowance", async () => {
  // ~390 m north: past the 300 m allowance with an exact fix, inside it when the fix is only good to +-150 m (100 m credited)
  const lat = customer.lat + 0.0035;
  const post = (accuracy, at = lat) =>
    apiFormRequest("/api/checkins", {
      cookie,
      form: checkinForm({ customer_id: customer.id, lat: String(at), lng: String(customer.lng), accuracy_m: String(accuracy), outcomes: JSON.stringify(["no_order"]) }),
    });
  const admin = await createUser("admin");
  const adminCookie = await loginAs(admin.email);
  const radius = (await apiRequest("/api/settings", { cookie })).data.checkin_radius_meters;
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 300 } });
  try {
    assert.equal((await post(10)).status, 422, "a precise fix 390 m away is refused");
    const ok = await post(150);
    assert.equal(ok.status, 201, "a +-150 m fix gets 100 m of credit");
    trackCheckin(ok.data.id);
    assert.equal(ok.data.within_range, false, "the real distance is still recorded as outside the allowance");
    assert.equal((await post(5000, customer.lat + 0.0048)).status, 422, "credit is capped at 100 m: ~530 m away stays refused however coarse the fix");
  } finally {
    await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: radius } });
  }
});

test("Check-in allowance switch: admin turns it off -> a far sales manager check-in is saved (flagged within_range: false); on again -> refused", async () => {
  const admin = await createUser("admin");
  const adminCookie = await loginAs(admin.email);
  const far = () =>
    apiFormRequest("/api/checkins", {
      cookie,
      form: checkinForm({ customer_id: customer.id, lat: String(customer.lat + 0.05), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
    });
  assert.equal((await apiRequest("/api/settings", { cookie })).data.checkin_allowance_enabled, true, "on by default");
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie, body: { checkin_allowance_enabled: "no" } })).status, 403, "admin only");
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_allowance_enabled: "no" } })).status, 400);
  try {
    const off = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_allowance_enabled: false } });
    assert.equal(off.data.checkin_allowance_enabled, false);
    const res = await far();
    assert.equal(res.status, 201, "no refusal while the allowance is off");
    trackCheckin(res.data.id);
    assert.equal(res.data.within_range, false, "the distance is still recorded and flagged");
  } finally {
    await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_allowance_enabled: true } });
  }
  assert.equal((await far()).status, 422);
});

test("POST /api/checkins: management (director) can check in from anywhere; it is saved flagged within_range: false", async () => {
  const director = await createUser("sales_director");
  const directorCookie = await loginAs(director.email);
  const res = await apiFormRequest("/api/checkins", {
    cookie: directorCookie,
    form: checkinForm({ customer_id: customer.id, lat: String(customer.lat + 0.05), lng: String(customer.lng), outcomes: JSON.stringify(["no_order"]) }),
  });
  assert.equal(res.status, 201, "management is not limited by the allowance");
  trackCheckin(res.data.id);
  assert.equal(res.data.within_range, false);
});

test("GET /api/customers/:id/checkin-spots: last 5 real check-in spots + the pin; a rep sees only their own", async () => {
  const other = await createUser("sales_manager");
  for (let i = 0; i < 6; i++) {
    await pool.query(
      `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, outcomes)
       VALUES ($1, $2, now() - ($3 || ' hours')::interval, $4, $5, 120, true, '{other}')`,
      [customer.id, manager.id, String(i + 1), customer.lat + 0.001 * i, customer.lng]
    );
  }
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, outcomes)
     VALUES ($1, $2, now(), $3, $4, 50, true, '{other}')`,
    [customer.id, other.id, customer.lat, customer.lng]
  );
  const res = await apiRequest(`/api/customers/${customer.id}/checkin-spots`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.customer.id, customer.id);
  assert.equal(res.data.spots.length, 5);
  assert.ok(res.data.spots.every((sp) => sp.user_id === manager.id), "a rep sees only their own check-ins");
  assert.ok(res.data.allowance_meters >= 10);
  const times = res.data.spots.map((sp) => new Date(sp.timestamp).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => y - x), "newest first");
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
