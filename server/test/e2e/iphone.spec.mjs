import http from "node:http";
import { test, expect, loginViaUi, TEST_PASSWORD } from "./fixtures.mjs";

// The iPhone checks (project "iphone-webkit" = Safari's engine on an iPhone screen; owner 2026-10-29: "catch iPhone-only slowdowns before
// release"). Safari differs from Chrome where it hurt before: Cache Storage that slows every launch (1.468.0), the page clock that starts
// after the worker, service-worker offline start, script features Safari lacks. Every test here is tagged @iphone; they run in Chrome too.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("without the worker, map tiles answered locally", () => {
  // Safari reports every failed tile download as a page error; the test must not depend on the internet. Without the worker so that the
  // page's own routes see the tile requests.
  test.use({ serviceWorkers: "block" });
  test("@iphone a rep opens the app: Home and every main tab draw, with no script error", async ({ page, fixtures }) => {
    await page.route(/tile\.openstreetmap\.org|maps\.wikimedia\.org/, (r) => r.fulfill({ status: 200, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: PNG }));
    const errors = [];
    // Safari also reports a blocked or failed download (a tile host the test network cannot reach) as a page error: that is the network,
    // not a script error, and the map shows its own retry for it
    page.on("pageerror", (err) => {
      if (!/due to access control checks|^TypeError: Load failed|Failed to load resource|\.png\.?$/.test(err.message)) errors.push(err.message);
    });
    const rep = await fixtures.createUser("sales_manager");
    await loginViaUi(page, rep.email);
    for (const hash of ["#/dashboard", "#/customers", "#/orders", "#/activity", "#/map", "#/settings"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator("#top-bar"), hash).toBeVisible();
      await expect(page.locator("#app > *").first(), hash).toBeVisible();
      await expect(page.locator(".render-failed"), hash).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});

const controlled = (page) => page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 20000 });
const lastLaunch = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("fv_launch_timings") || "[]")[0] || {});

test("@iphone a launch records every stage, counted from the service worker's start", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  await controlled(page).catch(() => page.reload().then(() => controlled(page)));
  await page.reload();
  await expect.poll(async () => (await lastLaunch(page)).found != null, { timeout: 10000 }).toBe(true);
  await expect.poll(async () => (await lastLaunch(page)).screen != null, { timeout: 10000 }).toBe(true);
  const e = await lastLaunch(page);
  expect(e).toMatchObject({ sw: 1, woke: 0, type: "reload" });
  expect(e.pre).toBeGreaterThanOrEqual(0);
  expect(e.fp).not.toBeNull(); // Safari reports first-contentful-paint only: the record falls back to it
  expect(e.screen).toBeGreaterThanOrEqual(e.ready);
});

// A real loss of network for the app's address: the page is served through a small relay in front of the test server, and the relay is
// then shut down (connection refused, as on a phone without signal). The test tool's own "offline" switch cannot be used in Safari's
// engine: it fails every page load there, even one the service worker would answer.
async function startRelay(targetPort) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const up = http.request({ host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(resolve);
    }),
  };
}

test("@iphone the app opens without network after the first visit", async ({ page, fixtures, baseURL }) => {
  test.setTimeout(60_000); // login, the worker taking control, two loads: over 30 s on a busy machine (local CI runs everything at once)
  const relay = await startRelay(Number(new URL(baseURL).port));
  const rep = await fixtures.createUser("sales_manager");
  await page.goto(`${relay.url}/`);
  await page.locator('input[name="email"]').fill(rep.email);
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("#top-bar")).toBeVisible({ timeout: 10000 });
  await controlled(page).catch(() => page.reload().then(() => controlled(page)));
  await page.goto(`${relay.url}/#/dashboard`);
  await expect(page.locator("#top-bar")).toBeVisible();
  await page.waitForTimeout(1500); // the screens' data lands in the list caches
  await relay.stop();
  await page.reload(); // a real new load (going to the same address with only a #hash does not reload in Chrome)
  await expect(page.locator("#top-bar")).toBeVisible({ timeout: 15000 });
  // still signed in once the failed session check has come back (it used to sign out: the login form replaced Home)
  await page.waitForTimeout(2000);
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
  await expect(page.locator("#top-bar")).toBeVisible();
  await expect(page.locator("#app > *").first()).toBeVisible();
  await expect(page.locator(".render-failed")).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(localStorage.getItem("fieldvisits_cached_user")))).toBe(true);
});

test("@iphone the app's file store holds only app files: no map tiles in Cache Storage", async ({ page, fixtures }) => {
  // On iPhone every Cache Storage entry slows every launch (1.468.0): bulk such as map tiles lives in IndexedDB.
  const admin = await fixtures.createUser("admin");
  await loginViaUi(page, admin.email);
  await controlled(page).catch(() => page.reload().then(() => controlled(page)));
  await page.goto("/#/map");
  await expect(page.locator("#leaflet-map")).toBeVisible();
  await page.waitForTimeout(2500);
  const store = await page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => r.url);
    return out;
  });
  const names = Object.keys(store);
  expect(names.every((n) => /^field-visits-v\d+(-runtime)?$/.test(n)), names.join(", ")).toBe(true);
  const urls = Object.values(store).flat();
  expect(urls.filter((u) => /tile\.openstreetmap\.org|maps\.wikimedia\.org/.test(u))).toEqual([]);
  expect(Object.entries(store).filter(([n]) => n.endsWith("-runtime")).flatMap(([, u]) => u).length).toBeLessThanOrEqual(150);
});
