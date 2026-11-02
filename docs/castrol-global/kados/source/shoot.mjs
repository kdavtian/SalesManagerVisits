// KAD OS deck screenshots from a LOCAL demo copy of the app (never production): English UI, iPhone 390x844 @3x, light mode.
// Every screen is checked before it is kept: no Armenian text, no translation keys, no "Excel" / "import" / "sync", not empty.
//   DECK_BYPASS=deck DECK_PASSWORD=... node shoot.mjs [scene]      (see ../../README.md)
import { tileSvg } from "../../source/tiles.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const BASE = process.env.DECK_BASE ?? "http://127.0.0.1:3201";
const PASSWORD = process.env.DECK_PASSWORD;
if (!PASSWORD) { console.error("Set DECK_PASSWORD (the demo password used when seeding)."); process.exit(2); }
const OUT = new URL("../screenshots/raw/", import.meta.url).pathname;
const only = process.argv[2];
const browser = await chromium.launch();
const BAD = [/[԰-֏]/, /excel/i, /\bimport/i, /\bsync/i, /\bundefined\b/, /\bNaN\b/, /\b[a-z]+_[a-z]+(_[a-z]+)*\b/];
let rejected = 0;

export async function session(email, { geo = true, video } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: video ? 2 : 3, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-US",
    timezoneId: "Asia/Yerevan", serviceWorkers: "block",
    extraHTTPHeaders: process.env.DECK_BYPASS ? { "x-e2e-rate-limit-bypass": process.env.DECK_BYPASS } : {},
    geolocation: geo ? { latitude: 40.16072, longitude: 44.45568, accuracy: 12 } : undefined, permissions: geo ? ["geolocation"] : [],
    recordVideo: video ? { dir: video, size: { width: 390, height: 844 } } : undefined,
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
  return { ctx, page };
}
export const go = async (page, hash) => { await page.goto(BASE + "/" + hash); await page.reload(); await page.waitForTimeout(3000); };
export const tap = async (page, sel) => { await page.locator(sel).first().click({ timeout: 5000 }); await page.waitForTimeout(1000); };
export const scrollDown = async (page, y) => {
  await page.evaluate((y) => { for (const el of [document.scrollingElement, ...document.querySelectorAll("main, #app, .app-main")]) if (el && el.scrollHeight > el.clientHeight + 10) el.scrollTop += y; }, y);
  await page.waitForTimeout(600);
};
async function shot(page, name, { wait = 1200, allowSparse = false } = {}) {
  await page.waitForTimeout(wait);
  const visible = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; const t = n.textContent.trim(); if (!t) continue;
      const el = n.parentElement; if (!el || el.closest("[hidden], script, style")) continue;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      const bar = document.querySelector(".topbar, header")?.getBoundingClientRect().bottom ?? 0; const inBar = el.closest(".topbar, header");
      if (r.width && r.height && (inBar ? r.bottom > 0 : r.bottom > bar + 2) && r.top < innerHeight && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0) out.push(t);
    }
    return out.join(" | ");
  });
  const hits = BAD.map((re) => visible.match(re)?.[0]).filter(Boolean);
  if (visible.length < 200 && !allowSparse) hits.push("looks empty");
  await page.screenshot({ path: OUT + name + ".png" });
  if (hits.length) { rejected++; console.log("REJECT", name, hits); } else console.log("ok", name);
}

const SCENES = {
  ceo: async (page) => {
    await go(page, "#/dashboard"); await shot(page, "home_ceo");
    await go(page, "#/map"); await shot(page, "map", { wait: 3000, allowSparse: true });
    await page.locator(".leaflet-marker-icon").nth(8).click({ force: true }); await shot(page, "map_popup", { allowSparse: true });
    await go(page, "#/customers"); await shot(page, "customers");
    await tap(page, '[data-filter-btn="assignment"]'); await shot(page, "filter_assignment");
    await go(page, "#/customers"); await tap(page, '[data-filter-btn="region"]'); await shot(page, "filter_region");
    await go(page, "#/customers/16"); await shot(page, "customer");
    await scrollDown(page, 560); await shot(page, "customer_more");
    await go(page, "#/customers/16"); await tap(page, '[data-stat="last-order"]'); await shot(page, "last_order");
    await go(page, "#/customers/16"); await tap(page, '[data-stat="debt"]'); await shot(page, "debt_sheet");
    await go(page, "#/customers/5"); await scrollDown(page, 560); await shot(page, "potential_card");
    await go(page, "#/orders"); await shot(page, "orders");
    await go(page, "#/company-dashboard"); await page.locator('button:has-text("This quarter")').first().click().catch(() => {}); await shot(page, "dashboard", { wait: 2500 });
    await go(page, "#/reports"); await shot(page, "reports");
  },
  rep: async (page) => {
    await go(page, "#/dashboard"); await shot(page, "home_rep");
    await go(page, "#/checkin/16"); await page.waitForTimeout(3000); await shot(page, "checkin");
    await tap(page, 'label.outcome-chip:has(input[value="order_placed"])'); await tap(page, 'label.outcome-chip:has(input[value="assortment_check"])'); await shot(page, "checkin_outcome");
    await tap(page, 'button:has-text("KAD products")');
    for (const label of ["Available", "Full range"]) await page.locator(`.sheet label:has-text("${label}"), .sheet button:has-text("${label}")`).first().click();
    await page.screenshot({ path: OUT + "shelf.png" }); console.log("ok shelf (cropped to the Castrol column later)");
    await go(page, "#/checkin/16"); await page.waitForTimeout(3000); await tap(page, 'button:has-text("Competitors")');
    for (const label of ["Mobil", "Shell"]) await page.locator(`.sheet label:has-text("${label}")`).first().click();
    await shot(page, "competitors");
    await go(page, "#/checkin/13"); await page.waitForTimeout(4000); await shot(page, "checkin_far");
    await go(page, "#/orders/new/16"); await page.waitForTimeout(2000); await shot(page, "order_frequent");
    await tap(page, 'button:has-text("Castrol")');
    const add = page.locator('button:text-is("Add")');
    for (let i = 0; i < 4; i++) { await add.nth(i).click(); await page.waitForTimeout(400); }
    await shot(page, "order");
    await tap(page, "#order-cart-bar"); await shot(page, "order_sheet", { wait: 1500 });
    await scrollDown(page, 600); await shot(page, "order_terms");
    await go(page, "#/tasks"); await shot(page, "tasks");
  },
  wh: async (page) => {
    await go(page, "#/wh-home"); await shot(page, "wh_home");
    await go(page, "#/wh-pack"); await shot(page, "wh_pack");
    await go(page, "#/stock-count"); await shot(page, "stock_count");
  },
  driver: async (page) => {
    await go(page, "#/driver-home"); await shot(page, "driver_home");
    await go(page, "#/delivery"); await shot(page, "route", { wait: 2500 });
  },
};
const USERS = { ceo: "ceo@kad.demo", rep: "aram@kad.demo", wh: "wh@kad.demo", driver: "driver@kad.demo" };
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  for (const [key, run] of Object.entries(SCENES)) {
    if (only && only !== key) continue;
    const { ctx, page } = await session(USERS[key]);
    try { await run(page); } catch (e) { console.log("FAILED", key, e.message); }
    await ctx.close();
  }
  await browser.close();
  console.log(rejected ? `${rejected} screen(s) rejected` : "all screens passed the checks");
}
export { browser };
