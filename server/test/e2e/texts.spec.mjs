import { test, expect, loginViaUi } from "./fixtures.mjs";

// The texts live in i18n/<lang>/<area>.js (docs/architecture-roadmap.md step 8b). Right after an update a screen can ask for a text the
// page's language file does not have yet: i18n.js then fetches the language file and each area file again, fresh, and replaces the raw
// name on screen in place (no reload). With the texts split into area files, a fresh joining file alone would bring back the old areas.
test("@smoke a text missing after an update is fetched fresh from its area file and replaces the raw name on screen", async ({ page, context, fixtures }) => {
  // a "newer release" of the orders area: the same texts plus one new (an added export: i18n.js merges every export of an area file, and
  // it works on the source file and on the deploy build's minified copy alike)
  await context.route(/\/js\/i18n\/en\/orders\.js\?fresh=/, async (route) => {
    const res = await route.fetch();
    const body = `${await res.text()}\nexport const e2eNewRelease = { e2e_new_text: "Fresh text from the new release" };\n`;
    await route.fulfill({ response: res, body, headers: { ...res.headers(), "content-type": "text/javascript" } });
  });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await page.goto("/#/dashboard");
  await expect(page.locator("#top-bar")).toBeVisible();
  const before = await page.evaluate(async () => {
    const { t, loadAllTexts } = await import("/js/i18n.js");
    await loadAllTexts(); // every area is in (step 11 loads the others after the first screen): a text still missing means a newer release
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

// Step 11: before a screen is drawn, `common` and the areas it needs are in (i18nAreas.js); the other areas follow in the background.
test("@smoke a direct link loads its text areas before the screen is drawn, the others follow; no raw text names", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  const loaded = () => page.evaluate(async () => (await import("/js/i18n.js")).loadedTextAreas());
  await page.goto("/#/settings");
  await expect(page.locator("#top-bar")).toBeVisible();
  const atFirstScreen = await loaded();
  for (const area of ["common", "customers", "settings"]) expect(atFirstScreen, area).toContain(area);
  await expect.poll(async () => (await loaded()).length, { timeout: 10000 }).toBe(9);
  const raw = await page.evaluate(() => document.body.innerText.match(/\b[a-z]+_[a-z0-9_]+\b/g) ?? []);
  expect(raw).toEqual([]);
  await page.goto("/#/dashboard");
  await page.reload();
  await expect(page.locator("#top-bar")).toBeVisible();
  for (const area of ["common", "orders"]) expect(await loaded(), area).toContain(area);
});

// Codex on #518: a screen opened before the background texts are in waited for nothing, so a text the screen put a value into
// ("Payment term: {n} days") could keep its "{n}". Every screen after the first now waits until all areas are in.
test("@smoke a screen opened while the other text areas are still loading waits for them", async ({ page, context, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  // the customers area arrives late (a slow phone): Home does not need it, the Customers screen does
  await context.route(/\/js\/i18n\/en\/customers\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.goto("/#/dashboard");
  await page.reload();
  await expect(page.locator("#top-bar")).toBeVisible();
  expect(await page.evaluate(async () => (await import("/js/i18n.js")).allTextsLoaded())).toBe(false);
  await page.evaluate(() => (location.hash = "#/customers"));
  await expect(page.locator("#customer-search")).toBeVisible({ timeout: 10000 });
  // drawn only once every area was in
  expect(await page.evaluate(async () => (await import("/js/i18n.js")).loadedTextAreas().length)).toBe(9);
  const raw = await page.evaluate(() => document.body.innerText.match(/\b[a-z]+_[a-z0-9_]+\b|\{n\}/g) ?? []);
  expect(raw).toEqual([]);
});

// Codex on #518: a text missing before the background load finished loaded the other areas, and when it was still missing (a newer
// release's text) nothing fetched it fresh.
test("a text still missing once the other areas are in is fetched fresh too", async ({ page, context, fixtures }) => {
  await context.route(/\/js\/i18n\/en\/orders\.js\?fresh=/, async (route) => {
    const res = await route.fetch();
    const body = `${await res.text()}\nexport const e2eNewRelease = { e2e_new_text: "Fresh text from the new release" };\n`;
    await route.fulfill({ response: res, body, headers: { ...res.headers(), "content-type": "text/javascript" } });
  });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await context.route(/\/js\/i18n\/en\/settings\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto("/#/dashboard");
  await page.reload();
  await expect(page.locator("#top-bar")).toBeVisible();
  const before = await page.evaluate(async () => {
    const { t, allTextsLoaded } = await import("/js/i18n.js");
    const probe = document.createElement("p");
    probe.id = "e2e-text-probe";
    probe.textContent = t("e2e_new_text");
    document.querySelector("#app").append(probe);
    return { text: probe.textContent, allIn: allTextsLoaded() };
  });
  expect(before).toEqual({ text: "e2e_new_text", allIn: false });
  await expect(page.locator("#e2e-text-probe")).toHaveText("Fresh text from the new release", { timeout: 10000 });
});
