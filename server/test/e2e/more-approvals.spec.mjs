import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-19: "If there is Approval requests, they should appear on the 'Approvals' menu in the MORE page on top part."
test("More sheet: Approvals is the first row, with the number waiting; it opens the list", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const director = await fixtures.createUser("sales_director");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  const { rows: [req] } = await pool.query(
    "INSERT INTO customer_edit_requests (customer_id, requested_by, changes) VALUES ($1, $2, $3) RETURNING id",
    [customer.id, rep.id, JSON.stringify({ address: "E2E street 5" })]
  );
  try {
    await loginViaUi(page, director.email);
    await expect(page.locator("#topbar-menu-badge")).toHaveText(/[1-9]/, { timeout: 15000 });
    await page.locator("#topbar-menu-btn").click();
    const sheet = page.locator(".more-sheet");
    const first = sheet.locator(".more-sections > section").first();
    await expect(first).toHaveClass(/more-section-approvals/);
    await expect(first.locator('[data-badge="requests"]')).toHaveText(/[1-9]/);
    // not repeated in the groups below
    await expect(sheet.locator('.more-link[data-hash="#/requests"]')).toHaveCount(1);
    await first.locator(".more-link").click();
    await expect(page).toHaveURL(/#\/requests$/);
    await expect(page.locator(".req-list")).toContainText("E2E", { timeout: 10000 });
  } finally {
    await pool.query("DELETE FROM customer_edit_requests WHERE id = $1", [req.id]);
  }
});
