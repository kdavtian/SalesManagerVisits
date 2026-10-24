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

test("accountant adds, edits and deletes an entry in the app; Excel rows are not tappable; a salary note is composed from the Staff person", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const { rows: [boss] } = await pool.query("INSERT INTO staff_members (name, position, kind) VALUES ('E2E Cash Anna', 'E2E SM Cash', 'rep') RETURNING id");
  try {
    await loginViaUi(page, acc.email);
    await page.goto("/#/cashflow");
    await expect(page.locator(".cf-sum")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("button.cf-row-edit")).toHaveCount(0); // everything here came from Excel
    await page.locator("#cf-add").click();
    await expect(page.locator("#cf-form")).toBeVisible();
    await page.locator('#cf-form [name="account_id"]').selectOption({ label: "Cash E2E" });
    await page.locator('#cf-form [name="category_id"]').selectOption({ label: "Salary" });
    await expect(page.locator("#cf-salary")).toBeVisible();
    await page.locator('#cf-form [name="staff"]').selectOption({ label: "E2E Cash Anna · E2E SM Cash" });
    await page.locator('#cf-form [name="month"]').fill("2026-10");
    await page.locator('#cf-form [name="month"]').dispatchEvent("change");
    await expect(page.locator('#cf-form [name="info"]')).toHaveValue("E2E SM Cash 2026 OCT");
    await page.locator('#cf-form [name="amount"]').fill("150000");
    if (SHOTS) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/cf-form.png` });
      await page.locator("#cf-form").evaluate((el) => el.closest(".sheet").scrollTo(0, 99999));
      await page.screenshot({ path: `${SHOTS}/cf-form-bottom.png` });
      await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "hy"));
      await page.goto("/#/dashboard");
      await page.goto("/#/cashflow");
      await page.locator("#cf-add").click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/cf-form-hy.png` });
      await page.locator("#cf-cancel").click();
      await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "en"));
      await page.goto("/#/dashboard");
      await page.goto("/#/cashflow");
      await page.locator("#cf-add").click();
      await page.locator('#cf-form [name="account_id"]').selectOption({ label: "Cash E2E" });
      await page.locator('#cf-form [name="category_id"]').selectOption({ label: "Salary" });
      await page.locator('#cf-form [name="staff"]').selectOption({ label: "E2E Cash Anna · E2E SM Cash" });
      await page.locator('#cf-form [name="month"]').fill("2026-10");
      await page.locator('#cf-form [name="month"]').dispatchEvent("change");
      await page.locator('#cf-form [name="amount"]').fill("150000");
    }
    await page.locator('#cf-form button[type="submit"]').click();
    const row = page.locator("button.cf-row-edit", { hasText: "E2E SM Cash 2026 OCT" });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText("−150,000");
    const { rows: [e] } = await pool.query("SELECT amount::float8 AS a, origin FROM cash_entries WHERE info = 'E2E SM Cash 2026 OCT'");
    expect(e).toEqual({ a: -150000, origin: "manual" });

    // edit: flip it to money in, 90,000
    await row.click();
    await page.locator('#cf-dir [data-dir="in"]').click();
    await page.locator('#cf-form [name="amount"]').fill("90000");
    await page.locator('#cf-form button[type="submit"]').click();
    await expect(page.locator("button.cf-row-edit", { hasText: "E2E SM Cash 2026 OCT" })).toContainText("+90,000");

    // delete (second tap confirms)
    await page.locator("button.cf-row-edit", { hasText: "E2E SM Cash 2026 OCT" }).click();
    await page.locator("#cf-del").click();
    await page.locator("#cf-del").click();
    await expect(page.locator("button.cf-row-edit")).toHaveCount(0, { timeout: 10000 });
  } finally {
    await pool.query("DELETE FROM cash_entries WHERE info = 'E2E SM Cash 2026 OCT'");
    await pool.query("DELETE FROM staff_members WHERE id = $1", [boss.id]);
  }
});

// 2026-10-24 audit: a role that may not see Cashflow (rep, sales director) used to get an empty page with an error when it typed or followed the address.
test("a sales manager and a sales director who open the Cashflow address land on Home", async ({ page, fixtures }) => {
  for (const role of ["sales_manager", "sales_director"]) {
    const u = await fixtures.createUser(role);
    await page.context().clearCookies();
    await loginViaUi(page, u.email);
    await page.goto("/#/cashflow");
    await expect(page).toHaveURL(/#\/dashboard/, { timeout: 10000 });
    await expect(page.locator(".cf-view")).toHaveCount(0);
  }
});
