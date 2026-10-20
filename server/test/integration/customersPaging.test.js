// GET /api/customers in pages (server/src/routes/customers.js): the Customers screen reads the list 500 at a time,
// each page continuing after the last customer of the previous one (after_name + after_id), the pickers ask for just
// their first 8-30 matches (limit), and a call without limit still returns everything (the Map needs that).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";

let admin;
let rep;
let otherRep;
let adminCookie;
let repCookie;
const prefix = `Itest Paging ${Date.now()}`;
// Two customers share a name on purpose: a cursor on the name alone would skip or repeat one of them.
const NAMES = [`${prefix} A`, `${prefix} B`, `${prefix} B`, `${prefix} C`, `${prefix} D`, `${prefix} E`, `${prefix} F`];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  otherRep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  for (const [i, name] of NAMES.entries()) {
    await createCustomer({ name, created_by: admin.id, assigned_manager_id: i < 5 ? rep.id : otherRep.id });
  }
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const list = async (query, cookie = adminCookie) => {
  const res = await apiRequest(`/api/customers?search=${encodeURIComponent(prefix)}${query}`, { cookie });
  assert.equal(res.status, 200);
  return res.data;
};

// Walks the list the way the Customers screen does: limit + a cursor made from the last row of each page.
async function walk(limit, cookie) {
  const rows = [];
  let cursor = "";
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await list(`&limit=${limit}${cursor}`, cookie);
    assert.ok(page.length <= limit, "a page never exceeds its limit");
    rows.push(...page);
    if (page.length < limit) return rows;
    const last = page[page.length - 1];
    cursor = `&after_name=${encodeURIComponent(last.name)}&after_id=${last.id}`;
  }
  assert.fail("paging never ended");
}

test("without limit the whole list comes back, ordered by name then id", async () => {
  const all = await list("");
  assert.equal(all.length, NAMES.length);
  const sorted = [...all].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
  assert.deepEqual(all.map((c) => c.id), sorted.map((c) => c.id));
});

test("pages of any size joined together equal the unpaged list: nothing skipped, nothing repeated (even for equal names)", async () => {
  const all = await list("");
  for (const limit of [1, 2, 3, 7, 8]) {
    const walked = await walk(limit, adminCookie);
    assert.deepEqual(walked.map((c) => c.id), all.map((c) => c.id), `limit ${limit}`);
  }
});

test("limit alone returns the first rows, and offset skips rows", async () => {
  const all = await list("");
  assert.deepEqual((await list("&limit=2")).map((c) => c.id), all.slice(0, 2).map((c) => c.id));
  assert.deepEqual((await list("&limit=2&offset=3")).map((c) => c.id), all.slice(3, 5).map((c) => c.id));
});

test("a limit that is not a positive whole number is ignored; a huge one is capped, not an error", async () => {
  const all = await list("");
  for (const bad of ["abc", "0", "-5", ""]) {
    assert.equal((await list(`&limit=${bad}`)).length, all.length, `limit=${bad}`);
  }
  assert.equal((await list("&limit=999999")).length, all.length);
});

test("a sales manager paging through the list only ever sees their own customers", async () => {
  const walked = await walk(2, repCookie);
  assert.equal(walked.length, 5);
  assert.ok(walked.every((c) => c.assigned_manager_id === rep.id));
});
