import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Settings > Notifications offers every kind of notification the person's role can receive, in groups (owner, 2026-10-28: "1A";
// client/public/js/shared/notificationTypes.js): a rep sees no warehouse kinds, the admin sees all four groups, a switch is saved.
async function openSwitches(page) {
  await page.goto("/#/settings?section=p-notifications");
  await page.locator("#notification-prefs-expand-btn").click();
  await expect(page.locator("#notification-prefs-list .settings-list-group-title").first()).toBeVisible({ timeout: 15000 });
}

test("a rep gets the kinds of their role, grouped; a switch is saved", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await openSwitches(page);
  const list = page.locator("#notification-prefs-list");
  await expect(list.locator("#notif-pref-fraud_alert")).toHaveCount(1); // "hand over your cash" reminder
  await expect(list.locator("#notif-pref-cash_handoff_reviewed")).toHaveCount(1);
  await expect(list.locator("#notif-pref-order_warehouse_review")).toHaveCount(0);
  await expect(list.locator("#notif-pref-erp_sync_stale")).toHaveCount(0);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/notif-switches-rep.png`, fullPage: true });
  await list.locator("#notif-pref-cash_handoff_reviewed").click();
  await expect(list.locator("#notif-pref-cash_handoff_reviewed")).toHaveAttribute("aria-checked", "false");
  const { rows } = await pool.query("SELECT enabled FROM notification_settings WHERE scope_type = 'user' AND scope_value = $1 AND notification_type = 'cash_handoff_reviewed'", [String(rep.id)]);
  expect(rows[0]?.enabled).toBe(false);
  await pool.query("DELETE FROM notification_settings WHERE scope_type = 'user' AND scope_value = $1", [String(rep.id)]);
});

test("the admin sees every kind in four groups", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await openSwitches(page);
  await expect(page.locator("#notification-prefs-list .settings-list-group-title")).toHaveCount(4);
  await expect(page.locator("#notification-prefs-list [id^='notif-pref-']:not([id^='notif-pref-reset-'])")).toHaveCount(32);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/notif-switches-admin.png`, fullPage: true });
});
