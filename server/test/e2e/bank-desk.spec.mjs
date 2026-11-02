import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Payments redesign, release 2 (owner, 2026-11-02): Bank & cash desks. The accountant uploads a statement from the new screen: the line
// with the customer's TIN is recorded by itself, the unknown payer waits in "To check" and is given to a customer in two taps; typing the
// same payment again is refused until "separate payment"; admin adds a cash desk with its holder. Plus: Armenian at 320 px never
// overflows. Works on its own bank account and customers, removed after.
const SHOTS = process.env.BD_SHOTS;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
const yerevanToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yerevan" }).format(new Date());
const dmy = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

async function cleanup(accountId, customerIds, deskNames) {
  await pool.query("DELETE FROM customer_payments WHERE customer_id = ANY($1)", [customerIds]);
  await pool.query("DELETE FROM bank_payers WHERE customer_id = ANY($1)", [customerIds]);
  if (accountId) {
    await pool.query("DELETE FROM bank_statement_lines WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM bank_imports WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [accountId]);
  }
  await pool.query("DELETE FROM cash_accounts WHERE name = ANY($1)", [deskNames]);
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("@smoke @iphone statement from Bank & cash desks: TIN recorded, unknown payer given to a customer, no double typing, admin adds a desk", async ({ page, fixtures, browser }) => {
    test.setTimeout(120000); // a long flow with two people; under a loaded CI machine it needs more than the default 30 s
    const stamp = Date.now();
    const tin = `8${String(stamp).slice(-7)}`;
    const accountant = await fixtures.createUser("accountant");
    const admin = await fixtures.createUser("admin");
    const shopA = await fixtures.createCustomer({ created_by: admin.id, name: `E2E Tin Shop ${stamp}` });
    const shopB = await fixtures.createCustomer({ created_by: admin.id, name: `E2E Picked Shop ${stamp}` });
    await pool.query("UPDATE customers SET tin = $2 WHERE id = $1", [shopA.id, tin]);
    const accName = `E2E Bank ${stamp}`;
    const deskName = `E2E Desk ${stamp}`;
    const { rows: [acc] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [accName]);
    const today = yerevanToday();
    try {
      await loginViaUi(page, accountant.email);
      await page.goto("/#/money");
      await page.locator("#money-bank").click({ timeout: 15000 });
      await expect(page.locator(".bd-view h1")).toContainText("Bank & cash desks");
      // the statement, from this screen
      await page.locator("#bd-upload").click();
      await page.locator("#bk-account").selectOption({ label: accName });
      const csv = ["Date;Payer;Description;Debit;Credit", `${dmy(today)};Some Firm;Oil, TIN ${tin};;50 000,00`, `${dmy(today)};Stranger ${stamp};payment;;20 000,00`].join("\n");
      await page.locator("#bk-file").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await page.locator("#bk-do-import").click({ timeout: 10000 });
      await expect(page.locator("#bk-preview")).toContainText("Customer payments: 1 recorded", { timeout: 10000 });
      await shot(page, "bd-1-import");
      await page.locator("#bk-close").click();
      // To check: the stranger
      const line = page.locator(".bd-line", { hasText: `Stranger ${stamp}` });
      await expect(line).toContainText("Unknown payer", { timeout: 10000 });
      await shot(page, "bd-2-todo");
      await line.locator('[data-act="customer"]').click();
      await page.locator("#bd-cust-q").fill(`E2E Picked Shop ${stamp}`);
      await page.locator(".bd-cust", { hasText: `E2E Picked Shop ${stamp}` }).click({ timeout: 10000 });
      await expect(page.locator("#bd-remember")).toBeChecked();
      await shot(page, "bd-3-choose");
      await page.locator("#bd-ok").click();
      await expect(page.locator(".bd-line", { hasText: `Stranger ${stamp}` })).toHaveCount(0, { timeout: 10000 });
      // Bank: both payments, how each customer was found
      await page.locator('#bd-tabs [data-tab="bank"]').click();
      await expect(page.locator(".bd-pay", { hasText: `E2E Tin Shop ${stamp}` })).toContainText("found by TIN", { timeout: 10000 });
      await expect(page.locator(".bd-pay", { hasText: `E2E Picked Shop ${stamp}` })).toContainText("chosen by hand");
      await shot(page, "bd-4-bank");
      await page.locator(".bd-pay", { hasText: `E2E Tin Shop ${stamp}` }).click();
      await expect(page.locator(".bd-events")).toContainText("Recorded from the statement", { timeout: 10000 });
      await shot(page, "bd-5-detail");
      await page.locator("#bd-x").click();
      // typing the 50,000 again: refused, then recorded as a separate payment
      await page.locator("#bd-add").click();
      await page.locator("#bd-pick").click();
      await page.locator("#bd-cust-q").fill(`E2E Tin Shop ${stamp}`);
      await page.locator(".bd-cust", { hasText: `E2E Tin Shop ${stamp}` }).click({ timeout: 10000 });
      await page.locator("#bd-amount").fill("50000");
      await expect(page.locator("#bd-amount")).toHaveValue("50,000");
      await page.locator("#bd-account").selectOption({ label: accName });
      await page.locator("#bd-ok").click();
      await expect(page.locator("#bd-dups")).toContainText("Looks already recorded", { timeout: 10000 });
      await shot(page, "bd-6-duplicate");
      await page.locator("#bd-separate").click();
      await expect(page.locator(".bd-pay", { hasText: `E2E Tin Shop ${stamp}` })).toHaveCount(2, { timeout: 10000 });
      const { rows: count } = await pool.query("SELECT count(*)::int AS n FROM customer_payments WHERE customer_id = $1", [shopA.id]);
      expect(count[0].n).toBe(2);
      // the accountant sees the desks but cannot add one
      await page.locator('#bd-tabs [data-tab="desks"]').click();
      await expect(page.locator("#bd-new-desk")).toHaveCount(0);

      // admin adds a desk with the accountant as its holder
      const ctx = await browser.newContext({
        baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3101"}`,
        extraHTTPHeaders: { "x-e2e-rate-limit-bypass": process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass" },
        viewport: { width: 390, height: 844 },
      });
      const ap = await ctx.newPage();
      await ap.addInitScript(() => localStorage.setItem("fieldvisits_lang", "en"));
      await loginViaUi(ap, admin.email);
      await ap.goto("/#/bank-desk?tab=desks");
      await ap.locator("#bd-new-desk").click({ timeout: 15000 });
      await ap.locator("#bd-desk-name").fill(deskName);
      await ap.locator("#bd-people-q").fill(accountant.name);
      await ap.locator(`[data-person="${accountant.id}"]`).check();
      await shot(ap, "bd-7-desk-edit");
      await ap.locator("#bd-ok").click();
      await expect(ap.locator(".bd-desk", { hasText: deskName })).toContainText(accountant.name, { timeout: 10000 });
      await shot(ap, "bd-8-desks");
      await ctx.close();
    } finally {
      await cleanup(acc.id, [shopA.id, shopB.id], [deskName]);
    }
  });
});

test.describe("narrow Armenian", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test("@smoke Armenian at 320 px: every tab and the payment sheet fit the screen", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await loginViaUi(page, admin.email);
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    for (const tab of ["todo", "bank", "desks"]) {
      await page.goto(`/#/bank-desk${tab === "todo" ? "" : `?tab=${tab}`}`);
      await expect(page.locator(".bd-view h1")).toContainText("Բանկ", { timeout: 15000 });
      await expect(page.locator("#bd-body .loading-state")).toHaveCount(0, { timeout: 10000 });
      expect(await fits(), tab).toBe(true);
      await shot(page, `bd-hy-${tab}`);
    }
    await page.locator("#bd-add").click();
    await expect(page.locator(".bd-sheet h2")).toBeVisible();
    expect(await fits()).toBe(true);
    await shot(page, "bd-hy-add");
  });
});
