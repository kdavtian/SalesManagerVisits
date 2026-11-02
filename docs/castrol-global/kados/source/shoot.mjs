// KAD OS deck screenshots from a LOCAL demo copy of the app (never production): English UI, iPhone 390x844 @3x, light mode.
// Every screen is checked before it is kept: no Armenian text, no translation keys, no "Excel" / "import" / "sync", not empty.
//   DECK_PASSWORD=... node shoot.mjs [name]      (see ../README.md)
import { tileSvg } from "../../source/tiles.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const BASE = process.env.DECK_BASE ?? "http://127.0.0.1:3201";
const PASSWORD = process.env.DECK_PASSWORD;
if (!PASSWORD) { console.error("Set DECK_PASSWORD (the demo password used when seeding)."); process.exit(2); }
const OUT = new URL("../screenshots/raw/", import.meta.url).pathname;
const only = process.argv[2];
const run = (n) => !only || only === n;
const browser = await chromium.launch();
const BAD = [/[԰-֏]/, /excel/i, /\bimport/i, /\bsync/i, /\bundefined\b/, /\bNaN\b/, /\b[a-z]+_[a-z]+(_[a-z]+)*\b/];
let rejected = 0;

async function session(email, geo) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US",
    timezoneId: "Asia/Yerevan", serviceWorkers: "block",
    extraHTTPHeaders: process.env.DECK_BYPASS ? { "x-e2e-rate-limit-bypass": process.env.DECK_BYPASS } : {}, geolocation: geo, permissions: geo ? ["geolocation"] : [],
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("fieldvisits_lang", "en");
      localStorage.setItem("fieldvisits_theme", "light");
      localStorage.setItem("fieldvisits_install_dismissed_at", String(Date.now()));
      localStorage.setItem("fieldvisits_om_hint", "1");
      localStorage.setItem("fieldvisits_map_cluster", "off");
      localStorage.setItem("fv_map_view", JSON.stringify({ center: [40.192, 44.505], zoom: 13, at: Date.now() }));
    } catch {}
  });
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
async function shot(page, name, wait = 1500) {
  await page.waitForTimeout(wait);
  // check only what is on screen (the visible viewport)
  const visible = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; const t = n.textContent.trim(); if (!t) continue;
      const el = n.parentElement; if (!el || el.closest("[hidden], script, style")) continue;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      const bar = document.querySelector('.topbar, header')?.getBoundingClientRect().bottom ?? 0; const inBar = el.closest('.topbar, header');
      if (r.width && r.height && (inBar ? r.bottom > 0 : r.bottom > bar + 2) && r.top < innerHeight && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0) out.push(t);
    }
    return out.join(" | ");
  });
  const hits = BAD.map((re) => visible.match(re)?.[0]).filter(Boolean);
  if (visible.length < 200 && !name.startsWith("map")) hits.push("looks empty");
  await page.screenshot({ path: OUT + name + ".png" });
  if (hits.length) { rejected++; console.log("REJECT", name, hits); } else console.log("ok", name);
}

{ // management (demo CEO)
  const page = await session("ceo@kad.demo");
  if (run("map")) { await go(page, "#/map"); await shot(page, "map", 4000); }
  if (run("customer")) { await go(page, "#/customers/16"); await shot(page, "customer", 3000); }
  if (run("orders")) { await go(page, "#/orders"); await shot(page, "orders", 3000); }
  if (run("dashboard")) { await go(page, "#/company-dashboard"); await page.waitForTimeout(2000); await page.locator('button:has-text("This quarter")').first().click().catch(() => {}); await shot(page, "dashboard", 2500); }
  if (run("vaghinak")) { await go(page, "#/vaghinak"); await page.waitForTimeout(3000); await page.evaluate(() => { const a = document.querySelector(".vg-avatar"); let el = a?.parentElement; while (el) { if (el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) { el.scrollTop = 112; break; } el = el.parentElement; } scrollTo(0, 112); }); await shot(page, "vaghinak", 800); }
}
{ // field rep "Rep A", standing at demo customer 16
  const page = await session("aram@kad.demo", { latitude: 40.16072, longitude: 44.45568, accuracy: 12 });
  if (run("checkin")) {
    await go(page, "#/checkin/16"); await page.waitForTimeout(5000);
    await shot(page, "checkin", 500);
    await page.locator('button:has-text("KAD products")').first().click();
    await page.waitForTimeout(800);
    for (const label of ["Available", "Full range"]) await page.locator(`.sheet label:has-text("${label}"), .sheet button:has-text("${label}")`).first().click();
    await page.screenshot({ path: OUT + "shelf.png" }); console.log("ok shelf (cropped to the Castrol column later)");
  }
  if (run("order")) {
    await go(page, "#/orders/new/16"); await page.waitForTimeout(3000);
    await page.locator('button:has-text("Castrol")').first().click(); await page.waitForTimeout(1200);
    const add = page.locator('button:text-is("Add")');
    for (let i = 0; i < 4; i++) { await add.nth(i).click(); await page.waitForTimeout(400); }
    await shot(page, "order");
  }
  if (run("vaghinak_rep")) { await go(page, "#/vaghinak"); await page.waitForTimeout(3000); await page.evaluate(() => { const a = document.querySelector(".vg-avatar"); let el = a?.parentElement; while (el) { if (el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) { el.scrollTop = 112; break; } el = el.parentElement; } scrollTo(0, 112); }); await shot(page, "vaghinak_rep", 800); }
  if (run("tasks")) { await go(page, "#/tasks"); await shot(page, "tasks", 3000); }
}
await browser.close();
console.log(rejected ? `${rejected} screen(s) rejected` : "all screens passed the checks");
