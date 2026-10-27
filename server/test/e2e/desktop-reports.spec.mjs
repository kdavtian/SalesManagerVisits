import { test, expect, loginViaUi } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 6: on a desktop window Reports is the list on the left and the chosen report on the right; the
// last report opened comes back; the shared filters (period, region, channel, month) travel to the next report; every report
// has Export (CSV) and Print, and a printout holds the report only. A phone keeps the list -> report pages.
test("desktop Reports: list + report, remembered report, shared period, export, print", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const admin = await fixtures.createUser("admin");
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  await fixtures.createCustomer({ name: `ReportShop${stamp}`, created_by: admin.id });
  await loginViaUi(page, admin.email);
  await page.evaluate(() => {
    localStorage.setItem("fieldvisits_lang", "en");
    localStorage.removeItem("fieldvisits_last_report");
  });

  // #/reports opens a report at once (the first in the list), marked in the list
  await page.goto("/#/reports");
  const side = page.locator(".reports-side");
  await expect(side).toBeVisible({ timeout: 15000 });
  await expect(side.locator(".reports-side-item.is-active")).toHaveCount(1);
  await expect(page).toHaveURL(/#\/reports\?r=[a-z_]+$/);
  await expect(page.locator(".reports-pane .detail-view")).toBeVisible();
  await expect(page.locator(".reports-pane #back-btn")).toBeHidden();
  await expect(page.locator('.reports-pane [data-report-tool="export"]')).toBeVisible();

  // pick New customers from the list
  await side.locator('[data-report="new_customers"]').click();
  await expect(page).toHaveURL(/#\/reports\?r=new_customers$/);
  await expect(side.locator('[data-report="new_customers"]')).toHaveClass(/is-active/);
  const pane = page.locator(".reports-pane");
  await expect(pane).toContainText(`ReportShop${stamp}`, { timeout: 15000 });

  // export: a CSV of what the report shows
  const [download] = await Promise.all([page.waitForEvent("download"), pane.locator('[data-report-tool="export"]').click()]);
  expect(download.suggestedFilename()).toMatch(/^report-new_customers-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain(`ReportShop${stamp}`);

  // print: the browser's print dialog, and a printout without the sidebar, top bar or report list
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => (window.__printed += 1);
  });
  await pane.locator('[data-report-tool="print"]').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await page.emulateMedia({ media: "print" });
  await expect(side).toBeHidden();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".top-bar")).toBeHidden();
  await expect(pane.locator(".detail-view")).toBeVisible();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-reports-print.png` });
  await page.emulateMedia({ media: "screen" });

  // the period chosen here goes with you to the next report that has the same buttons
  await pane.locator('.report-period-tabs [data-period-value="quarter"]').click();
  await side.locator('[data-report="checkins"]').click();
  await expect(page).toHaveURL(/#\/reports\?r=checkins$/);
  await expect(pane.locator('.report-period-tabs input[name="period"]')).toHaveValue("quarter", { timeout: 15000 });
  await expect(pane.locator('.report-period-tabs [data-period-value="quarter"]')).toHaveClass(/activity-tab-active/);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/desktop-reports.png` });

  // the last report opened comes back
  await page.goto("/#/dashboard");
  await page.goto("/#/reports");
  await expect(page).toHaveURL(/#\/reports\?r=checkins$/, { timeout: 15000 });
  await expect(side.locator(".reports-side-item.is-active")).toHaveAttribute("data-report", "checkins");
  await expect(pane.locator('.report-period-tabs input[name="period"]')).toHaveValue("quarter", { timeout: 15000 });

  // phone: the list, then a report page
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/dashboard");
  await page.goto("/#/reports");
  await expect(page.locator(".report-list-card").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".reports-split")).toHaveCount(0);
});
