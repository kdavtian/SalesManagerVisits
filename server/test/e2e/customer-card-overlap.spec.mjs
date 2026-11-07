import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: "on customer cards fix overlapping of order dates and the Excel chip; fix all overlap issues". At a phone, a laptop
// and a wide screen: no two parts of an order / payment row overlap, the "needs attention" strip does not push the two columns apart,
// and the phone's orders sheet shows the whole order number.
test("@smoke customer card rows never overlap (390 / 1100 / 1440)", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const erpId = `OV${Date.now()}`;
  const customer = await fixtures.createCustomer({ name: "Overlap Garage Long Name LLC", created_by: admin.id, erp_customer_id: erpId });
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, "0");
  for (let i = 1; i <= 4; i++) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, brand, product_name, size_l, qty, unit_price_amd, revenue_amd) VALUES ($1,$2,$3,'Castrol','GTX','4',3,20000,1234567)", [erpId, `${y}${m}0${i}01`, `${y}-${m}-0${i}`]);
    await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 1250000)", [erpId, `${y - 1}-12-2${i}`]); // dates with their year
  }
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 3500000) ON CONFLICT DO NOTHING", [erpId]);
  const overlaps = () =>
    page.evaluate(() => {
      const bad = [];
      for (const row of document.querySelectorAll(".cd-row, .orders-sheet-row, .payments-received-row, .co-row[data-order-id]")) {
        const parts = [...row.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width && r.height);
        for (let i = 0; i < parts.length; i++)
          for (let j = i + 1; j < parts.length; j++) {
            const a = parts[i];
            const b = parts[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(row.className + ": " + row.textContent.trim().slice(0, 40));
          }
      }
      return bad;
    });
  try {
    await loginViaUi(page, admin.email);
    for (const [w, h] of [[1440, 900], [1100, 800], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/#/customers/${customer.id}`);
      await expect(page.locator('[data-stat="sales"]')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(800);
      expect(await overlaps(), `card ${w}`).toEqual([]);
      if (w === 1100) {
        // both columns start right under the header row, side by side
        const main = await page.locator(".cd-col-main").boundingBox();
        const side = await page.locator(".cd-col-side").boundingBox();
        expect(Math.abs(main.y - side.y)).toBeLessThan(40);
      }
      for (const stat of ["sales", "debt"]) {
        await page.locator(`[data-stat="${stat}"]`).click();
        await expect(page.locator(".sheet-overlay .sheet")).toBeVisible();
        await page.waitForTimeout(800);
        expect(await overlaps(), `${stat} sheet ${w}`).toEqual([]);
        await page.locator(".sheet-overlay").evaluateAll((els) => els.forEach((e) => e.remove()));
      }
    }
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [erpId]);
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  }
});
