// UI guardrail (`npm run audit:ui`): the layout bugs the manual UI audit
// kept finding -- a page that scrolls sideways, or controls too small to
// tap -- checked on the main screens at the two narrowest phone widths.
// Horizontal overflow fails the run; undersized tap targets are reported as
// test annotations so they show up in the report without blocking a PR.
import { test, expect, loginViaUi } from "./fixtures.mjs";

const ROUTES = ["#/dashboard", "#/customers", "#/map", "#/reports", "#/settings", "#/pricelist", "#/orders", "#/activity"];
const WIDTHS = [320, 393];
const MIN_TARGET_PX = 24;

for (const width of WIDTHS) {
  test(`@smoke no sideways scroll at ${width}px on the main screens`, async ({ page, fixtures }) => {
    await page.setViewportSize({ width, height: 800 });
    // The map tiles aren't needed to judge layout and would hit the network.
    await page.route(/\/\d+\/\d+\/\d+(@2x)?\.(png|jpg|jpeg)/, (r) => r.abort());
    const user = await fixtures.createUser("admin");
    await loginViaUi(page, user.email);

    const overflowing = [];
    const smallTargets = [];
    for (const route of ROUTES) {
      await page.goto(`/${route}`);
      await page.waitForTimeout(800);
      const result = await page.evaluate((min) => {
        const app = document.querySelector("#app") || document.body;
        const small = [...document.querySelectorAll("button, a[href], input, select, [role=button]")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && r.top < innerHeight && (r.height < min || r.width < min);
          })
          .map((el) => (el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(" ")[0]}` : el.tagName.toLowerCase()));
        return { over: app.scrollWidth - app.clientWidth, small: [...new Set(small)] };
      }, MIN_TARGET_PX);
      if (result.over > 1) overflowing.push(`${route} (+${result.over}px)`);
      if (result.small.length) smallTargets.push(`${route}: ${result.small.join(", ")}`);
    }
    for (const line of smallTargets) test.info().annotations.push({ type: "small-tap-target", description: line });
    expect(overflowing, `pages wider than the ${width}px viewport`).toEqual([]);
  });
}
