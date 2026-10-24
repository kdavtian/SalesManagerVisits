import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: the admin Home shows "Excel sync: last sync, file date (age)" in red when the Excel file behind the sync is old; System health
// has the card with a "Sync now" button that asks the bot (here played by SQL updates) to push the workbook again.
test("admin sees the Excel sync line and Sync now waits for the bot's answer", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const FILE = `e2e-sync-${Date.now()}.xlsx`;
  const fileDate = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  await pool.query("INSERT INTO erp_sync_runs (counts, workbook_modified_at, workbook_name) VALUES ('{}', $1, $2)", [fileDate, FILE]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, admin.email);
    await page.goto("/#/dashboard");
    const line = page.locator(".es-home");
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toHaveClass(/es-home-bad/);
    await expect(line).toContainText("4 days old");
    expect(await line.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(43);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/es-home.png` });

    await line.click();
    const card = page.locator("#erp-sync-card");
    await expect(card).toContainText("Excel file from", { timeout: 15000 });
    await expect(card).toContainText("4 days old");
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/es-card.png` });

    await card.locator("#es-sync-now").click();
    await expect(card.locator("#es-state")).toContainText("Waiting for the bot");
    const { rows } = await pool.query("SELECT id FROM erp_sync_requests WHERE requested_by = $1", [admin.id]);
    expect(rows.length).toBe(1);
    // the bot picks it up, syncs and reports
    await pool.query("UPDATE erp_sync_requests SET picked_at = now() WHERE id = $1", [rows[0].id]);
    await expect(card.locator("#es-state")).toContainText("The bot is syncing", { timeout: 10000 });
    await pool.query("UPDATE erp_sync_requests SET finished_at = now(), ok = true, message = 'Pushed 231 customer records.' WHERE id = $1", [rows[0].id]);
    await expect(card).toContainText("Pushed 231 customer records.", { timeout: 10000 });
    await expect(card.locator("#es-sync-now")).toBeEnabled();
  } finally {
    await pool.query("DELETE FROM erp_sync_runs WHERE workbook_name = $1", [FILE]);
    await pool.query("DELETE FROM erp_sync_requests WHERE requested_by = $1", [admin.id]);
  }
});
