import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-22: tapping the SELECTED period button shows the previous period (Today -> Yesterday, This week -> Last week,
// This month -> Last month, This quarter -> Last quarter, This year -> Last year); tapping again flips back; tapping another
// button selects that one. Checked on every row of period buttons, in English.
const label = (page, sel) => page.locator(sel).first();

async function english(page) {
  await page.evaluate(() => localStorage.setItem("fieldvisits_lang", "en"));
}

test("Activity: Today flips to Yesterday and back; another tab resets it; the list is asked for the right range", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await english(page);
  await page.goto("/#/activity");
  const ranges = [];
  page.on("request", (r) => { const m = /\/api\/checkins\?.*range=([a-z_]+)/.exec(r.url()); if (m) ranges.push(m[1]); });
  const today = page.locator('.activity-tab[data-range="today"]');
  const week = page.locator('.activity-tab[data-range="week"]');
  await expect(today).toHaveText(/Today|Այսօր/);
  await today.click();
  await expect(today).toHaveText(/Yesterday|Երեկ/);
  await expect(today).toHaveClass(/period-prev/);
  await expect.poll(() => ranges.at(-1)).toBe("yesterday");
  await today.click();
  await expect(today).toHaveText(/Today|Այսօր/); // (a fresh cached list of today is shown without asking again)
  await week.click(); // another button: this week
  await expect(week).toHaveText(/This week|Այս շաբաթ/);
  await week.click();
  await expect(week).toHaveText(/Last week|Անցած շաբաթ/);
  await expect.poll(() => ranges.at(-1)).toBe("last_week");
  await today.click(); // back to a different button: its CURRENT period
  await expect(today).toHaveText(/Today|Այսօր/);
  await expect(week).toHaveText(/This week|Այս շաբաթ/);
});

test("Reports: five period buttons with This quarter; the selected one flips, All does not", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await english(page);
  await page.goto("/#/reports?r=new_customers");
  const tabs = page.locator(".report-period-tabs [data-period-value]");
  await expect(tabs).toHaveCount(6);
  const periods = [];
  page.on("request", (r) => { const m = /\/api\/reports\/new-customers\?.*period=([a-z_]+)/.exec(r.url()); if (m) periods.push(m[1]); });
  const q = page.locator('.report-period-tabs [data-period-value="quarter"]');
  await q.click(); // select This quarter
  await expect(q).toHaveText(/This quarter|Այս եռամսյակ/);
  await expect.poll(() => periods.at(-1)).toBe("quarter");
  await q.click();
  await expect(q).toHaveText(/Last quarter|Անցած եռամսյակ/);
  await expect.poll(() => periods.at(-1)).toBe("last_quarter");
  const month = page.locator('.report-period-tabs [data-period-value="month"]');
  await month.click();
  await expect(q).toHaveText(/This quarter|Այս եռամսյակ/); // the other button went back to its current period
  await month.click();
  await expect(month).toHaveText(/Last month|Անցած ամիս/);
  await expect.poll(() => periods.at(-1)).toBe("last_month");
  const all = page.locator('.report-period-tabs [data-period-value="all"]');
  await all.click();
  await expect.poll(() => periods.at(-1)).toBe("all");
  const n = periods.length;
  await all.click(); // nothing to flip to
  await page.waitForTimeout(400);
  expect(periods.length).toBe(n);
});

test("Progress by reps and the Products & liters report: the same flip", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await english(page);
  await page.goto("/#/team-progress");
  const week = page.locator('#rp-periods [data-period="week"]');
  await expect(week).toHaveClass(/chip-active/);
  const asked = [];
  page.on("request", (r) => { const m = /rep-progress\?period=([a-z_]+)/.exec(r.url()); if (m) asked.push(m[1]); });
  await week.click();
  await expect(week).toHaveText(/Last week|Անցած շաբաթ/);
  await expect.poll(() => asked.at(-1)).toBe("last_week");
  await page.locator('#rp-periods [data-period="today"]').click();
  await expect.poll(() => asked.at(-1)).toBe("today");

  await page.goto("/#/reports?r=product_liters");
  const vol = page.locator('#vol-periods [data-period]');
  const year = page.locator('#vol-periods [data-period="ytd"]');
  await expect(year).toBeVisible();
  await expect(year).toHaveText(/This year|Այս տարի/);
  await year.click();
  await expect(page.locator("#vol-periods .chip-active")).toHaveText(/This year|Այս տարի/); // selected
  await page.locator("#vol-periods .chip-active").click();
  await expect(page.locator("#vol-periods .chip-active")).toHaveText(/Last year|Անցած տարի/);
  await page.locator("#vol-periods .chip-active").click();
  await expect(page.locator("#vol-periods .chip-active")).toHaveText(/This year|Այս տարի/);
  const q = page.locator('#vol-periods [data-period="this_quarter"]');
  await q.click();
  await expect(page.locator("#vol-periods .chip-active")).toHaveText(/This quarter|Այս եռամսյակ/);
  expect(await vol.count()).toBe(7); // today, week, month, quarter, year, last 12 months, custom
});

test("Company dashboard: quarter button, and Today / This week flip to Yesterday / Last week without an error", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await english(page);
  await page.goto("/#/company-dashboard");
  const tabs = page.locator(".company-dashboard-period-tabs .activity-tab");
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(3)).toHaveText(/This quarter|Այս եռամսյակ/);
  for (const [i, prev] of [[0, /Yesterday|Երեկ/], [1, /Last week|Անցած շաբաթ/], [2, /Last month|Անցած ամիս/], [3, /Last quarter|Անցած եռամսյակ/], [4, /Last year|Անցած տարի/]]) {
    await tabs.nth(i).click(); // select
    if (await tabs.nth(i).evaluate((b) => b.classList.contains("period-prev"))) await tabs.nth(i).click();
    await tabs.nth(i).click(); // flip
    await expect(tabs.nth(i)).toHaveText(prev);
    await expect(page.locator("#company-dashboard-sales .form-error")).toHaveCount(0);
  }
});
