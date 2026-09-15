import { defineConfig, devices } from "@playwright/test";

// Browser E2E suite (step 4 of the stabilization plan) -- separate from
// the node:test integration suite (test/integration), which never opens a
// real browser. Runs against a real instance of this app's own server
// (webServer below starts it), driven by an actual Chromium, so it catches
// what API-level tests structurally can't: broken client JS, a route that
// 404s from the browser's own navigation, a form that doesn't actually
// submit, GPS permission handling, service-worker update behavior.
//
// A "@smoke" tag on a test's title marks it as part of the fast subset run
// on every PR (see package.json's test:e2e:smoke and the CI workflow) --
// the full suite (every spec here) runs nightly instead, since a real
// browser + service worker lifecycle is inherently slower than the API
// suite and not everything needs to gate every single PR.
// The login route's IP-scoped rate limiter (10 real POSTs/15min, see
// src/routes/auth.js) is sized for a real attacker, not this suite's own
// legitimate real logins -- most specs log in at least once through the
// actual form, several twice for a multi-identity flow, so the full suite
// exceeds the budget well before it's done. This token, sent as a header on
// every request (below) and matched server-side only when this exact env
// var is set, bypasses that limiter for this run only; it's never set
// outside the E2E webServer, so production and the node:test integration
// suite (which tests this same limiter's real behavior) are unaffected.
const E2E_RATE_LIMIT_BYPASS_TOKEN = process.env.E2E_RATE_LIMIT_BYPASS_TOKEN ?? "e2e-suite-local-bypass";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // One worker in CI -- every spec seeds/tears down its own rows via
  // fixtures.mjs against the SAME database (no per-worker DB isolation
  // the way node:test's integration suite doesn't need either, since that
  // one also shares one Postgres per CI job), and several specs assume a
  // clean check-in/order state per customer they create. Parallel workers
  // locally are fine (fixtures use unique per-row identifiers), just not
  // guaranteed safe enough to default to in CI.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: { "x-e2e-rate-limit-bypass": E2E_RATE_LIMIT_BYPASS_TOKEN },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Boots the real app against DATABASE_URL (set by whoever runs this --
  // see package.json's test:e2e script and the CI workflow, both of which
  // point it at a disposable Postgres, never at anything with real data).
  // Skipped when E2E_BASE_URL is set (a server the caller already started,
  // e.g. for local iteration against a long-running dev instance).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node src/index.js",
        url: "http://127.0.0.1:3101/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: {
          PORT: "3101",
          NODE_ENV: "test",
          E2E_RATE_LIMIT_BYPASS_TOKEN,
        },
      },
});
