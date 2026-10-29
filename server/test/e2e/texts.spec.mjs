import { test, expect, loginViaUi } from "./fixtures.mjs";

// The texts live in i18n/<lang>/<area>.js (docs/architecture-roadmap.md step 8b). Right after an update a screen can ask for a text the
// page's language file does not have yet: i18n.js then fetches the language file and each area file again, fresh, and replaces the raw
// name on screen in place (no reload). With the texts split into area files, a fresh joining file alone would bring back the old areas.
test("@smoke a text missing after an update is fetched fresh from its area file and replaces the raw name on screen", async ({ page, context, fixtures }) => {
  // a "newer release" of the orders area: the same texts plus one new
  await context.route(/\/js\/i18n\/en\/orders\.js\?fresh=/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace("export const enOrders = {", 'export const enOrders = {\n  e2e_new_text: "Fresh text from the new release",');
    await route.fulfill({ response: res, body, headers: { ...res.headers(), "content-type": "text/javascript" } });
  });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await page.goto("/#/dashboard");
  await expect(page.locator("#top-bar")).toBeVisible();
  const before = await page.evaluate(async () => {
    const { t } = await import("/js/i18n.js");
    const probe = document.createElement("p");
    probe.id = "e2e-text-probe";
    probe.textContent = t("e2e_new_text"); // not in the loaded texts: the raw name, and a fresh fetch starts
    document.querySelector("#app").append(probe);
    return probe.textContent;
  });
  expect(before).toBe("e2e_new_text");
  await expect(page.locator("#e2e-text-probe")).toHaveText("Fresh text from the new release");
  // the texts that were there stay (the fresh areas are merged in, nothing is lost)
  expect(await page.evaluate(async () => (await import("/js/i18n.js")).t("nav_dashboard"))).toBe("Home");
});
