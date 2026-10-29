import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Stock count (Գույքագրում, owner 2026-10-30): the warehouse manager types the counted quantity of each product of the day's plan
// (Enter = next product), never sees the Excel number while counting, and finishes the day; products left move to the next day.
const TODAY = "(now() AT TIME ZONE 'Asia/Yerevan')::date";

test("@smoke @iphone stock count: count blind, Enter moves on, finish the day", async ({ page, fixtures }) => {
  const wm = await fixtures.createUser("warehouse_manager");
  const tag = `SC${Date.now().toString(36)}`;
  const a = await fixtures.createProduct({ name: `${tag} A Magnatec 5W-40` });
  const b = await fixtures.createProduct({ name: `${tag} B Edge 0W-30` });
  await pool.query("UPDATE products SET stock_qty = 12, brand = 'Castrol', unit = '4 L' WHERE id = ANY($1)", [[a.id, b.id]]);
  await pool.query(`DELETE FROM stock_count_days WHERE day = ${TODAY}`);
  await pool.query(
    `INSERT INTO stock_counts (month, product_id, planned_date) SELECT date_trunc('month', ${TODAY})::date, x, ${TODAY} FROM unnest($1::int[]) x
     ON CONFLICT (month, product_id) DO UPDATE SET planned_date = EXCLUDED.planned_date, counted_at = NULL, counted_qty = NULL, counted_day = NULL`,
    [[a.id, b.id]]
  );
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaUi(page, wm.email);
    await page.goto("/#/stock-count");
    await page.locator("#sc-search").fill(tag);
    const rowA = page.locator(`.sc-row[data-id="${a.id}"]`);
    const rowB = page.locator(`.sc-row[data-id="${b.id}"]`);
    await expect(rowA).toBeVisible();
    await expect(page.locator(".sc-excel")).toHaveCount(0); // blind: no Excel number before the day is closed

    const savedA = page.waitForResponse((r) => r.url().includes(`/api/stock-count/items/${a.id}`) && r.request().method() === "PUT");
    await rowA.locator(".sc-qty").fill("12");
    await rowA.locator(".sc-qty").press("Enter");
    expect((await savedA).status()).toBe(200);
    await expect(rowB.locator(".sc-qty")).toBeFocused();
    const savedB = page.waitForResponse((r) => r.url().includes(`/api/stock-count/items/${b.id}`) && r.request().method() === "PUT");
    await rowB.locator(".sc-qty").fill("9");
    await rowB.locator(".sc-qty").press("Enter");
    expect((await savedB).status()).toBe(200);
    await expect(rowA).toHaveClass(/is-counted/);
    await expect(rowB).toHaveClass(/is-counted/);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/stock-count-phone.png`, fullPage: true });

    // other products of the plan may be left: the first tap says so, the second finishes
    const finish = page.locator("#sc-finish");
    await finish.click();
    if (await page.locator("#sc-bar-hint.is-warning").isVisible()) await finish.click();
    await expect(page.locator("#sc-bar")).toBeHidden();
    await page.locator("#sc-search").fill(tag);
    await expect(rowB.locator(".sc-diff")).toHaveText("-3"); // closed: now the difference shows
    await expect(rowA.locator(".sc-diff")).toHaveText("✓");
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/stock-count-finished.png`, fullPage: true });
    const { rows } = await pool.query(`SELECT counted, differences FROM stock_count_days WHERE day = ${TODAY}`);
    expect(rows[0].counted).toBeGreaterThanOrEqual(2);
    expect(rows[0].differences).toBeGreaterThanOrEqual(1);
  } finally {
    await pool.query(`DELETE FROM stock_count_days WHERE day = ${TODAY}`);
    await pool.query("DELETE FROM stock_counts WHERE product_id = ANY($1)", [[a.id, b.id]]);
  }
});
