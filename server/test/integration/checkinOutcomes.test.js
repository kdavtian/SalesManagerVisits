// Owner, 2026-10-26: No order + Complaint merged into Other, Other needs a note, the signed order blank is a photo kept with the check-in,
// and the competitors list grew. POST /api/checkins is multipart, so everything here goes through apiFormRequest().
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiFormRequest, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/upload.js";

let cookie;
let customer;

test.before(async () => {
  await startTestServer();
  const manager = await createUser("sales_manager");
  cookie = await loginAs(manager.email);
  customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id, lat: 40.18, lng: 44.51 });
});
test.after(async () => {
  // Collecting money on a check-in also files a payment for the customer.
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  await cleanupAll();
  await stopTestServer();
});

async function checkin(fields, files = []) {
  const form = new FormData();
  form.set("customer_id", String(fields.customer_id ?? customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  for (const [key, value] of Object.entries(fields)) if (key !== "customer_id") form.set(key, value);
  for (const [field, name, bytes] of files) form.append(field, new Blob([bytes], { type: "image/jpeg" }), name);
  const res = await apiFormRequest("/api/checkins", { form, cookie });
  if (res.status === 201) trackCheckin(res.data.id);
  return res;
}

async function tinyJpeg() {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
}

test("Other needs a note; a note makes it pass", async () => {
  const bad = await checkin({ outcomes: JSON.stringify(["other"]) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "note_required_for_other");
  const blank = await checkin({ outcomes: JSON.stringify(["other"]), note: "   " });
  assert.equal(blank.status, 400);
  const ok = await checkin({ outcomes: JSON.stringify(["other"]), note: "Closed for holidays" });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.data.outcomes, ["other"]);
});

test("a check-in queued by an old phone with no_order / complaint is saved as Other, once, without needing a note", async () => {
  const res = await checkin({ outcomes: JSON.stringify(["no_order", "complaint", "payment_collected"]), amount_collected_amd: "1000" });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.outcomes, ["other", "payment_collected"]);
});

test("the office check-in (no outcome) is Other and needs no note", async () => {
  const manager = await createUser("sales_manager");
  const office = await createCustomer({ created_by: manager.id, lat: 40.18, lng: 44.51 });
  await pool.query("UPDATE customers SET checkin_for_all = true WHERE id = $1", [office.id]);
  const res = await checkin({ customer_id: office.id });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.outcomes, ["other"]);
});

test("Products delivered: the order-blank photo is stored as an order blank for the delivered orders and listed under the customer's Files", async () => {
  const jpeg = await tinyJpeg();
  const res = await checkin({ outcomes: JSON.stringify(["customer_unavailable"]) }, [
    ["photos", "visit.jpg", jpeg],
    ["order_blank_photos", "blank1.jpg", jpeg],
    ["order_blank_photos", "blank2.jpg", jpeg],
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.data.photo_count, 1);
  assert.equal(res.data.order_blank_count, 2);
  const { rows: visitRows } = await pool.query("SELECT photo_path FROM checkin_photos WHERE checkin_id = $1", [res.data.id]);
  assert.equal(visitRows.length, 1, "only the visit photo is a check-in photo");
  const files = (await apiRequest(`/api/files/customer/${customer.id}`, { cookie })).data;
  assert.equal(files.length, 2, "the two blank pages are customer documents");
  assert.ok(files.every((f) => f.kind === "order_blank"));
  const photos = (await apiRequest(`/api/customers/${customer.id}/photos`, { cookie })).data;
  assert.equal(photos.length, 1, "the visit photo is in Photos, the blanks are not");
  const { rows: fileRows } = await pool.query("SELECT file_path FROM customer_files WHERE checkin_id = $1", [res.data.id]);
  for (const r of [...visitRows, ...fileRows]) fs.rmSync(path.join(uploadDirPath, r.photo_path ?? r.file_path), { force: true });
  await pool.query("DELETE FROM checkin_photos WHERE checkin_id = $1", [res.data.id]);
  await pool.query("DELETE FROM customer_files WHERE checkin_id = $1", [res.data.id]);
});

test("an order-blank photo without the Products delivered outcome is refused", async () => {
  const res = await checkin({ outcomes: JSON.stringify(["payment_collected"]), amount_collected_amd: "500" }, [["order_blank_photos", "b.jpg", await tinyJpeg()]]);
  assert.equal(res.status, 400);
});

test("the new competitors are accepted in brand_status; unknown ones are dropped", async () => {
  const res = await checkin({
    outcomes: JSON.stringify(["follow_up_required"]),
    brand_status: JSON.stringify({ competitors: ["petronas", "s_oil", "kixx", "not_a_brand"] }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.brand_status.competitors, ["petronas", "s_oil", "kixx"]);
});
