import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

test.describe("Administrator role management", () => {
  test("@smoke an admin can create a new team member with a specific role through Settings", async ({
    page,
    fixtures,
  }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);

    await page.goto("/#/settings");
    await page.getByRole("tab", { name: /admin/i }).click();
    await page.locator("#row-team-management").click();
    await page.locator("#add-team-member-btn").click();

    const form = page.locator("#new-user-form");
    await expect(form).toBeVisible();
    const email = `e2e-new-hire-${Date.now()}@kadmotors.local`;
    await form.locator('input[name="name"]').fill("E2E New Hire");
    await form.locator('input[name="email"]').fill(email);
    await form.locator('input[name="password"]').fill("TempPass1234!");
    await form.locator("#new-user-role").selectOption("sales_director");

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/users") && res.request().method() === "POST"),
      form.locator('button[type="submit"]').click(),
    ]);
    expect(response.ok()).toBeTruthy();
    const created = await response.json();
    fixtures.trackRow("users", created.id);

    await expect(form).toBeHidden();
    await expect(page.getByText("E2E New Hire")).toBeVisible({ timeout: 10000 });

    const { rows } = await pool.query("SELECT role FROM users WHERE id = $1", [created.id]);
    expect(rows[0].role).toBe("sales_director");
  });
});
