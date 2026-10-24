import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24 (Cashflow phase 3): the accountant uploads a bank statement; lines the ledger already has are "matched", the rest is added or ignored.
// Works on its own account with manual rows, so the real ledger and a parallel Excel refresh are never touched.
test.use({ viewport: { width: 390, height: 844 } });

test("accountant uploads a statement: matched lines, add one to Cashflow, ignore one", async ({ page, fixtures }) => {
  const accountant = await fixtures.createUser("accountant");
  const stamp = Date.now();
  const accName = `E2E Bank ${stamp}`;
  const { rows: [acc] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [accName]);
  const { rows: [cat] } = await pool.query("SELECT id FROM cash_categories WHERE name = 'Fuel'");
  await pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, account_id, category_id, origin) VALUES ('2026-10-02', 150000, 150000, $1, $2, 'manual')", [acc.id, cat.id]);
  try {
    await loginViaUi(page, accountant.email);
    await page.goto("/#/cashflow");
    await page.locator("#cf-bank").click({ timeout: 15000 });
    await page.locator("#bk-account").selectOption({ label: accName });
    const csv = ["Date;Description;Debit;Credit", "01.10.2026;Customer payment;;150 000,00", "03.10.2026;Bank fee;500,00;", "04.10.2026;Card fee;300,00;"].join("\n");
    await page.locator("#bk-file").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator("#bk-preview")).toContainText("3", { timeout: 10000 });
    await page.screenshot({ path: `${process.env.BK_SHOTS ?? "/tmp"}/bk-preview.png` });
    await page.locator("#bk-do-import").click();
    await expect(page.locator(".bk-result")).toContainText("2", { timeout: 10000 }); // 2 to check
    // "To check": the two fees
    await expect(page.locator("#bk-list .bk-line")).toHaveCount(2);
    await page.screenshot({ path: `${process.env.BK_SHOTS ?? "/tmp"}/bk-check.png` });
    // add the bank fee to Cashflow (category Fuel is fine for the test), ignore the card fee
    await page.locator("#bk-list .bk-line", { hasText: "Bank fee" }).locator('[data-act="add"]').click();
    await page.locator("#bk-list .bk-extra [name=category_id]").selectOption(String(cat.id));
    await page.locator('#bk-list [data-x="save"]').click();
    await expect(page.locator("#bk-list .bk-line")).toHaveCount(1, { timeout: 10000 });
    await page.locator("#bk-list .bk-line").locator('[data-act="ignore"]').click();
    await expect(page.locator("#bk-list")).toContainText("Nothing to check", { timeout: 10000 });
    await page.locator('#bk-tabs [data-tab="matched"]').click();
    await expect(page.locator("#bk-list")).toContainText("Customer payment");
    await page.locator('#bk-tabs [data-tab="done"]').click();
    await expect(page.locator("#bk-list .bk-line")).toHaveCount(2);
    // the same file again adds nothing
    await page.locator("#bk-import summary").click();
    await page.locator("#bk-file").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator("#bk-preview")).toContainText("3 already imported", { timeout: 10000 });
    // the ledger row the bank confirmed carries the mark
    await page.locator("#bk-close").click();
    await page.locator("#cf-account").selectOption(String(acc.id));
    await expect(page.locator(".cf-row", { hasText: "Fuel" }).first()).toContainText("bank", { timeout: 10000 });
  } finally {
    await pool.query("DELETE FROM cash_entries WHERE account_id = $1", [acc.id]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [acc.id]);
  }
});
