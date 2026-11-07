import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-07 (iPhone): after an update Orders "did not open" until the tab was tapped twice, and every reload brought it back. A fresh
// start reopens Orders with the list settings saved on the phone (viewMemory.js): settings an older version saved are now checked one by one,
// the reopened tab's chip is the highlighted one, and a screen that throws while it is built is built once more by itself.
test("@iphone @smoke Orders reopens with saved settings, ignores unknown ones and highlights the reopened tab", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const customer = await fixtures.createCustomer({ name: "Reopen Orders Shop", created_by: admin.id });
  const product = await fixtures.createProduct({ unit_price_amd: 1000 });
  await fixtures.createOrder({ customer_id: customer.id, user_id: admin.id, status: "confirmed", total_amd: 5000, product, quantity: 5, payment_method: "cash" });
  const errors = [];
  // a reload interrupts requests on their way: Safari reports each as "TypeError: Load failed" (Chrome "Failed to fetch"); those are not
  // errors of the screen (and since 1.525.0 the app no longer takes them for a broken app file either)
  // (and a blocked map tile -- the test machine has no internet -- "... due to access control checks"): network, not the screen
  page.on("pageerror", (e) => !/due to access control checks|^(TypeError: )?(Load failed|Failed to fetch)$|Failed to load resource|Fetch API cannot load|\.png\.?$/.test(e.message) && errors.push(e.message)); // the same filter as iphone.spec.mjs
  await page.setViewportSize({ width: 390, height: 844 });
  // the app saves where it is when the page goes away, so the record under test is written at the start of the next load
  await page.addInitScript(() => {
    const next = sessionStorage.getItem("test_next_view");
    if (next) {
      localStorage.setItem("fv_last_view", next);
      sessionStorage.removeItem("test_next_view");
    }
  });
  await loginViaUi(page, admin.email);
  await page.goto("/#/orders");
  await expect(page.locator("#order-search")).toBeVisible({ timeout: 15000 });
  for (const state of [
    { activeStatus: "confirmed", periodFilter: "month", sortKey: "amount", sortReversed: true },
    { activeStatus: "no_such_tab", periodFilter: { from: 1 }, sortKey: "nope", repFilter: { id: 3 }, paymentFilter: 7, q: null, accountingFilter: "x" },
  ]) {
    await page.evaluate(([s, uid]) => {
      sessionStorage.setItem("test_next_view", JSON.stringify({ userId: uid, savedAt: Date.now(), hash: "#/orders", scroll: 0, state: { screen: "orders", ...s } }));
    }, [state, admin.id]);
    await page.reload();
    await expect(page.locator("#orders-list")).not.toContainText("Loading", { timeout: 15000 });
    const expected = state.activeStatus === "confirmed" ? "confirmed" : "submitted";
    await expect(page.locator(`#order-status-filters [data-status="${expected}"]`)).toHaveClass(/chip-active/);
    await expect(page.locator("#order-status-filters .chip-active")).toHaveCount(1);
    if (expected === "confirmed") await expect(page.locator("#orders-list")).toContainText("Reopen Orders Shop");
  }
  await expect(page.locator(".render-failed")).toHaveCount(0);
  expect(errors).toEqual([]);
});
