import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-23: the Cashflow module (the Excel Cashflow sheet in the app). The ledger is shared, so this file runs in one worker and
// snapshots / restores the real tables like the integration test does.
test.use({ viewport: { width: 440, height: 956 } });
test.describe.configure({ mode: "serial" });
const SHOTS = process.env.CF_SHOTS;

let snap;
test.beforeAll(async () => {
  snap = {
    entries: (await pool.query("SELECT * FROM cash_entries")).rows,
    accounts: (await pool.query("SELECT id FROM cash_accounts")).rows.map((r) => r.id),
    categories: (await pool.query("SELECT id FROM cash_categories")).rows.map((r) => r.id),
  };
  await pool.query("DELETE FROM cash_entries");
  const today = new Date().toISOString().slice(0, 10);
  const { rows: [box] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ('Cash E2E', 'cash') RETURNING id");
  const { rows: [bank] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ('EvocaBank E2E', 'bank') RETURNING id");
  const cat = async (name) => (await pool.query("SELECT id FROM cash_categories WHERE name = $1", [name])).rows[0].id;
  const add = (amount, c, acc, info, cur = "AMD", rate = null) =>
    pool.query(
      "INSERT INTO cash_entries (entry_date, amount, currency, fx_rate, amount_amd, category_id, account_id, info, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'excel')",
      [today, amount, cur, rate, cur === "USD" ? amount * rate : amount, c, acc, info]
    );
  await add(1500000, await cat("Oil order"), box.id, "Garage Masters Mall payment");
  await add(-300000, await cat("Fuel"), box.id, "70KK770 fuel");
  await add(-1000000, await cat("To bank"), box.id, "to the bank");
  await add(1000000, await cat("To bank"), bank.id, "from the cash box");
  await add(2000, await cat("Investment"), bank.id, "usd in", "USD", 380);
});
test.afterAll(async () => {
  await pool.query("DELETE FROM cash_entries");
  if (snap.entries.length) await pool.query("INSERT INTO cash_entries SELECT * FROM jsonb_populate_recordset(NULL::cash_entries, $1::jsonb)", [JSON.stringify(snap.entries)]);
  await pool.query("DELETE FROM cash_accounts WHERE NOT (id = ANY($1))", [snap.accounts]);
});

test("accountant: balances, money in / out without the internal move, categories, search", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  await loginViaUi(page, acc.email);
  await page.goto("/#/cashflow");
  await expect(page.locator(".cf-sum")).toBeVisible({ timeout: 15000 });
  // in = customer payment + usd investment (760,000); out = fuel; the to-bank move is internal
  await expect(page.locator(".cf-sum .cf-in").first()).toHaveText("2,260,000");
  await expect(page.locator(".cf-sum .cf-out").first()).toHaveText("300,000");
  await expect(page.locator(".cf-account", { hasText: "Cash E2E" })).toContainText("200,000");
  await expect(page.locator(".cf-account", { hasText: "EvocaBank E2E" })).toContainText("$2,000");
  await expect(page.locator(".cf-row")).toHaveCount(5);
  await expect(page.locator(".cf-row", { hasText: "Garage Masters Mall payment" })).toContainText("+1,500,000");
  await expect(page.locator(".cf-row", { hasText: "To bank" }).first()).toContainText(/internal/i);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cf-top.png` });
  // search by plate
  await page.locator("#cf-q").fill("70KK");
  await expect(page.locator(".cf-row")).toHaveCount(1);
  await page.locator("#cf-q").fill("");
  await expect(page.locator(".cf-row")).toHaveCount(5);
  // tap an account card: filter to it
  await page.locator(".cf-account", { hasText: "EvocaBank E2E" }).click();
  await expect(page.locator(".cf-row")).toHaveCount(2);
  await page.locator(".cf-account", { hasText: "EvocaBank E2E" }).click();
  await expect(page.locator(".cf-row")).toHaveCount(5);
  // tap a category: filter to it
  await page.locator('.cf-cat', { hasText: "Fuel" }).click();
  await expect(page.locator(".cf-row")).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // period buttons: last month has nothing
  await page.locator(".cf-cat-active").click().catch(() => {});
  await page.locator('[data-base="all"]').click();
  await expect(page.locator(".cf-row")).toHaveCount(5);
});

test("sales roles cannot open it; the Home tile is for the owner's roles", async ({ page, fixtures }) => {
  const dir = await fixtures.createUser("sales_director");
  await loginViaUi(page, dir.email);
  await expect(page.locator("#qa-cashflow")).toHaveCount(0);
  const res = await page.evaluate(async () => (await fetch("/api/cashflow/meta", { credentials: "same-origin" })).status);
  expect(res).toBe(403);
  const ceo = await fixtures.createUser("ceo");
  await page.context().clearCookies();
  await loginViaUi(page, ceo.email);
  await page.locator("#qa-cashflow").click();
  await expect(page.locator(".cf-sum")).toBeVisible({ timeout: 15000 });
  expect(new URL(page.url()).hash).toBe("#/cashflow");
});
