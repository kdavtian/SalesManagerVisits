import { test, expect, loginViaUi } from "./fixtures.mjs";

// Performance guard (owner, 2026-10-17: "find possible slowing causes"). The page-wide "enhancer" observers
// (unifiedSearchEnhancements.js, ordersSearchEnhancements.js, ordersRegionStatusEnhancements.js, mapDimensionFilterPlacement.js)
// used to re-run on every frame forever on Orders, Customers, Products and the Map, because each pass rewrote
// classes / innerHTML even when nothing changed and that write woke the observers again (60 passes a second while idle:
// 3 s of main-thread time out of 3 on a throttled phone). An idle screen must not touch the DOM.
test.describe("Idle screens do not churn the DOM", () => {
  for (const [name, hash] of [["Orders", "#/orders"], ["Customers", "#/customers"], ["Products", "#/pricelist"], ["Map", "#/map"]]) {
    test(`${name} is quiet when idle`, async ({ page, fixtures }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      let tileN = 0;
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      await page.route(/\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(++tileN)]) }));
      const admin = await fixtures.createUser("admin");
      await loginViaUi(page, admin.email);
      await page.goto(`/${hash}`);
      await page.waitForTimeout(3500); // let the screen finish loading
      const records = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let n = 0;
            const mo = new MutationObserver((recs) => (n += recs.length));
            mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
            setTimeout(() => {
              mo.disconnect();
              resolve(n);
            }, 2000);
          })
      );
      expect(records, `${name}: DOM mutations in 2 s of idle`).toBeLessThan(10);
    });
  }
});
