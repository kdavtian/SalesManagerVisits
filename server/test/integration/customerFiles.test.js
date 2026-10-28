// Customer card "Files": the light photo list, the thumbnail + long-cache headers on a photo, and paging of the visit history.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, trackCheckin } from "./helpers.js";
import { apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/shared/upload.js";

const files = [];
const photoIds = [];
let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  if (photoIds.length) await pool.query("DELETE FROM checkin_photos WHERE id = ANY($1)", [photoIds]);
  for (const f of files) fs.rmSync(f, { force: true });
  await cleanupAll();
  await stopTestServer();
});

async function visit(customer, user, daysAgo) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['other'], now() - ($3 || ' days')::interval) RETURNING id`,
    [customer.id, user.id, String(daysAgo)]
  );
  trackCheckin(rows[0].id);
  return rows[0].id;
}

async function photo(checkinId, name, bytes) {
  const file = path.join(uploadDirPath, name);
  fs.writeFileSync(file, bytes);
  files.push(file, path.join(uploadDirPath, "thumbs", `${name}.jpg`));
  const { rows } = await pool.query("INSERT INTO checkin_photos (checkin_id, photo_path) VALUES ($1, $2) RETURNING id", [checkinId, name]);
  photoIds.push(rows[0].id);
  return rows[0].id;
}

async function bigJpeg() {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg({ quality: 80 }).toBuffer();
}

test("customer photos: ids + dates only, newest first; a plain rep sees only their own visits' photos", async () => {
  const mine = await createUser("sales_manager");
  const other = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: mine.id, assigned_manager_id: mine.id });
  const stamp = Date.now();
  const older = await photo(await visit(customer, mine, 5), `itest-cf-${stamp}-a.jpg`, await bigJpeg());
  const newer = await photo(await visit(customer, mine, 1), `itest-cf-${stamp}-b.jpg`, await bigJpeg());
  const theirs = await photo(await visit(customer, other, 3), `itest-cf-${stamp}-c.jpg`, await bigJpeg());

  const asMine = await apiRequest(`/api/customers/${customer.id}/photos`, { cookie: await loginAs(mine.email) });
  assert.equal(asMine.status, 200);
  assert.deepEqual(asMine.data.map((p) => p.id), [newer, older]);
  assert.deepEqual(Object.keys(asMine.data[0]).sort(), ["id", "timestamp"]);

  const asDirector = await apiRequest(`/api/customers/${customer.id}/photos`, { cookie: await loginAs(director.email) });
  assert.deepEqual(asDirector.data.map((p) => p.id), [newer, theirs, older]);
});

test("photo: long cache header; ?size=thumb is a small upright JPEG; an undecodable file falls back to the original", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id });
  const stamp = Date.now();
  const original = await bigJpeg();
  const id = await photo(await visit(customer, manager, 0), `itest-cf-${stamp}-d.jpg`, original);
  const broken = await photo(await visit(customer, manager, 0), `itest-cf-${stamp}-e.jpg`, Buffer.from("not an image"));
  const cookie = await loginAs(manager.email);

  const full = await fetch(`${baseUrl}/api/checkins/photos/${id}`, { headers: { Cookie: cookie } });
  assert.equal(full.status, 200);
  assert.match(full.headers.get("cache-control"), /max-age=31536000.*immutable/);
  assert.equal((await full.arrayBuffer()).byteLength, original.length);

  const thumb = await fetch(`${baseUrl}/api/checkins/photos/${id}?size=thumb`, { headers: { Cookie: cookie } });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/jpeg");
  assert.match(thumb.headers.get("cache-control"), /immutable/);
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  const sharp = (await import("sharp")).default;
  const meta = await sharp(thumbBytes).metadata();
  assert.equal(meta.width, 360);
  assert.ok(thumbBytes.length < original.length / 4, "thumbnail is far smaller than the original");

  const fallback = await fetch(`${baseUrl}/api/checkins/photos/${broken}?size=thumb`, { headers: { Cookie: cookie } });
  assert.equal(fallback.status, 200);
  assert.equal(Buffer.from(await fallback.arrayBuffer()).toString(), "not an image");

  // someone else's photo stays private
  const stranger = await createUser("sales_manager");
  const denied = await fetch(`${baseUrl}/api/checkins/photos/${id}?size=thumb`, { headers: { Cookie: await loginAs(stranger.email) } });
  assert.equal(denied.status, 403);
});

test("customer visits: ?limit= and ?offset= page the history; without them everything comes back", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id });
  for (const days of [4, 3, 2, 1, 0]) await visit(customer, manager, days);
  const cookie = await loginAs(manager.email);
  const all = await apiRequest(`/api/customers/${customer.id}/checkins`, { cookie });
  assert.equal(all.data.length, 5);
  const first = await apiRequest(`/api/customers/${customer.id}/checkins?limit=2`, { cookie });
  assert.deepEqual(first.data.map((r) => r.id), all.data.slice(0, 2).map((r) => r.id));
  const rest = await apiRequest(`/api/customers/${customer.id}/checkins?limit=1000&offset=2`, { cookie });
  assert.deepEqual(rest.data.map((r) => r.id), all.data.slice(2).map((r) => r.id));
});
