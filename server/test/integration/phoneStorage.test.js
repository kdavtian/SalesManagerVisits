// Phones are stored as digits only (+37491007019) whatever shape they arrive in.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, adminCookie;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("customer, user and own-profile phones are normalised on save; an empty prefill clears the phone", async () => {
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: admin.id });
  const patched = await apiRequest(`/api/customers/${c.id}`, { method: "PATCH", cookie: adminCookie, body: { phone: "+374 91 007 019" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal((await pool.query("SELECT phone FROM customers WHERE id = $1", [c.id])).rows[0].phone, "+37491007019");
  await apiRequest(`/api/customers/${c.id}`, { method: "PATCH", cookie: adminCookie, body: { phone: "091-007-019" } });
  assert.equal((await pool.query("SELECT phone FROM customers WHERE id = $1", [c.id])).rows[0].phone, "+37491007019");
  await apiRequest(`/api/customers/${c.id}`, { method: "PATCH", cookie: adminCookie, body: { phone: "+374 " } });
  assert.equal((await pool.query("SELECT phone FROM customers WHERE id = $1", [c.id])).rows[0].phone, null);

  const staff = await createUser("sales_manager");
  const u = await apiRequest(`/api/users/${staff.id}`, { method: "PATCH", cookie: adminCookie, body: { phone: "+374 96 007 015" } });
  assert.equal(u.status, 200);
  assert.equal(u.data.phone, "+37496007015");

  const mine = await apiRequest("/api/me/profile", { method: "PATCH", cookie: adminCookie, body: { phone: "033 007 059" } });
  assert.ok([200, 204].includes(mine.status), JSON.stringify(mine.data));
  assert.equal((await pool.query("SELECT phone FROM users WHERE id = $1", [admin.id])).rows[0].phone, "+37433007059");
});
