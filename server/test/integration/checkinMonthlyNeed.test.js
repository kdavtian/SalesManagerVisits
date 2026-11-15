// Sales Expert (owner, 2026-11-15): the rep writes the shop's whole monthly oil need (all brands, litres) at the visit; the funnel measures
// our share of it. Saved with when and by whom; a nonsense value is left out without refusing the visit; no value changes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiFormRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, repCookie, customer;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'silver' WHERE id = $1", [customer.id]);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const visit = async (fields = {}) => {
  const form = new FormData();
  form.set("customer_id", customer.id);
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["follow_up_required"]));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin?.(res.data.id);
  return res;
};
const row = async () => (await pool.query("SELECT expected_volume_l, expected_volume_at, expected_volume_by FROM customers WHERE id = $1", [customer.id])).rows[0];

test("the visit saves the monthly need with when and by whom; nonsense is skipped, the visit is kept", async () => {
  await visit({ expected_volume_l: "320" });
  const r = await row();
  assert.equal(Number(r.expected_volume_l), 320);
  assert.ok(r.expected_volume_at);
  assert.equal(r.expected_volume_by, rep.id);

  await visit({ expected_volume_l: "-5" });
  assert.equal(Number((await row()).expected_volume_l), 320, "a negative number is left out");
  await visit({ expected_volume_l: "abc" });
  await visit({});
  assert.equal(Number((await row()).expected_volume_l), 320, "no number changes nothing");
  await visit({ expected_volume_l: "0" });
  assert.equal(Number((await row()).expected_volume_l), 320, "0 says nothing: not saved");
});

test("an offline visit that syncs late never writes over a number written after it", async () => {
  await visit({ expected_volume_l: "500" }); // written now
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await visit({ expected_volume_l: "300", captured_at: old }); // the queued visit of two hours ago arrives
  const r = await row();
  assert.equal(Number(r.expected_volume_l), 500);
  // a visit queued so long that its own time is refused is kept, but its number is not written as new
  const ancient = new Date(Date.now() - 30 * 86400000).toISOString();
  await visit({ expected_volume_l: "100", captured_at: ancient });
  assert.equal(Number((await row()).expected_volume_l), 500);
});
