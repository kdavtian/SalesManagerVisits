import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Improvement plan 0.5 / 0.9 (owner, 2026-11-28). System health: a sync refused for a big drop shows its reason and, for admin / CEO, the
// "Accept the next sync" button; after the tap the card says until when the next syncs are accepted. Cashflow: dollar rows of the Excel sheet
// with no rate show one red line with the count and the Excel rows. The bot is played by SQL.
const SHOTS = process.env.GB_SHOTS;

async function shots(page, name, paint) {
  if (!SHOTS) return;
  for (const lang of ["hy", "en"]) {
    for (const width of [390, 320]) {
      // init scripts run in the order added: this one wins over the fixture's English one on every reload
      await page.addInitScript((l) => localStorage.setItem("fieldvisits_lang", l), lang);
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      await paint();
      await page.screenshot({ path: `${SHOTS}/${name}-${lang}-${width}.png` });
    }
  }
  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "en"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
}

test("System health: a big-drop refusal shows the reason; admin accepts the next sync", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const FILE = `e2e-guard-${Date.now()}.xlsx`;
  await pool.query("INSERT INTO erp_sync_runs (counts, workbook_modified_at, workbook_name, at) VALUES ('{\"customers\": 412}', now(), $1, now() - interval '1 hour')", [FILE]);
  await pool.query(
    "UPDATE app_settings SET erp_sync_refused_at = now(), erp_sync_refused_reason = 'Big drop against the last good sync, nothing was changed: customers: 412 → 0 (−100%)', erp_sync_accept_until = NULL WHERE id = 1"
  );
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings?section=system-health");
    const card = page.locator("#erp-sync-card");
    await expect(card).toContainText("Sync refused: big drop.", { timeout: 15000 });
    const btn = card.locator("#es-accept");
    await expect(btn).toBeVisible();
    expect(await btn.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(43);
    await shots(page, "guard-refused", async () => {
      await page.locator("#es-accept").scrollIntoViewIfNeeded({ timeout: 15000 });
    });

    page.once("dialog", (d) => d.accept());
    await card.locator("#es-accept").click();
    await expect(card.locator(".es-accepted")).toContainText("The next syncs are accepted until", { timeout: 10000 });
    await expect(card.locator("#es-accept")).toHaveCount(0);
    const { rows } = await pool.query("SELECT erp_sync_accept_until > now() AS open, erp_sync_accept_by FROM app_settings WHERE id = 1");
    expect(rows[0].open).toBe(true);
    expect(rows[0].erp_sync_accept_by).toBe(admin.id);
    await shots(page, "guard-accepted", async () => {
      await page.locator("#erp-sync-card .es-accepted").scrollIntoViewIfNeeded({ timeout: 15000 });
    });
  } finally {
    await pool.query("UPDATE app_settings SET erp_sync_refused_at = NULL, erp_sync_refused_reason = NULL, erp_sync_accept_until = NULL, erp_sync_accept_by = NULL WHERE id = 1");
    await pool.query("DELETE FROM erp_sync_runs WHERE workbook_name = $1", [FILE]);
  }
});

test("Cashflow: dollar rows without a rate show one red line with the Excel rows", async ({ page, fixtures }) => {
  const acc = await fixtures.createUser("accountant");
  const INFO = `e2e-no-rate-${Date.now()}`;
  const { rows: [account] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`USD ${INFO}`]);
  await pool.query(
    "INSERT INTO cash_entries (entry_date, amount, currency, fx_rate, amount_amd, account_id, info, origin, excel_row, fx_missing) VALUES ('2020-01-02', 100, 'USD', NULL, 0, $1, $2, 'excel', 1234, true)",
    [account.id, INFO]
  );
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, acc.email);
    await page.goto("/#/cashflow");
    const line = page.locator("#cf-no-rate");
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toContainText("Dollar rows with no rate in the Excel Cashflow sheet: 1.");
    await expect(line).toContainText("1234");
    await shots(page, "cf-no-rate", async () => {
      await page.locator("#cf-no-rate").scrollIntoViewIfNeeded({ timeout: 15000 });
    });
  } finally {
    await pool.query("DELETE FROM cash_entries WHERE info = $1", [INFO]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [account.id]);
  }
});
