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
