// Sales directions edited in the admin panel (owner, 2026-11-12): a new direction gets its rules from its own settings, not from lists of
// names in the code; the existing ten keep today's behaviour (migration 204).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { rulesOf, isNoVisitChannel, isCallChannel, cashSourceOf, isSeparatePlanChannel, refreshChannelRules } from "../../src/shared/salesChannelRules.js";
import { commissionPct } from "../../../client/public/js/costModel.js";

const stamp = Date.now();
const CODE = `SM Test${String(stamp).slice(-5)}`;
let admin;
let adminCookie;
const createdCustomers = [];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM customers WHERE id = ANY($1)", [createdCustomers]);
  await pool.query("DELETE FROM sales_channels WHERE code LIKE 'SM Test%' OR code LIKE 'Retail Test%'");
  await refreshChannelRules();
  await cleanupAll();
  await stopTestServer();
});

test("today's ten directions keep their rules (the seed of migration 204 = the old lists in the code)", async () => {
  await refreshChannelRules();
  for (const c of ["KF", "CAS", "CVO", "PCO", "OEM"]) assert.equal(isNoVisitChannel(c), true, c);
  for (const c of ["SM YVN", "SM Davtashen", "SM Shirak", "SM B2B", "SM CAS"]) assert.equal(isNoVisitChannel(c), false, c);
  for (const c of ["SM B2B", "CVO", "PCO", "OEM"]) assert.equal(isCallChannel(c), true, c);
  assert.equal(rulesOf("KF").debt_mode, "none");
  assert.equal(cashSourceOf("SM YVN"), "Cash YVN");
  assert.equal(cashSourceOf("SM Davtashen"), "Cash DVT");
  assert.equal(cashSourceOf("OEM"), "Cash");
  assert.equal(isSeparatePlanChannel("SM B2B"), true);
  // commission as before: SM 4 %, CVO/PCO/OEM 2 %, KF/CAS 0
  assert.equal(commissionPct("SM YVN"), 4);
  assert.equal(commissionPct("CVO"), 2);
  assert.equal(commissionPct("KF"), 0);
});

test("only the admin creates or edits a direction; the code is unique (any case), not reserved, and never changes", async () => {
  const rep = await createUser("sales_manager");
  const repCookie = await loginAs(rep.email);
  assert.equal((await apiRequest("/api/sales-channels", { method: "POST", cookie: repCookie, body: { code: CODE } })).status, 403);
  assert.equal((await apiRequest("/api/sales-channels", { cookie: repCookie })).status, 200, "everyone reads the list");

  const created = await apiRequest("/api/sales-channels", {
    method: "POST",
    cookie: adminCookie,
    body: { code: CODE, name: "Gyumri test", visit_mode: "field", debt_mode: "call", cash_source: "Cash Gyumri", commission_kind: "rep", manager_user_id: rep.id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.code, CODE);
  assert.equal(created.data.manager_user_id, rep.id);
  assert.equal((await apiRequest("/api/sales-channels", { method: "POST", cookie: adminCookie, body: { code: CODE.toUpperCase() } })).status, 409);
  assert.equal((await apiRequest("/api/sales-channels", { method: "POST", cookie: adminCookie, body: { code: "potential" } })).status, 400);
  assert.equal((await apiRequest("/api/sales-channels", { method: "POST", cookie: adminCookie, body: { code: "bad;code" } })).status, 400);
  assert.equal((await apiRequest(`/api/sales-channels/${created.data.id}`, { method: "PATCH", cookie: adminCookie, body: { code: "Other" } })).status, 400);
  assert.equal((await apiRequest(`/api/sales-channels/${created.data.id}`, { method: "PATCH", cookie: adminCookie, body: { debt_mode: "sometimes" } })).status, 400);
  // a manager who is not active, or cannot own a direction, is refused
  const driver = await createUser("delivery_manager");
  assert.equal((await apiRequest(`/api/sales-channels/${created.data.id}`, { method: "PATCH", cookie: adminCookie, body: { manager_user_id: driver.id } })).status, 400);

  // its rules are live at once
  assert.equal(isCallChannel(CODE), true);
  assert.equal(cashSourceOf(CODE), "Cash Gyumri");
  assert.equal(commissionPct(CODE), 4);
  const edited = await apiRequest(`/api/sales-channels/${created.data.id}`, { method: "PATCH", cookie: adminCookie, body: { visit_mode: "no_visit", commission_kind: "none" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(isNoVisitChannel(CODE), true);
  assert.equal(commissionPct(CODE), 0);

  // a rep whose position IS the code gets new customers in it (the old word guess read "Gyumri" as SM Shirak)
  const gyumriRep = await createUser("sales_manager", { position: CODE });
  await pool.query("UPDATE users SET position = $2 WHERE id = $1", [gyumriRep.id, CODE]);
  const made = await apiRequest("/api/customers", { method: "POST", cookie: await loginAs(gyumriRep.email), body: { name: `ITEST SC ${stamp}`, lat: 40.79, lng: 43.84 } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  createdCustomers.push(made.data.id);
  assert.equal(made.data.sales_channel, CODE);
  // its customers are "not visited" now: the customer list says so
  const { rows: [rv] } = await pool.query(`SELECT ${(await import("../../src/customers/routes/customers.js")).NOT_NO_VISIT_CHANNEL_SQL} AS requires_visit FROM customers c WHERE c.id = $1`, [made.data.id]);
  assert.equal(rv.requires_visit, false, "a not-visited direction: no visit required");
});

test("a customer's direction must be one the admin panel knows; an inactive direction is kept on its customers but not given to new ones", async () => {
  const bad = await apiRequest("/api/customers", { method: "POST", cookie: adminCookie, body: { name: `ITEST SC bad ${stamp}`, lat: 40.1, lng: 44.5, sales_channel: "Typo Channel" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, "unknown_sales_channel");
  const code2 = `Retail Test${String(stamp).slice(-4)}`;
  const ch = await apiRequest("/api/sales-channels", { method: "POST", cookie: adminCookie, body: { code: code2, commission_kind: "trade", visit_type_key: "cvo" } });
  assert.equal(ch.status, 201, JSON.stringify(ch.data));
  const ok = await apiRequest("/api/customers", { method: "POST", cookie: adminCookie, body: { name: `ITEST SC ok ${stamp}`, lat: 40.1, lng: 44.5, sales_channel: code2 } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  createdCustomers.push(ok.data.id);
  await apiRequest(`/api/sales-channels/${ch.data.id}`, { method: "PATCH", cookie: adminCookie, body: { active: false } });
  // the customer keeps it (saving an unrelated field is fine), a new customer cannot get it
  const keep = await apiRequest(`/api/customers/${ok.data.id}`, { method: "PATCH", cookie: adminCookie, body: { sales_channel: code2 } });
  assert.notEqual(keep.status, 400, JSON.stringify(keep.data));
  const refused = await apiRequest("/api/customers", { method: "POST", cookie: adminCookie, body: { name: `ITEST SC off ${stamp}`, lat: 40.1, lng: 44.5, sales_channel: code2 } });
  assert.equal(refused.status, 400);
});
