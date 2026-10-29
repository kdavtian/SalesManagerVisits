import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-26 ("takes like 5 seconds to open the app, white screen"): each launch leaves its timings on the phone and Settings > About shows them,
// so a slow start can be measured on the phone itself instead of guessed at. 2026-10-29 ("measure from tap on app icon to load"): the clock starts
// when the service worker starts for the launch (Safari starts the page's own clock only after the worker handed over the start page).
test("Settings > About lists how long the launches took, counted from the worker's start", async ({ page, fixtures }) => {
  const manager = await fixtures.createUser("sales_manager");
  await loginViaUi(page, manager.email);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15000 }).toBe(true);
  await page.reload(); // a launch served by the worker
  const last = () => page.evaluate(() => JSON.parse(localStorage.getItem("fv_launch_timings") || "[]")[0] || {});
  await expect.poll(async () => (await last()).found != null, { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await last()).screen != null, { timeout: 10000 }).toBe(true);
  const e = await last();
  expect(e.sw).toBe(1);
  expect(e.pre).toBeGreaterThanOrEqual(0);
  expect(e.screen).toBeGreaterThanOrEqual(e.ready);
  expect(e.type).toBe("reload");
  expect(e.woke).toBe(0); // the worker was already running (installed by the first page), so the clock starts at the start-page request
  expect(e.found).toBeLessThan(2000);

  await page.goto("/#/settings?section=p-about");
  const row = page.locator("#row-launch-speed");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/launch-speed-row.png` });
  await expect(row.locator(".settings-row-value")).toHaveText(/\d+\.\d s/);
  await row.click();
  const popup = page.locator(".info-popup");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/launch-speed-popup.png` });
  await expect(popup).toContainText("From opening");
  await expect(popup).toContainText("Start page found");
  await expect(popup).toContainText("White screen ended");
  await expect(popup).toContainText("First screen");
  await expect(popup.locator("p").first()).toContainText(/v1\.\d+\.\d+/);
});

// Map tiles live in IndexedDB, not Cache Storage: on iPhone every Cache Storage entry slows every launch (sw.js, TILE_DB).
test("a map tile is kept in the tile store and shown from it offline", async ({ page, context, fixtures }) => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let served = 0;
  await context.route(/tile\.openstreetmap\.org\//, (r) => {
    served++;
    return r.fulfill({ status: 200, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: PNG });
  });
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 15000 }).toBe(true);
  const url = "https://a.tile.openstreetmap.org/9/310/190.png";
  expect(await page.evaluate((u) => fetch(u).then((r) => r.status), url)).toBe(200);
  const stored = () =>
    page.evaluate(
      (u) =>
        new Promise((resolve) => {
          const open = indexedDB.open("field-visits-tiles");
          open.onsuccess = () => {
            const get = open.result.transaction("tiles").objectStore("tiles").get(u);
            get.onsuccess = () => resolve(Boolean(get.result));
            get.onerror = () => resolve(false);
          };
          open.onerror = () => resolve(false);
        }),
      url
    );
  await expect.poll(stored).toBe(true);
  expect(await page.evaluate(() => caches.keys())).not.toContain("field-visits-tiles-v5");

  // the network is gone: the stored copy answers, and the tile server is not asked again
  const before = served;
  await context.unroute(/tile\.openstreetmap\.org\//);
  await context.route(/tile\.openstreetmap\.org\//, (r) => r.abort());
  const again = await page.evaluate((u) => fetch(u).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), size: (await r.blob()).size })), url);
  expect(again).toEqual({ status: 200, type: "image/png", size: PNG.length });
  expect(served).toBe(before);
});
