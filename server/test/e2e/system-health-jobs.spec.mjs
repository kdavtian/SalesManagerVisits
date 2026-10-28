import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Settings > System health lists every background job (server/src/jobs/, docs/architecture-roadmap.md step 4): when it last ran and
// whether it worked; a failed one opens its error.
test("System health: the background jobs card, a failed job shows its error", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  await pool.query(
    `INSERT INTO background_jobs (name, every_seconds, next_run_at, last_started_at, last_finished_at, last_ok, last_error, runs, failures)
     VALUES ('anti-fraud', 3600, now() + interval '1 hour', now() - interval '2 minutes', now() - interval '2 minutes', false, 'e2e: database timeout', 3, 1)
     ON CONFLICT (name) DO UPDATE SET last_finished_at = EXCLUDED.last_finished_at, last_ok = false, last_error = EXCLUDED.last_error, failures = 1`
  );
  await pool.query(
    `INSERT INTO background_jobs (name, every_seconds, next_run_at, last_finished_at, last_ok, runs)
     VALUES ('cash-sheets', 1800, now() + interval '30 minutes', now() - interval '5 minutes', true, 4)
     ON CONFLICT (name) DO UPDATE SET last_finished_at = EXCLUDED.last_finished_at, last_ok = true, last_error = NULL`
  );
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings?section=system-health");
    const card = page.locator(".health-card", { hasText: /Background jobs|Ֆոնային աշխատանքներ/ });
    await expect(card).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/health-jobs-phone.png`, fullPage: true });
    const failed = card.locator('[data-job="anti-fraud"]');
    await expect(failed).toBeVisible();
    expect((await failed.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await failed.click();
    await expect(page.locator(".info-popup")).toContainText("e2e: database timeout");
    await page.locator('.info-popup [data-action="close"]').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/health-jobs-desk.png`, fullPage: true });
  } finally {
    await pool.query("UPDATE background_jobs SET last_ok = NULL, last_error = NULL, last_finished_at = NULL, failures = 0 WHERE name IN ('anti-fraud', 'cash-sheets')");
  }
});
