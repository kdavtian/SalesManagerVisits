import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-11-15 ("I tried to delete Kotayk yuxman ket3 but it doesn't allow"): the refusal names what blocks the delete,
// with numbers, in the user's language (it was one English sentence about payments, even when a KAD OS link was the reason).
for (const lang of ["hy", "en"]) {
  test(`a customer with payments: Delete says why, in ${lang} @smoke`, async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (lang === "hy") await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const admin = await fixtures.createUser("admin");
    const c = await fixtures.createCustomer({ created_by: admin.id, assigned_manager_id: admin.id, name: `E2E Delete Blocked ${lang}` });
    await fixtures.createPayment({ customer_id: c.id, sales_manager_id: admin.id, amount_amd: 245000 });
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${c.id}`);
    await page.locator("#edit-customer-btn").click();
    page.once("dialog", (d) => d.accept());
    await page.locator("#delete-customer-btn").click();
    const err = page.locator("#edit-customer-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("245,000");
    await expect(err).toContainText(lang === "hy" ? "1 վճարում" : "1 payment(s)");
    await expect(err).not.toContainText("KAD OS");
    await expect(err).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`delete-blocked-${lang}.png`) });
    // still on the sheet, the customer is still there
    await expect(page.locator("#edit-customer-form")).toBeVisible();
  });
}
