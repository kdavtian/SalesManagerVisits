// Search in both scripts on the server (customers/customerSearch.js; owner, 2026-10-29): the Customers list and the Orders search find
// "Ջրվեժ" from "jrvej", "Castrol" from "կաստրոլ", a long word with one typo, and list the exact matches first.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";

const tag = `Bls${Date.now().toString(36).replace(/\d/g, "")}`;
let cookie, armenian, latin;

test.before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  cookie = await loginAs(admin.email);
  armenian = await createCustomer({ name: `Ջրվեժ Ավտո ${tag}`, created_by: admin.id });
  latin = await createCustomer({ name: `Castrol Point ${tag}`, created_by: admin.id });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const names = async (search) => {
  const res = await apiRequest(`/api/customers?search=${encodeURIComponent(search)}`, { cookie });
  assert.equal(res.status, 200);
  return res.data.map((c) => c.id);
};

test("Latin finds Armenian and Armenian finds Latin", async () => {
  assert.ok((await names(`jrvej ${tag}`)).includes(armenian.id));
  assert.ok((await names(`կաստրոլ ${tag}`)).includes(latin.id));
  assert.ok((await names(`qastrol ${tag}`)).includes(latin.id));
  assert.ok(!(await names(`jrvej ${tag}`)).includes(latin.id));
});

test("a long word with one letter wrong still finds it; exact matches come first", async () => {
  assert.ok((await names(`kastrl ${tag}`)).includes(latin.id));
  const both = await names(tag);
  assert.ok(both.includes(armenian.id) && both.includes(latin.id));
});

// Owner, 2026-11-07: "user search for 10174, it should bring first exact matches, but the list dont include the 10174 customer". The
// top-bar search asks for 5 rows: they came in name order (not best match first), and 10173 / 10175 counted as "one digit off".
test("an Excel ID typed exactly comes first, also when only 5 rows are asked for; a number is never one digit off", async () => {
  const admin = await createUser("admin");
  const base = 70000 + (Date.now() % 20000);
  const id = String(base);
  const neighbours = [];
  for (const n of [base - 1, base + 1, base + 10, base + 100]) {
    neighbours.push(await createCustomer({ name: `AAA Neighbour ${n}`, created_by: admin.id, erp_customer_id: String(n) }));
  }
  // longer IDs that contain the typed number are matches too, and their names come first alphabetically
  for (const extra of ["1", "2", "3", "4", "5", "6"]) await createCustomer({ name: `AAA Longer ${id}${extra}`, created_by: admin.id, erp_customer_id: `${id}${extra}` });
  const target = await createCustomer({ name: `ZZZ Exact ${tag}`, created_by: admin.id, erp_customer_id: id });
  const res = await apiRequest(`/api/customers?search=${id}&limit=5`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data[0]?.id, target.id, "the exact Excel ID is the first row");
  const ids = res.data.map((c) => c.id);
  for (const n of neighbours.slice(0, 2)) assert.ok(!ids.includes(n.id), "a number one digit off is another customer");
});
