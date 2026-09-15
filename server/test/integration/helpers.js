// Shared harness for the integration suite: boots the real Express app
// (src/app.js) on an ephemeral port against whatever DATABASE_URL points
// at (server/.env -> fieldvisits_test in this repo's dev setup -- NEVER
// point this at a database with real data, since fixtures are created and
// deleted directly against it), and gives each test file a small toolkit
// for creating/cleaning up its own fixtures rather than depending on
// anything already in the database.
import { app } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import bcrypt from "bcryptjs";

let server;
let baseUrl;

export async function startTestServer() {
  if (server) return baseUrl;
  await new Promise((resolve, reject) => {
    server = app.listen(0, (err) => (err ? reject(err) : resolve()));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function stopTestServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
}

// Every fixture this run creates gets tracked here (table -> Set of ids) so
// a single cleanupAll() at the end of a test file can tear all of it back
// down, in dependency order, regardless of which test created what.
const CLEANUP_ORDER = [
  "checkin_photos",
  "checkins",
  "pod_records",
  "route_stops",
  "delivery_routes",
  // cash_handoffs cascades to cash_handoff_items, which RESTRICTs deleting
  // a referenced payment -- must go before "payments" below.
  "cash_handoffs",
  "payments",
  "orders",
  "customer_level_audit",
  "customers",
  "products",
  "users",
];
const created = new Map(CLEANUP_ORDER.map((t) => [t, new Set()]));

function track(table, id) {
  created.get(table).add(id);
  return id;
}

export async function cleanupAll() {
  for (const table of CLEANUP_ORDER) {
    const ids = created.get(table);
    if (!ids.size) continue;
    await pool.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [[...ids]]);
    ids.clear();
  }
}

// Bcrypt hashing is intentionally slow -- hashing this once per test file
// instead of once per created user keeps the suite fast without weakening
// what's actually under test (every fixture user still goes through the
// real login endpoint, which still does a real bcrypt.compare).
export const TEST_PASSWORD = "TestPass123!";
let cachedHash;
async function testPasswordHash() {
  if (!cachedHash) cachedHash = await bcrypt.hash(TEST_PASSWORD, 10);
  return cachedHash;
}

let userCounter = 0;
export async function createUser(role, overrides = {}) {
  userCounter += 1;
  const email = overrides.email ?? `itest-${role}-${Date.now()}-${userCounter}@kadmotors.local`;
  const { rows } = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *",
    [overrides.name ?? `Integration Test ${role}`, email, await testPasswordHash(), role]
  );
  track("users", rows[0].id);
  return rows[0];
}

let customerCounter = 0;
export async function createCustomer(overrides = {}) {
  customerCounter += 1;
  const { rows } = await pool.query(
    `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng, erp_customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      overrides.name ?? `Integration Test Customer ${customerCounter}`,
      overrides.sales_channel ?? "retail",
      overrides.created_by,
      overrides.assigned_manager_id ?? overrides.created_by,
      overrides.lat ?? 40.18,
      overrides.lng ?? 44.51,
      overrides.erp_customer_id ?? null,
    ]
  );
  track("customers", rows[0].id);
  return rows[0];
}

let productCounter = 0;
export async function createProduct(overrides = {}) {
  productCounter += 1;
  const { rows } = await pool.query(
    "INSERT INTO products (name, unit, unit_price_amd, active) VALUES ($1, $2, $3, true) RETURNING *",
    [overrides.name ?? `Integration Test Product ${productCounter}`, overrides.unit ?? "pcs", overrides.unit_price_amd ?? 1000]
  );
  track("products", rows[0].id);
  return rows[0];
}

export function trackCustomer(id) {
  return track("customers", id);
}
export function trackProduct(id) {
  return track("products", id);
}
export function trackOrder(id) {
  return track("orders", id);
}
export function trackCheckin(id) {
  return track("checkins", id);
}
export function trackPayment(id) {
  return track("payments", id);
}
export function trackHandoff(id) {
  return track("cash_handoffs", id);
}

// Thin fetch wrapper: resolves against the running test server, sends/
// receives JSON, and carries a session cookie string across calls so a
// test can act as one logged-in user across several requests. Since
// issueSession() sets both the session cookie and the CSRF double-submit
// cookie (see server/src/middleware/csrf.js) together, `cookie` here
// carries both, semicolon-joined -- and any mutating call auto-attaches
// the matching X-CSRF-Token header pulled out of that same string, the
// same way api.js's doRequest does for the real app.
export async function apiRequest(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const csrfMatch = cookie?.match(/(?:^|; )csrf_token=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrfToken && method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookies = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  const newCookie = setCookies.length ? setCookies.map((c) => c.split(";")[0]).join("; ") : cookie;
  return { status: res.status, data, cookie: newCookie };
}

// Multipart counterpart to apiRequest(), for the one route (POST
// /api/checkins) that accepts file uploads via multer -- a JSON body can't
// carry files, so this sends a real FormData body instead, attaching the
// CSRF header by hand the same way apiRequest() does internally.
export async function apiFormRequest(path, { method = "POST", form, cookie, headers = {} } = {}) {
  const csrfMatch = cookie?.match(/(?:^|; )csrf_token=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...headers,
    },
    body: form,
    redirect: "manual",
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
}

export async function loginAs(email, password = TEST_PASSWORD) {
  const res = await apiRequest("/api/auth/login", { method: "POST", body: { email, password } });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.data)}`);
  return res.cookie;
}
