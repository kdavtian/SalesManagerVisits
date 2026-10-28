import { test, expect, loginViaUi } from "./fixtures.mjs";

// docs/desktop-roadmap.md, step 10: the desktop layout is checked by CI. Every main page opens as admin at 1440 px (every PR, @smoke) and
// 1920 px (nightly): nothing may stick out of the window (no sideways page scroll), and a screenshot of each page is kept
// (test-results/desktop-shots, uploaded by the nightly workflow). Plus the two table rules: the docked panel never covers the list, and the
// column headings stay on screen while the list scrolls.
const PAGES = [
  "dashboard", "activity", "map", "customers", "orders", "tasks", "vaghinak", "team-performance", "sales", "reports", "route-plans",
  "payments", "cash-handoffs", "expenses", "debt-balances", "cashflow", "accounting", "recorded", "documents", "delivery", "warehouse",
  "returns", "staff", "bonuses", "pricelist", "ops-control", "notifications", "settings",
];

async function checkPages(page, fixtures, width) {
  test.setTimeout(240_000);
  await page.setViewportSize({ width, height: 1000 });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  const problems = [];
  for (const name of PAGES) {
    await page.goto(`/#/${name}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(400);
    const layout = await page.evaluate(() => ({
      pageWide: document.documentElement.scrollWidth - window.innerWidth,
      // elements of the page (not a dialog, not inside their own scroller) that end past the right edge of the window
      sticking: [...document.querySelectorAll("#app *")]
        .filter((el) => {
          if (!el.offsetParent || el.closest(".sheet-overlay, .leaflet-container")) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.right <= window.innerWidth + 2) return false;
          for (let p = el.parentElement; p && p.id !== "app"; p = p.parentElement) {
            if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return false;
          }
          return true;
        })
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${Math.round(el.getBoundingClientRect().right)}px`),
    }));
    if (layout.pageWide > 1 || layout.sticking.length) problems.push(`${name}: ${layout.pageWide > 1 ? `page ${layout.pageWide}px wider than the window; ` : ""}${layout.sticking.join(", ")}`);
    await page.screenshot({ path: `test-results/desktop-shots/${width}-${name}.png` });
  }
  expect(problems, problems.join("\n")).toEqual([]);
}

test("@smoke desktop pages at 1440 px: nothing sticks out of the window", async ({ page, fixtures }) => {
  await checkPages(page, fixtures, 1440);
});

test("desktop pages at 1920 px: nothing sticks out of the window", async ({ page, fixtures }) => {
  await checkPages(page, fixtures, 1920);
});

test("desktop tables: the docked panel never covers the list, headings stay while scrolling", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const product = await fixtures.createProduct({ unit_price_amd: 10000 });
  const stamp = Date.now() % 100000;
  for (let i = 0; i < 30; i++) {
    const c = await fixtures.createCustomer({ name: `Shot Garage ${stamp} ${String(i).padStart(2, "0")}`, created_by: admin.id, assigned_manager_id: rep.id });
    if (i < 3) await fixtures.createOrder({ customer_id: c.id, user_id: rep.id, status: "submitted", total_amd: 10000, product, quantity: 1 });
  }
  await loginViaUi(page, admin.email);

  // the order panel docks beside the list: the list ends where the panel starts
  await page.goto("/#/orders");
  const first = page.locator("#orders-list > .list-row").first();
  await expect(first).toBeVisible({ timeout: 15000 });
  await first.click();
  const panel = page.locator(".sheet-overlay.sheet-docked .sheet");
  await expect(panel).toBeVisible({ timeout: 10000 });
  const [list, docked] = await Promise.all([page.locator("#orders-list").boundingBox(), panel.boundingBox()]);
  expect(list.x + list.width).toBeLessThanOrEqual(docked.x + 1);

  // the customers' column headings stay on screen while the list scrolls
  await page.goto("/#/customers");
  await expect(page.locator("#customer-list > .list-row").nth(20)).toBeVisible({ timeout: 15000 });
  const head = page.locator("#customer-desk-head .desk-thead");
  await expect(head).toBeVisible();
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  const box = await head.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeLessThan(260);
});
