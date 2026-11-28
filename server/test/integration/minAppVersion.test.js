// Minimum app version for saves (Phase 0 item 0.21, owner 2026-11-28; server/src/middleware/appVersion.js): with MIN_APP_VERSION set, a
// save from an older phone gets 426 "update_required"; reads, callers with no X-App-Version (CEO bot, integration API, KAD OS) and the
// sign-in pass; off by default; never above the version this server ships.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { CLIENT_PUBLIC_DIR } from "../../src/shared/paths.js";
import { pool } from "../../src/db/pool.js";
import { minAppVersion, parseVersion, compareVersions, checkAppVersion } from "../../src/middleware/appVersion.js";

const SHIPPED = fs.readFileSync(path.join(CLIENT_PUBLIC_DIR, "js/version.js"), "utf8").match(/APP_VERSION\s*=\s*"([^"]+)"/)[1];
const [maj, min] = parseVersion(SHIPPED);
const OLD = `${maj}.${min - 1}.0`; // a phone just below the shipped (= minimum) version

let manager;
let cookie;
let customer;
const saved = process.env.MIN_APP_VERSION;

test.before(async () => {
  await startTestServer();
  manager = await createUser("sales_manager");
  cookie = await loginAs(manager.email);
  customer = await createCustomer({ created_by: manager.id, lat: 40.18, lng: 44.51 });
});
test.after(async () => {
  if (saved === undefined) delete process.env.MIN_APP_VERSION;
  else process.env.MIN_APP_VERSION = saved;
  await cleanupAll();
  await stopTestServer();
});

const save = (version) =>
  apiFormRequest("/api/checkins", {
    cookie,
    headers: version ? { "X-App-Version": version } : {},
    form: (() => {
      const f = new FormData();
      f.set("customer_id", String(customer.id));
      f.set("lat", String(customer.lat));
      f.set("lng", String(customer.lng));
      f.set("outcomes", JSON.stringify(["no_order"]));
      f.set("client_ref", `minver-${version}-${Math.random()}`);
      return f;
    })(),
  });

test("version helpers compare numerically, not as text", () => {
  assert.equal(compareVersions(parseVersion("1.99.0"), parseVersion("1.100.0")), -1);
  assert.equal(compareVersions(parseVersion("1.610.0"), parseVersion("1.610")), 0);
  assert.equal(parseVersion("garbage"), null);
});

test("off by default: an old phone saves as before", async () => {
  delete process.env.MIN_APP_VERSION;
  const res = await save(OLD);
  assert.equal(res.status, 201);
});

test("MIN_APP_VERSION set: a save from an older phone is refused with update_required, nothing saved", async () => {
  process.env.MIN_APP_VERSION = SHIPPED;
  const before = await pool.query("SELECT count(*)::int AS n FROM checkins WHERE user_id = $1", [manager.id]);
  const res = await save(OLD);
  assert.ok([426, 503].includes(res.status)); // 426 for a 426-aware phone, 503 for an older one (next tests)
  assert.equal(res.data.code, "update_required");
  assert.equal(res.data.min_version, parseVersion(SHIPPED).join("."));
  const after = await pool.query("SELECT count(*)::int AS n FROM checkins WHERE user_id = $1", [manager.id]);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

// The rule alone (a minimum above the shipped app can only be tested this way, since the live one is capped to it).
function run(method, url, version, minVersion) {
  let status = null;
  let body = null;
  let passed = false;
  const req = { method, originalUrl: url, get: (h) => (h === "X-App-Version" ? version : undefined) };
  const res = { status: (s) => ((status = s), { json: (b) => (body = b) }) };
  checkAppVersion(req, res, () => (passed = true), minVersion ? parseVersion(minVersion) : null);
  return { status, body, passed };
}

test("the rule: 426 for a 426-aware phone below the minimum, 503 for an older one, pass otherwise", () => {
  assert.equal(run("POST", "/api/orders", "1.612.0", "1.613.0").status, 426);
  assert.equal(run("POST", "/api/orders", "1.611.0", "1.613.0").status, 426);
  assert.equal(run("POST", "/api/orders", "1.610.0", "1.613.0").status, 503); // its queue would delete on a 4xx
  assert.equal(run("POST", "/api/orders", "1.610.0", "1.613.0").body.code, "update_required");
  assert.equal(run("POST", "/api/orders", "1.613.0", "1.613.0").passed, true);
  assert.equal(run("GET", "/api/orders", "1.0.0", "1.613.0").passed, true); // reads pass
  assert.equal(run("POST", "/api/orders", undefined, "1.613.0").passed, true); // bot / integration / KAD OS
  assert.equal(run("POST", "/api/auth/login", "1.0.0", "1.613.0").passed, true);
  assert.equal(run("POST", "/api/integration/v1/x", "1.0.0", "1.613.0").passed, true);
  assert.equal(run("POST", "/api/orders", "1.0.0", null).passed, true); // off
  assert.equal(run("PATCH", "/api/orders/5", "garbage", "1.613.0").status, 503); // unreadable version: treated as old
});

test("MIN_APP_VERSION set: the current phone saves, reads pass, callers without a version pass, sign-in passes", async () => {
  process.env.MIN_APP_VERSION = SHIPPED;
  assert.equal((await save(SHIPPED)).status, 201);
  assert.equal((await save(null)).status, 201); // the CEO bot / integration API / KAD OS send no X-App-Version
  const read = await apiRequest("/api/settings", { cookie, headers: { "X-App-Version": OLD } });
  assert.equal(read.status, 200);
  const login = await apiRequest("/api/auth/login", { method: "POST", body: { email: manager.email, password: "nope" }, headers: { "X-App-Version": OLD } });
  assert.notEqual(login.status, 426);
});

test("a phone older than the first 426-aware app gets 503 (its queue keeps 5xx work; a 4xx would make it delete the work)", async () => {
  process.env.MIN_APP_VERSION = SHIPPED;
  const res = await save("1.600.0");
  assert.equal(res.status, 503);
  assert.equal(res.data.code, "update_required");
  assert.match(res.data.error, /Update the app/);
});

test("a minimum above the shipped app is capped to it (a typo cannot lock every phone out)", () => {
  assert.deepEqual(minAppVersion({ MIN_APP_VERSION: "99.0.0" }), parseVersion(SHIPPED));
  assert.equal(minAppVersion({ MIN_APP_VERSION: "" }), null);
});
