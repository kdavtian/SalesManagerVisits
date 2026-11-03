import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Rep Home (owner, 2026-11-03): one "today" card -- planned visits, progress bar to the mandatory 75 % share, "need N more", the month so far;
// tapping a customer's name opens the map on that pin; the Armenian greeting uses the Armenian first name.
const TODAY = "(now() AT TIME ZONE 'Asia/Yerevan')::date";

test("@iphone rep home: today card with the 75 % target, name tap opens the map pin", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager", { name: "Artak Test" });
  await pool.query("UPDATE users SET name_hy = $2 WHERE id = $1", [rep.id, "Արտակ Թեստյան"]);
  const customers = [];
  for (let i = 1; i <= 4; i++) customers.push(await fixtures.createCustomer({ created_by: rep.id, name: `E2E Day Customer ${i}` }));
  await pool.query(`INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, ${TODAY}, $2, 'approved', $1)`, [rep.id, customers.map((c) => c.id)]);
  await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.5, 3, true)", [customers[0].id, rep.id]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, rep.email);
    await page.goto("/#/dashboard");
    const card = page.locator(".my-day");
    await expect(card.locator(".my-day-count")).toContainText("1/4");
    // 75 % of 4 = 3 visits needed, 1 done -> 2 more
    await expect(card.locator(".my-day-line")).toContainText("2 more");
    await expect(card.locator(".my-day-row")).toHaveCount(4);
    await expect(card.locator(".my-day-checkin")).toHaveCount(1);
    await expect(page.locator("#progress-card")).toBeHidden();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rep-home-390.png` });
    await page.setViewportSize({ width: 320, height: 700 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rep-home-320.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await card.locator(`[data-map="${customers[1].id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#/map\\?customer=${customers[1].id}`));
  } finally {
    await pool.query("DELETE FROM visit_plans WHERE user_id = $1", [rep.id]);
    await pool.query("DELETE FROM checkins WHERE user_id = $1", [rep.id]);
  }
});
