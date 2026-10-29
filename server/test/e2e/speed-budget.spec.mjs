import { test, expect, loginViaUi } from "./fixtures.mjs";

// Speed budget for the first start (docs/architecture-roadmap.md step 12): a rep's first open of the app on a slow phone, nothing
// cached (no service worker, no browser cache), 1.6 Mbit/s with 150 ms latency and the CPU slowed 4x, in Armenian. Fails when the
// app gets slower or heavier than the budgets below, so a slowdown is caught before release instead of on a phone.
//
// It measures the deploy build (CLIENT_BUILD=1: CI, local-ci.sh --e2e); the source files are ~100 separate modules and are not what
// phones get. Chrome only (the slow network and CPU come from Chrome's DevTools protocol). When a change legitimately costs speed,
// raise the budget here AND in the roadmap's step 12 table, with the reason.
export const BUDGET = {
  homeMs: 6000, // Home drawn (measured 4.4 s on a fast computer, step 10)
  firstPaintMs: 3000, // end of the white screen (2.1 s)
  scriptKB: 700, // scripts downloaded before Home, compressed (314 KB)
  blockingFiles: 20, // scripts + stylesheets downloaded before the first paint (12; the source files: ~80)
};
const RUNS = 3;
// the same login rate-limit bypass header playwright.config.mjs sends on every request (this test opens its own browser profiles)
const BYPASS = { "x-e2e-rate-limit-bypass": process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass" };

test("@smoke first start on a slow phone stays within the speed budget", async ({ page, context, fixtures, browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "the slow network and CPU need Chrome's DevTools protocol");
  test.skip(process.env.CLIENT_BUILD !== "1", "measures the deploy build (CLIENT_BUILD=1)");
  test.setTimeout(180_000);
  const rep = await fixtures.createUser("sales_manager");
  await loginViaUi(page, rep.email);
  const cookies = await context.cookies();
  const runs = [];
  for (let r = 0; r < RUNS; r += 1) {
    // a fresh browser profile each time: nothing cached, no service worker
    const cold = await browser.newContext({ baseURL, serviceWorkers: "block", extraHTTPHeaders: BYPASS });
    await cold.addCookies(cookies);
    await cold.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const p = await cold.newPage();
    const cdp = await cold.newCDPSession(p);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const started = Date.now();
    await p.goto("/#/dashboard");
    await p.locator(".quick-actions-grid").first().waitFor({ timeout: 60_000 });
    const homeMs = Date.now() - started;
    const facts = await p.evaluate(() => {
      const now = performance.now();
      const firstPaint = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? now;
      const files = performance.getEntriesByType("resource").map((e) => ({ path: new URL(e.name).pathname, start: e.startTime, end: e.responseEnd, bytes: e.transferSize }));
      const isScript = (f) => f.path.endsWith(".js");
      return {
        firstPaintMs: Math.round(firstPaint),
        scriptKB: Math.round(files.filter((f) => isScript(f) && f.start < now).reduce((sum, f) => sum + f.bytes, 0) / 1024),
        // the files the first paint waited for: downloaded before it (the texts and screens loaded in idle time right after start
        // are already requested by then, but the paint does not wait for them)
        blockingFiles: files.filter((f) => (isScript(f) || f.path.endsWith(".css")) && f.end <= firstPaint).length,
      };
    });
    runs.push({ homeMs, ...facts });
    await cold.close();
  }
  const median = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const result = Object.fromEntries(Object.keys(BUDGET).map((key) => [key, median(key)]));
  console.log(`speed budget, first start (median of ${RUNS}): ${JSON.stringify(result)}; runs ${JSON.stringify(runs)}`);
  for (const [key, limit] of Object.entries(BUDGET)) expect(result[key], `${key}: ${result[key]} (budget ${limit})`).toBeLessThanOrEqual(limit);
});
