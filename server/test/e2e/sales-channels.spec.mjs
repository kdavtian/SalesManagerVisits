import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-29: "sales channel filter works too slow and doesn't cache". The period's sales are fetched once; a channel pill
// filters them on the phone (no request, instant), and coming back to the screen shows the last answer at once.
test("@smoke Sales: switching channels sends no request and shows only that channel's orders", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const stamp = Date.now();
  const a = await fixtures.createCustomer({ created_by: admin.id, name: "E2E Channel A", erp_customer_id: `E2E-CHA-${stamp}`, sales_channel: "SM YVN" });
  const b = await fixtures.createCustomer({ created_by: admin.id, name: "E2E Channel B", erp_customer_id: `E2E-CHB-${stamp}`, sales_channel: "KF" });
  await pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd, qty, size_l) VALUES ($1, 'CA1', current_date, 100000, 1, '4'), ($2, 'CB1', current_date, 200000, 1, '4')",
    [a.erp_customer_id, b.erp_customer_id]
  );
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/sales");
    await expect(page.locator("#sales-list")).toContainText("E2E Channel B");
    const salesRequests = [];
    page.on("request", (r) => r.url().includes("/api/sales") && salesRequests.push(r.url()));
    const pill = page.locator('#sales-channel-bar .stat-pill[data-channel="KF"]');
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#sales-list")).toContainText("E2E Channel B");
    await expect(page.locator("#sales-list")).not.toContainText("E2E Channel A");
    await pill.click(); // tap again: all channels
    await expect(page.locator("#sales-list")).toContainText("E2E Channel A");
    expect(salesRequests).toEqual([]);
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [[a.erp_customer_id, b.erp_customer_id]]);
  }
});
