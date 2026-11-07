// The pictures for the screenshot comparison (shots.config.mjs, run by `npm run shots:main`): every bottom tab and main screen of the
// admin (the owner's account) and of a sales rep, plus the sheets used all day (the new order's "Your order" sheet, the customer card,
// a payment being entered), on a 390 px iPhone (Armenian, light), a 390 px iPhone (English, dark), a 440 px iPhone 16 Pro Max (Armenian,
// light) and a 1440 px desktop (Armenian, light). Clock and data are fixed (shots-seed.mjs), animations are off, and what changes by
// itself (the version number, map tiles from the internet) is neutralised, so two runs of the same code give the same pixels.
import { test, expect } from "@playwright/test";
import pg from "pg";
import { SHOTS_PASSWORD, SHOTS_USERS } from "./shots-seed.mjs";

const NOW = new Date(process.env.SHOTS_NOW || "2026-11-07T07:00:00Z");
const ROLES = (process.env.SHOTS_ROLES || "admin,sales_manager").split(",");
const MODES = (process.env.SHOTS_MODES || "p390-hy-light,p390-en-dark,p440-hy-light,d1440-hy-light").split(",").map((id) => {
  const [, kind, w, lang, theme] = /^([pd])(\d+)-(hy|en)-(light|dark)$/.exec(id);
  const phone = kind === "p";
  return { id, width: Number(w), height: phone ? (Number(w) >= 440 ? 956 : 844) : 900, lang, theme, phone };
});
// a 1x1 light grey PNG, stretched to every map tile
const TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48eotAAV9AsAn2vxOAAAAAElFTkSuQmCC", "base64");
// Each tile address gets its own byte size (padding after the image's end, which browsers ignore): the Map treats several tiles of the
// same size as a provider's "blocked" notice and switches to its error state.
function tile(url) {
  let h = 0;
  for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) % 100003;
  return Buffer.concat([TILE, Buffer.alloc(h % 4093)]);
}
const ORIGIN = `http://127.0.0.1:${process.env.E2E_PORT ?? "3401"}`;

async function customerIds() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query("SELECT erp_customer_id, id FROM customers WHERE erp_customer_id LIKE 'C2%'");
    return Object.fromEntries(rows.map((r) => [r.erp_customer_id, r.id]));
  } finally {
    await db.end();
  }
}

// The screens of each role: [picture name, how to get there]. The sheets are opened on top of the screen before them.
function screens(role, ids) {
  const own = ids.C2000; // the rep's gold customer with debt, visits, orders and a payment
  const go = (hash) => async (page) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
  };
  const list = [
    ["home", go("#/dashboard")],
    ["activity", go("#/activity")],
    ["map", go("#/map")],
    ["customers", go("#/customers")],
    ["orders", go("#/orders")],
    ["tasks", go("#/tasks")],
    ["notifications", go("#/notifications")],
    ["payments", go("#/payments")],
    ["payment-entry", async (page) => {
      await page.locator("#payments-new-btn").click();
      await page.locator("#payment-pick-customer").click();
      await page.locator("#payment-customer-search").fill("C2000");
      await page.locator(`[data-customer-id="${own}"]`).first().click();
      await page.locator("#payment-amount-input").fill("25000");
      await page.locator("#payment-amount-input").blur();
    }],
    ["customer-card", go(`#/customers/${own}`)],
    ["new-order", go(`#/orders/new/${own}`)],
    ["your-order-sheet", async (page) => {
      await page.locator('[data-chip="Castrol"]').first().click();
      const list = page.locator("#order-product-list");
      await list.locator('[data-action="add"]').first().click();
      await list.locator('[data-action="add"]').nth(2).click();
      await page.locator("#order-cart-bar").click();
    }],
    ["settings", go("#/settings")],
  ];
  if (role === "admin") list.splice(7, 0, ["debt-balances", go("#/debt-balances")], ["team-performance", go("#/team-performance")]);
  return list;
}

// Waits until the screen is drawn and still: no request in flight, no skeleton, fonts loaded.
async function settle(page) {
  // the mouse rests in a corner: a hover card (desktop) under the last click is not part of the screen
  await page.mouse.move(0, 0).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".skeleton-bar, .ops-skeleton, .popup-fact-skeleton, .fuel-skeleton") && document.fonts.status === "loaded", null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.waitForLoadState("networkidle").catch(() => {});
  // the version number changes with every release, and its LENGTH too: the same text on both sides
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (/\b1\.\d{3}\.\d+\b/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\b1\.\d{3}\.\d+\b/g, "1.000.0");
    }
  });
}

for (const role of ROLES) {
  for (const mode of MODES) {
    test(`${role} ${mode.id}`, async ({ browser }) => {
      const ids = await customerIds();
      const context = await browser.newContext({
        baseURL: ORIGIN,
        viewport: { width: mode.width, height: mode.height },
        isMobile: mode.phone,
        hasTouch: mode.phone,
        deviceScaleFactor: mode.phone ? 2 : 1,
        colorScheme: mode.theme,
        reducedMotion: "reduce",
        timezoneId: "Asia/Yerevan",
        locale: mode.lang === "hy" ? "hy-AM" : "en-US",
        serviceWorkers: "block", // the worker's update check and caching are not what is pictured; without it every load is the same
        extraHTTPHeaders: { "x-e2e-rate-limit-bypass": process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass" },
      });
      // nothing from the internet: a map tile gets the same plain tile on both sides (a failed tile makes the Map show its
      // "couldn't load" state), anything else is refused
      await context.route((url) => url.origin !== ORIGIN, (route) =>
        /\.png(\?|$)/.test(route.request().url()) ? route.fulfill({ contentType: "image/png", body: tile(route.request().url()) }) : route.abort());
      await context.addInitScript(([lang, theme]) => {
        try {
          localStorage.setItem("fieldvisits_lang", lang);
          localStorage.setItem("fieldvisits_theme", theme);
          localStorage.setItem("fieldvisits_om_hint", "1"); // the customer card's one-time tip comes on a timer: never part of a picture
        } catch { /* ignore */ }
      }, [mode.lang, mode.theme]);
      const page = await context.newPage();
      page.setDefaultTimeout(8000); // a step that cannot be done fails that picture, not the whole run
      await page.clock.setFixedTime(NOW);
      await page.goto("/");
      await page.locator('input[name="email"]').fill(SHOTS_USERS[role]);
      await page.locator('input[name="password"]').fill(SHOTS_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await expect(page.locator("#top-bar")).toBeVisible({ timeout: 15_000 });

      const failures = [];
      for (const [name, open] of screens(role, ids)) {
        try {
          await open(page);
        } catch (e) {
          failures.push(`${name}: could not open (${e.message.split("\n")[0]})`);
          continue;
        }
        await settle(page);
        const mask = [page.locator("time")];
        try {
          await expect(page).toHaveScreenshot(`${role}-${mode.id}-${name}.png`, { fullPage: !page.url().includes("/map"), mask });
        } catch (e) {
          failures.push(`${name}: ${e.message.split("\n").filter((l) => /pixels|different|size|Timeout/i.test(l))[0]?.trim() || e.message.split("\n")[0]}`);
        }
        // a sheet left open: closed before the next screen
        if (["payment-entry", "your-order-sheet"].includes(name)) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(200);
        }
      }
      await context.close();
      expect(failures, "changed screens (diff images: server/test-results-shots)").toEqual([]);
    });
  }
}
