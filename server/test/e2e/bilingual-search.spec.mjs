import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-29: "search should work on both languages: jrvej = ջրվեժ; kastrol = կաստրոլ = castrol = qastrol". The Customers
// search finds a name typed in the other script or with one letter wrong (5+ letters), the exact matches first.
test("@smoke Customers search finds a name in the other script and with one typo", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await fixtures.createCustomer({ created_by: admin.id, name: "Ջրվեժ Ավտո Բիլինգ" });
  await fixtures.createCustomer({ created_by: admin.id, name: "Castrol Point Biling" });
  await loginViaUi(page, admin.email);
  await page.goto("/#/customers");
  const search = page.locator("#customer-search");
  const list = page.locator("#customer-list");
  await search.fill("jrvej biling");
  await expect(list).toContainText("Ջրվեժ Ավտո Բիլինգ");
  await expect(list).not.toContainText("Castrol Point Biling");
  await search.fill("կաստրոլ");
  await expect(list).toContainText("Castrol Point Biling");
  await search.fill("kastrl biling");
  await expect(list).toContainText("Castrol Point Biling");
});
