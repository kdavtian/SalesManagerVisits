import { test, expect, loginViaUi } from "./fixtures.mjs";

// The navigation roadmap (owner, 2026-11-04; client/public/js/kit/ + sheetNav.js, moreSheet.js, searchPalette.js, pins.js):
// Back closes the sheet on top and stays on the page; a bottom sheet is pulled down to close; the menu button opens the More sheet
// (Settings at the bottom) where screens are pinned to Home; one search finds a screen and a customer; Ctrl K on a computer.
test.describe("Navigation", () => {
  test("@smoke Back closes the open sheet and stays on the page; the next Back goes back a page", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rep = await fixtures.createUser("sales_manager");
    await loginViaUi(page, rep.email);
    await page.goto("/#/reports");
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 15000 });
    await page.locator("#topbar-menu-btn").click();
    await expect(page.locator(".more-sheet")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".more-sheet")).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe("#/reports");
    // the sheet closed by its own button gives its Back step back: the next Back leaves the page
    await page.locator("#topbar-menu-btn").click();
    await page.locator('.more-sheet [data-action="close"]').click();
    await expect(page.locator(".more-sheet")).toHaveCount(0);
    await page.waitForTimeout(150);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).hash).not.toBe("#/reports");
  });

  test("@smoke a bottom sheet pulled down closes; a short pull springs back", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ...testInfo.project.use, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const { Fixtures } = await import("./fixtures.mjs");
    const fixtures = new Fixtures();
    try {
      const rep = await fixtures.createUser("sales_manager");
      await loginViaUi(page, rep.email);
      await page.locator("#topbar-menu-btn").click();
      const sheet = page.locator(".more-sheet");
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(300); // the opening slide-up
      const swipe = (dy) =>
        page.evaluate(async (dy) => {
          const el = document.querySelector(".more-sheet .sheet-grab");
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const touch = (yy) => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
          el.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(y)], changedTouches: [touch(y)], bubbles: true, cancelable: true }));
          for (let i = 1; i <= 6; i++) {
            el.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(y + (dy * i) / 6)], changedTouches: [touch(y + (dy * i) / 6)], bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 40));
          }
          el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(y + dy)], bubbles: true, cancelable: true }));
        }, dy);
      await swipe(30);
      await page.waitForTimeout(300);
      await expect(sheet).toBeVisible();
      await swipe(420);
      await expect(sheet).toHaveCount(0, { timeout: 3000 });
    } finally {
      await fixtures.cleanup?.();
      await context.close();
    }
  });

  test("@smoke the More sheet pins a screen to Home; Settings is its last row", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rep = await fixtures.createUser("sales_manager");
    await loginViaUi(page, rep.email);
    await expect(page.locator("#qa-check-in")).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".pinned-row")).toHaveCount(0);
    await page.locator("#topbar-menu-btn").click();
    const sheet = page.locator(".more-sheet");
    await expect(sheet.locator('[data-hash="#/settings"]')).toBeVisible();
    await sheet.locator('[data-pin="qa_pricelist"]').click();
    await expect(sheet.locator('[data-pin="qa_pricelist"]')).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/nav-more-sheet.png` });
    await sheet.locator('[data-action="close"]').click();
    await expect(page.locator('.pinned-row [data-hash="#/pricelist"]')).toBeVisible();
    // saved on the server: still pinned after a reload
    await page.reload();
    await expect(page.locator('.pinned-row [data-hash="#/pricelist"]')).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/nav-pinned-row.png` });
    await page.locator('.pinned-row [data-hash="#/pricelist"]').click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#/pricelist");
  });

  test("@smoke one search finds a screen and a customer (phone sheet)", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rep = await fixtures.createUser("sales_manager");
    const customer = await fixtures.createCustomer({ created_by: rep.id, name: `Navsearch Garage ${Date.now()}` });
    await loginViaUi(page, rep.email);
    await page.locator("#topbar-search-btn").click();
    const input = page.locator("#search-sheet-input");
    await expect(input).toBeFocused();
    await input.fill("pricel");
    await expect(page.locator('.search-sheet [data-result]').first()).toBeVisible();
    await expect(page.locator(".search-group").first()).toContainText(/Products|Ապրանքներ/i);
    await input.fill("Navsearch");
    await expect(page.locator(".search-sheet").getByText(customer.name)).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/nav-search-sheet.png` });
    await page.locator(".search-sheet").getByText(customer.name).click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/customers/${customer.id}`);
    // opened recently: shown before typing next time
    await page.locator("#topbar-search-btn").click();
    await expect(page.locator(".search-sheet").getByText(customer.name)).toBeVisible();
  });

  test("Ctrl K focuses the computer's search, which also finds screens", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await expect(page.locator("#topbar-search-input")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#topbar-search-btn")).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#topbar-search-input")).toBeFocused();
    await page.keyboard.type("cashfl");
    await expect(page.locator(".topbar-search-results")).toContainText(/Cashflow|Դրամական հոսք/i);
    await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/nav-desk-search.png` });
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).hash).toBe("#/cashflow");
  });
});
