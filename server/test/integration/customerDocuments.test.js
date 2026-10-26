// Customer documents (routes/files.js): add, who sees what, the inbox, thumbnails, rotate, delete.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/upload.js";

let baseUrl;
const made = [];
const users = {};
const cookies = {};
const login = async (key) => (cookies[key] ??= await loginAs(users[key].email));
test.before(async () => {
  baseUrl = await startTestServer();
  for (const [key, role] of Object.entries({ rep: "sales_manager", other: "sales_manager", director: "sales_director", accountant: "accountant", ceo: "ceo", warehouse: "warehouse_manager", admin: "admin" })) {
    users[key] = await createUser(role);
  }
});
test.after(async () => {
  const { rows } = await pool.query("SELECT file_path FROM customer_files WHERE id = ANY($1)", [made]);
  for (const r of rows) {
    fs.rmSync(path.join(uploadDirPath, r.file_path), { force: true });
    fs.rmSync(path.join(uploadDirPath, "thumbs", `${r.file_path}.jpg`), { force: true });
  }
  await pool.query("DELETE FROM customer_files WHERE id = ANY($1)", [made]);
  await cleanupAll();
  await stopTestServer();
});

async function image(width = 300, height = 100) {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
}

async function add(customerId, cookie, fields = {}, bytes) {
  const form = new FormData();
  form.set("file", new Blob([bytes ?? (await image())], { type: "image/jpeg" }), "doc.jpg");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await apiFormRequest(`/api/files/customer/${customerId}`, { form, cookie });
  if (res.status === 201) made.push(res.data.id);
  return res;
}

test("a rep adds a document; another rep cannot see it, the director and the accountant can", async () => {
  const { rep } = users;
  const customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const repCookie = await login("rep");
  const created = await add(customer.id, repCookie, { kind: "payment_slip", note: "slip 1" });
  assert.equal(created.status, 201);

  const mine = await apiRequest(`/api/files/customer/${customer.id}`, { cookie: repCookie });
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].kind, "payment_slip");
  assert.equal(mine.data[0].user_name, rep.name);

  assert.equal((await apiRequest(`/api/files/customer/${customer.id}`, { cookie: await login("other") })).data.length, 0);
  assert.equal((await apiRequest(`/api/files/customer/${customer.id}`, { cookie: await login("director") })).data.length, 1);
  assert.equal((await apiRequest(`/api/files/customer/${customer.id}`, { cookie: await login("accountant") })).data.length, 1);
  const stranger = await fetch(`${baseUrl}/api/files/${created.data.id}/content`, { headers: { Cookie: await login("other") } });
  assert.equal(stranger.status, 404);
});

test("warehouse staff cannot add; a director and the CEO can; a link to someone else's order is refused", async () => {
  const { director } = users;
  const customer = await createCustomer({ created_by: director.id });
  const stranger = await createCustomer({ created_by: director.id });
  assert.equal((await add(customer.id, await login("warehouse"))).status, 403);
  assert.equal((await add(customer.id, await login("ceo"), { kind: "other" })).status, 201);
  assert.equal((await add(customer.id, await login("director"), { kind: "order_blank" })).status, 201);
  const { rows } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd) VALUES ($1, $2, 'delivered', 1000) RETURNING id", [stranger.id, director.id]);
  const bad = await add(customer.id, await login("director"), { order_ids: JSON.stringify([rows[0].id]) });
  assert.equal(bad.status, 400);
  await pool.query("DELETE FROM orders WHERE id = $1", [rows[0].id]);
});

test("the inbox filters by type, by 'not linked' and by rep; a rep only gets his own", async () => {
  const { rep, other } = users;
  const customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const a = await add(customer.id, await login("rep"), { kind: "payment_slip" });
  const b = await add(customer.id, await login("other"), { kind: "order_blank" });
  const cookie = await login("accountant");
  const all = await apiRequest(`/api/files?customer_id=${customer.id}`, { cookie });
  assert.deepEqual(all.data.rows.map((r) => r.id).sort(), [a.data.id, b.data.id].sort());
  assert.deepEqual((await apiRequest(`/api/files?customer_id=${customer.id}&kind=payment_slip`, { cookie })).data.rows.map((r) => r.id), [a.data.id]);
  assert.deepEqual((await apiRequest(`/api/files?customer_id=${customer.id}&user_id=${other.id}`, { cookie })).data.rows.map((r) => r.id), [b.data.id]);
  assert.equal((await apiRequest(`/api/files?customer_id=${customer.id}&linked=0`, { cookie })).data.rows.length, 2);
  assert.equal((await apiRequest(`/api/files?customer_id=${customer.id}&issues=1`, { cookie })).data.rows.length, 0);
  assert.equal((await apiRequest(`/api/files?customer_id=${customer.id}&period=today`, { cookie })).data.rows.length, 2);
  const mine = await apiRequest(`/api/files?customer_id=${customer.id}`, { cookie: await login("other") });
  assert.deepEqual(mine.data.rows.map((r) => r.id), [b.data.id], "the other rep sees what he added, not the first rep's");
});

test("a thumbnail is small and cached for a year; rotate turns the photo, raises the version and is limited to the owner / admin / CEO", async () => {
  const { rep } = users;
  const customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const cookie = await login("rep");
  const sharp = (await import("sharp")).default;
  const created = await add(customer.id, cookie, { kind: "order_blank" }, await image(800, 200));
  const thumb = await fetch(`${baseUrl}/api/files/${created.data.id}/content?size=thumb`, { headers: { Cookie: cookie } });
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get("cache-control"), /immutable/);
  assert.equal((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).width, 360);

  assert.equal((await apiRequest(`/api/files/${created.data.id}/rotate`, { method: "POST", body: { degrees: 90 }, cookie: await login("director") })).status, 403);
  assert.equal((await apiRequest(`/api/files/${created.data.id}/rotate`, { method: "POST", body: { degrees: 45 }, cookie })).status, 400);
  const turned = await apiRequest(`/api/files/${created.data.id}/rotate`, { method: "POST", body: { degrees: 90 }, cookie });
  assert.equal(turned.status, 200);
  assert.equal(turned.data.version, 2);
  const full = await fetch(`${baseUrl}/api/files/${created.data.id}/content`, { headers: { Cookie: cookie } });
  const meta = await sharp(Buffer.from(await full.arrayBuffer())).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 800]);

  assert.equal((await apiRequest(`/api/files/${created.data.id}`, { method: "DELETE", cookie })).status, 403, "the rep cannot delete");
  assert.equal((await apiRequest(`/api/files/${created.data.id}`, { method: "DELETE", cookie: await login("admin") })).status, 204);
});
