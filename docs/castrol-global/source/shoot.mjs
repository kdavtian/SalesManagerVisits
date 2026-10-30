// Takes the app screenshots for the Castrol Global deck from a LOCAL demo copy of the app (never production).
// English UI, iPhone 390x844 @3x, light mode, made-up demo data (see ../README.md for the full recipe).
//   node shoot.mjs [only]     only = map | customer | debt | dashboard | team | vaghinak | reports | checkin | vaghinak_rep | tasks | order
// Env: DECK_BASE (default http://127.0.0.1:3201), DECK_PASSWORD (the demo users' password), PLAYWRIGHT (path to playwright/index.mjs).
import { tileSvg } from "./tiles.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const BASE = process.env.DECK_BASE ?? "http://127.0.0.1:3201";
const PASSWORD = process.env.DECK_PASSWORD;
if (!PASSWORD) { console.error("Set DECK_PASSWORD (the demo password used when seeding)."); process.exit(2); }
const OUT = new URL("../screenshots/raw/", import.meta.url).pathname;
const only = process.argv[2];
const run = (n) => !only || only === n;
const browser = await chromium.launch();

async function session(email, geo) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US",
    timezoneId: "Asia/Yerevan", serviceWorkers: "block", geolocation: geo, permissions: geo ? ["geolocation"] : [],
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("fieldvisits_lang", "en");
      localStorage.setItem("fieldvisits_theme", "light");
      localStorage.setItem("fieldvisits_install_dismissed_at", String(Date.now()));
      localStorage.setItem("fieldvisits_om_hint", "1");
    } catch {}
  });
  // Map tiles: neutral made-up streets drawn locally (no outside traffic, no real map data needed).
  await ctx.route(/openstreetmap|cartocdn|arcgisonline|wikimedia/, (route) => {
    const m = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png/);
    if (!m) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: tileSvg(+m[1], +m[2], +m[3]) });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await page.goto(BASE + "/");
  await page.fill("#login-form input[name=email]", email);
  await page.fill("#login-form input[name=password]", PASSWORD);
  await page.click("#login-form button[type=submit]");
  await page.waitForTimeout(2500);
  return page;
}
const go = (page, hash) => page.goto(BASE + "/" + hash);
const shot = async (page, name, wait = 1500) => { await page.waitForTimeout(wait); await page.screenshot({ path: OUT + name + ".png" }); console.log("saved", name); };

// Management view (demo CEO)
{
  const page = await session("ceo@kad.demo");
  await page.evaluate(() => {
    localStorage.setItem("fieldvisits_map_cluster", "off");
    localStorage.setItem("fv_map_view", JSON.stringify({ center: [40.192, 44.505], zoom: 13, at: Date.now() }));
  });
  if (run("map")) { await go(page, "#/map"); await shot(page, "map", 4000); }
  if (run("customer")) { await go(page, "#/customers/16"); await shot(page, "customer", 3000); }
  if (run("debt")) { await go(page, "#/debt-balances"); await shot(page, "debt", 3000); }
  if (run("dashboard")) { await go(page, "#/company-dashboard"); await shot(page, "dashboard", 3000); }
  if (run("team")) { await go(page, "#/team-performance"); await shot(page, "team", 3000); }
  if (run("vaghinak")) { await go(page, "#/vaghinak"); await shot(page, "vaghinak", 3000); }
  if (run("reports")) { await go(page, "#/reports"); await shot(page, "reports", 3000); }
}
// Field rep (demo "Rep A"), standing at demo customer 16
{
  const page = await session("aram@kad.demo", { latitude: 40.16072, longitude: 44.45568, accuracy: 12 });
  if (run("checkin")) {
    await go(page, "#/checkin/16"); await page.waitForTimeout(5000);
    await shot(page, "checkin", 500);
    await page.locator('button:has-text("KAD products")').first().click();
    await page.waitForTimeout(800);
    for (const label of ["Available", "Full range"]) await page.locator(`.sheet label:has-text("${label}"), .sheet button:has-text("${label}")`).first().click();
    await shot(page, "shelf", 1000);
  }
  if (run("vaghinak_rep")) { await go(page, "#/vaghinak"); await shot(page, "vaghinak_rep", 3000); }
  if (run("tasks")) { await go(page, "#/tasks"); await shot(page, "tasks", 3000); }
  if (run("order")) {
    await go(page, "#/orders/new/16"); await page.waitForTimeout(3000);
    await page.locator('button:has-text("Castrol")').first().click(); await page.waitForTimeout(1200);
    const add = page.locator('button:text-is("Add")');
    for (let i = 0; i < 4; i++) { await add.nth(i).click(); await page.waitForTimeout(400); }
    await shot(page, "order");
  }
}
await browser.close();
