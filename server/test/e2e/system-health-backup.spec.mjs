import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Settings > System health > Backups (deploy/backup.sh writes backup_runs, server/src/system/backupStatus.js): the last good
// backup with its off-server copy; red "Too old" after 36 hours, and a failure newer than it is shown.
const SHOTS = process.env.GB_SHOTS ?? "/tmp";

test("System health: the Backups card, green when fresh, red when the last good backup is too old", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await pool.query("DELETE FROM backup_runs");
  await pool.query(
    `INSERT INTO backup_runs (finished_at, ok, db_bytes, uploads_bytes, offsite) VALUES (now() - interval '5 hours', true, 9437184, 64487424, 'spaces,telegram')`
  );
  try {
    await loginViaUi(page, admin.email);
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#/settings?section=system-health");
      await page.reload(); // a new document, so the Armenian language set above applies
      const card = page.locator("#backup-card");
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(card).toContainText("DigitalOcean Spaces, Telegram");
      await expect(card).toContainText("9 MB + 62 MB");
      await expect(card.locator(".badge-success")).toHaveCount(1);
      await card.scrollIntoViewIfNeeded();
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(noOverflow, `no sideways scroll at ${width} px`).toBe(true);
      await card.screenshot({ path: `${SHOTS}/health-backup-ok-${width}.png` });
    }

    // 40 hours without a good backup and a failed run since: red, with the failed step
    await pool.query("UPDATE backup_runs SET finished_at = now() - interval '40 hours'");
    await pool.query("INSERT INTO backup_runs (finished_at, ok, detail) VALUES (now() - interval '16 hours', false, 'off-server copy')");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#/settings?section=system-health");
      await page.reload(); // same URL as before: reload so the screen asks the server again
      const card = page.locator("#backup-card");
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(card.locator(".health-row .badge-danger").first()).toBeVisible();
      await expect(card).toContainText("Պատճենում սերվերից դուրս"); // the failed step, in Armenian
      await card.screenshot({ path: `${SHOTS}/health-backup-stale-${width}.png` });
    }
  } finally {
    await pool.query("DELETE FROM backup_runs");
  }
});
