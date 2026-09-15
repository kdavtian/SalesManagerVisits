// Shared Playwright fixtures for the browser E2E suite. Each worker process
// gets its own pg Pool (this file runs in a separate process from the
// server under test -- Playwright workers can't share the app's own
// src/db/pool.js singleton the way the node:test integration suite's
// helpers.js does), pointed at the same DATABASE_URL the webServer config
// below starts the real app against. Fixtures create real rows directly
// against that database and track them for teardown, the same pattern as
// test/integration/helpers.js -- these are deliberately NOT shared with
// that file (different process model), but mirror its conventions on
// purpose so the two suites read the same way.
import { test as base, expect } from "@playwright/test";
import pg from "pg";
import bcrypt from "bcryptjs";
// Playwright's own test-runner process doesn't load server/.env the way
// the webServer subprocess does (that one gets it via app.js's own
// `import "dotenv/config"`) -- this file constructs its own pg Pool
// directly in the test-runner/worker process, so it needs DATABASE_URL
// loaded here too, independently.
import "dotenv/config";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const TEST_PASSWORD = "E2eTestPass123!";
let cachedHash;
async function testPasswordHash() {
  if (!cachedHash) cachedHash = await bcrypt.hash(TEST_PASSWORD, 10);
  return cachedHash;
}

const CLEANUP_ORDER = [
  "checkin_photos",
  "checkins",
  "pod_records",
  "route_stops",
  "delivery_routes",
  "cash_handoffs",
  "payments",
  "orders",
  "customer_level_audit",
  "customers",
  "products",
  "users",
];

let counter = 0;
function nextId() {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

export class Fixtures {
  constructor() {
    this.created = new Map(CLEANUP_ORDER.map((t) => [t, new Set()]));
  }

  track(table, id) {
    this.created.get(table).add(id);
    return id;
  }

  async createUser(role, overrides = {}) {
    const id = nextId();
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *",
      [overrides.name ?? `E2E ${role}`, overrides.email ?? `e2e-${role}-${id}@kadmotors.local`, await testPasswordHash(), role]
    );
    return this.track("users", rows[0].id), rows[0];
  }

  async createCustomer(overrides = {}) {
    const id = nextId();
    const { rows } = await pool.query(
      `INSERT INTO customers (name, sales_channel, created_by, assigned_manager_id, lat, lng, erp_customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        overrides.name ?? `E2E Customer ${id}`,
        overrides.sales_channel ?? "retail",
        overrides.created_by,
        overrides.assigned_manager_id ?? overrides.created_by,
        overrides.lat ?? 40.18,
        overrides.lng ?? 44.51,
        overrides.erp_customer_id ?? null,
      ]
    );
    return this.track("customers", rows[0].id), rows[0];
  }

  // Real products always carry a brand (see migrations/029_order_code_and_brand.sql) --
  // orderCreate.js's picker navigates brand-first (see its own nav.brand),
  // only falling back to a flat list once a brand is chosen or a search is
  // typed, so a brand-less fixture product would never actually appear in
  // that screen's default (unnavigated, unsearched) view.
  async createProduct(overrides = {}) {
    const id = nextId();
    const { rows } = await pool.query(
      "INSERT INTO products (name, unit, unit_price_amd, brand, active) VALUES ($1, $2, $3, $4, true) RETURNING *",
      [
        overrides.name ?? `E2E Product ${id}`,
        overrides.unit ?? "pcs",
        overrides.unit_price_amd ?? 1000,
        overrides.brand ?? "E2E Brand",
      ]
    );
    return this.track("products", rows[0].id), rows[0];
  }

  // status "pending" + current_holder_id = the collecting rep matches a
  // real just-collected cash payment: approving it directly (payments.js's
  // quick-approve) and handing it off through the custody chain
  // (cashHandoffs.js) are two different things that can both happen to a
  // payment in this state -- which one applies is up to the test.
  async createPayment(overrides = {}) {
    const { rows } = await pool.query(
      `INSERT INTO payments
         (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, sales_channel, status, created_by, current_holder_id)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        overrides.customer_id,
        overrides.customer_name_snapshot ?? "E2E Customer",
        overrides.amount_amd ?? 10000,
        overrides.sales_manager_id,
        overrides.sales_manager_name_snapshot ?? "E2E Rep",
        overrides.sales_channel ?? "retail",
        overrides.status ?? "pending",
        overrides.created_by ?? overrides.sales_manager_id,
        overrides.current_holder_id ?? overrides.sales_manager_id,
      ]
    );
    return this.track("payments", rows[0].id), rows[0];
  }

  // Creates an order in a given status directly (bypassing the real
  // create->submit->confirm lifecycle) -- for specs whose actual subject is
  // a LATER stage (warehouse staging, delivery) that would otherwise need
  // to first drive an unrelated multi-step order lifecycle through the UI
  // just to reach their own starting state. discountPct 0 keeps
  // approval_status "not_required" by default, matching a normal
  // no-discount order.
  async createOrder(overrides = {}) {
    const id = nextId();
    const { rows } = await pool.query(
      `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        overrides.customer_id,
        overrides.user_id,
        overrides.status ?? "confirmed",
        overrides.total_amd ?? 10000,
        overrides.discount_pct ?? 0,
        overrides.discount_amd ?? 0,
        overrides.approval_status ?? "not_required",
        overrides.order_code ?? `E2E-ORD-${id}`,
        overrides.payment_method ?? "cash",
      ]
    );
    const order = rows[0];
    this.track("orders", order.id);
    if (overrides.product) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          order.id,
          overrides.product.id,
          overrides.product.name,
          overrides.product.brand ?? null,
          overrides.product.unit_price_amd,
          overrides.quantity ?? 1,
          overrides.product.unit_price_amd * (overrides.quantity ?? 1),
        ]
      );
    }
    return order;
  }

  // Order/checkin/payment rows created through the UI itself (not directly
  // via SQL) still need tracking for cleanup -- call this with the real id
  // the UI flow surfaced (e.g. read back off the network response, or
  // queried by a distinguishing field the test just set).
  trackRow(table, id) {
    return this.track(table, id);
  }

  async cleanup() {
    for (const table of CLEANUP_ORDER) {
      const ids = this.created.get(table);
      if (!ids.size) continue;
      await pool.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [[...ids]]);
      ids.clear();
    }
  }
}

// Logs a page in through the real login form (not a cookie shortcut) --
// this suite exists to catch UI-integration breakage, and the login form
// itself is one of the flows under test, so every other spec should also
// exercise it rather than bypass it.
export async function loginViaUi(page, email, password = TEST_PASSWORD) {
  await page.goto("/");
  // By field name/role rather than label text -- the app defaults to
  // Armenian (see i18n.js's getLang()) unless a prior visit set English,
  // so an English label-text match would be a language-dependent flake.
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("#top-bar")).toBeVisible({ timeout: 10000 });
}

export const test = base.extend({
  // App defaults to Armenian (i18n.js's getLang()) unless localStorage
  // already says "en" -- forced here, before the app's own first script
  // runs, so every spec's text assertions can be written in English
  // without depending on the app's own language-detection default.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem("fieldvisits_lang", "en");
    });
    await use(page);
  },
  fixtures: async ({}, use) => {
    const f = new Fixtures();
    await use(f);
    await f.cleanup();
  },
});

export { expect, pool };
