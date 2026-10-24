// A sales rep's colour for "Colour by Rep" on the map (owner, 2026-10-24): set by the admin in Team management, stored as #rrggbb, handed to the map with every customer.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let rep;
let adminCookie;
let repCookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("admin sets, changes and clears a rep's colour; bad values are refused; a rep cannot", async () => {
  const set = await apiRequest(`/api/users/${rep.id}`, { method: "PATCH", cookie: adminCookie, body: { map_color: "#0A69DA" } });
  assert.equal(set.status, 200);
  assert.equal(set.data.map_color, "#0a69da");
  const list = await apiRequest("/api/users", { cookie: adminCookie });
  assert.equal(list.data.find((u) => u.id === rep.id).map_color, "#0a69da");
  for (const bad of ["blue", "#12345", "#gggggg", "0a69da"]) {
    const res = await apiRequest(`/api/users/${rep.id}`, { method: "PATCH", cookie: adminCookie, body: { map_color: bad } });
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await apiRequest(`/api/users/${rep.id}`, { method: "PATCH", cookie: repCookie, body: { map_color: "#ff0000" } })).status, 403);
  const cleared = await apiRequest(`/api/users/${rep.id}`, { method: "PATCH", cookie: adminCookie, body: { map_color: null } });
  assert.equal(cleared.data.map_color, null);
  // the colour alone is a valid edit (no other field needed)
  const only = await apiRequest(`/api/users/${rep.id}`, { method: "PATCH", cookie: adminCookie, body: { map_color: "#d6403f" } });
  assert.equal(only.status, 200);
});

test("the customer list carries the assigned rep's colour for the map", async () => {
  await pool.query("UPDATE users SET map_color = '#1a7f37' WHERE id = $1", [rep.id]);
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `Color Probe ${Date.now()}` });
  const res = await apiRequest("/api/customers", { cookie: adminCookie });
  const row = res.data.find((x) => x.id === c.id);
  assert.equal(row.assigned_manager_color, "#1a7f37");
});
