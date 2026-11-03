import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Vaghinak's route-plan suggestions (owner, 2026-11-03): the CEO sees them, accepts one, then "Accept all" in two taps; nothing changes before.
test("@iphone CEO accepts a route-plan suggestion", async ({ page, fixtures }) => {
  const ceo = await fixtures.createUser("ceo");
  const rep = await fixtures.createUser("sales_manager", { name: "E2E Plan Rep" });
  const a = await fixtures.createCustomer({ created_by: rep.id, name: "E2E Far Customer With A Long Name" });
  const b = await fixtures.createCustomer({ created_by: rep.id, name: "E2E Unplanned Shop" });
  await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, customer_ids, created_by) VALUES ($1, 1, $2, $3), ($1, 3, '{}', $3)", [rep.id, [a.id], ceo.id]);
  const s1 = (await pool.query("INSERT INTO route_plan_suggestions (rep_id, customer_id, kind, from_dow, to_dow, reason) VALUES ($1, $2, 'move', 1, 3, $3) RETURNING id", [rep.id, a.id, JSON.stringify({ own_m: 9200, usual_m: 800, target_m: 600, from_load: 7, to_load: 5 })])).rows[0].id;
  const s2 = (await pool.query("INSERT INTO route_plan_suggestions (rep_id, customer_id, kind, to_dow, reason) VALUES ($1, $2, 'add', 1, $3) RETURNING id", [rep.id, b.id, JSON.stringify({ target_m: 1500, to_load: 6 })])).rows[0].id;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, ceo.email);
    await page.goto("/#/route-plan-suggestions");
    const card = page.locator(`.rps-card[data-id="${s1}"]`);
    await expect(card).toContainText("E2E Far Customer");
    await expect(card).toContainText("9.2 km");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rps-390.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await card.locator("[data-accept]").click();
    await expect(page.locator(`.rps-card[data-id="${s1}"]`)).toHaveCount(0);
    const { rows } = await pool.query("SELECT day_of_week, customer_ids FROM visit_plan_rules WHERE user_id = $1 ORDER BY day_of_week", [rep.id]);
    expect(rows.find((r) => r.day_of_week === 3).customer_ids).toContain(a.id);
    // accept all: two taps
    const all = page.locator("#rps-accept-all");
    await all.click();
    await expect(all).toContainText("again");
    await all.click();
    await expect(page.locator(".rps-card")).toHaveCount(0);
    expect((await pool.query("SELECT customer_ids FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = 1", [rep.id])).rows[0].customer_ids).toContain(b.id);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/rps-done.png`, fullPage: true });
  } finally {
    await pool.query("DELETE FROM route_plan_suggestions WHERE id = ANY($1)", [[s1, s2]]);
    await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  }
});
