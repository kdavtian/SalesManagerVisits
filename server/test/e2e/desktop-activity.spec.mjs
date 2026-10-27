import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 2: Activity on the desktop table engine -- columns, the Status / Result filter bar with chips,
// CSV export, and (>= 1400 px) a visit docked beside the list.
test("desktop Activity: columns, filter chips, docked visit, export", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager", { name: "Desk Visit Rep" });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const c1 = await fixtures.createCustomer({ name: `DeskAct${stamp} Alpha`, created_by: admin.id, assigned_manager_id: rep.id });
  const c2 = await fixtures.createCustomer({ name: `DeskAct${stamp} Beta`, created_by: admin.id, assigned_manager_id: rep.id });
  const ins = async (customerId, outcomes, amount) =>
    (await pool.query(
      "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, amount_collected_amd, ended_at) VALUES ($1, $2, 40.18, 44.51, 4, true, $3, $4, now() + interval '25 minutes') RETURNING id",
      [customerId, rep.id, outcomes, amount]
    )).rows[0].id;
  const v1 = await ins(c1.id, ["payment_collected"], 32000);
  const v2 = await ins(c2.id, ["assortment_check"], null);
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/activity");
    await page.locator("#activity-search").fill(`DeskAct${stamp}`);
    const rows = page.locator("#activity-list > .list-row");
    await expect(rows).toHaveCount(2, { timeout: 15000 });
    const head = page.locator(".desk-thead-activity");
    await expect(head).toBeVisible();
    const row1 = page.locator(`#activity-list > .list-row[data-checkin-id="${v1}"]`);
    await expect(row1.locator(".desk-cell-rep")).toHaveText("Desk Visit Rep");
    await expect(row1.locator(".desk-cell-collected")).toContainText("32,000");
    await expect(row1.locator(".desk-cell-status")).toHaveText("Verified");
    await expect(page.locator("#activity-desk-foot .desk-foot-count")).toContainText("2");

    // duration column from the picker (ended_at - timestamp)
    await head.locator(".desk-col-gear").click();
    await page.locator('.desk-col-menu input[data-col="duration"]').check();
    await page.keyboard.press("Escape");
    await expect(row1.locator(".desk-cell-duration")).toContainText("25");

    // Result filter narrows to one row and shows a chip; Clear restores
    const bar = page.locator("#activity-desk-filters");
    await bar.locator('[data-desk-filter="outcome"]').click();
    await page.locator('.desk-pick-menu [data-value="payment_collected"]').click();
    await expect(rows).toHaveCount(1);
    await expect(bar.locator(".desk-chip")).toContainText("Payment collected");
    await bar.locator("[data-desk-clear]").click();
    await expect(rows).toHaveCount(2);

    // a row opens the visit docked beside the list
    await row1.click();
    const panel = page.locator(".sheet-overlay.sheet-docked > .visit-detail-sheet");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`DeskAct${stamp} Alpha`);
    await expect(row1).toHaveClass(/row-open/);
    await expect(row1.locator(".desk-cell-rep")).toHaveCount(0); // narrow columns only beside the panel
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-activity.png` });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#activity-desk-foot [data-desk-export]").click()]);
    expect(download.suggestedFilename()).toMatch(/^visits-/);
    const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
    expect(csv).toContain(`DeskAct${stamp} Beta`);
    expect(v2).toBeTruthy();
  } finally {
    await pool.query("DELETE FROM checkins WHERE id = ANY($1)", [[v1, v2]]);
  }
});
