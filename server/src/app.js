// The Express app itself, split out from index.js's process bootstrap
// (listen(), background interval jobs) so integration tests can import a
// real, fully-wired app and drive it over HTTP without also starting
// setInterval-based reminder jobs or binding a fixed port. index.js is now
// the thin "run this for real" entrypoint; this file is the "build the
// app" one. See test/integration/testServer.js for how tests use this.
import "dotenv/config";
// Express 5 (see package.json) catches a rejected promise from an async
// route handler natively and forwards it to the error-handling middleware
// below -- express-async-errors existed only to patch that behavior into
// Express 4 and is no longer needed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import { modulePreloadTags, useClientBuild } from "./system/modulePreload.js";
import { CLIENT_DIST_DIR } from "./shared/paths.js";
import { authRouter, meRouter } from "./system/routes/auth.js";
import { usersRouter } from "./team/routes/users.js";
import { customersRouter } from "./customers/routes/customers.js";
import { customerSocialRouter } from "./customers/routes/customerSocial.js";
import { checkinsRouter } from "./field/routes/checkins.js";
import { filesRouter } from "./customers/routes/files.js";
import { dashboardRouter } from "./reports/routes/dashboard.js";
import { settingsRouter } from "./system/routes/settings.js";
import { editRequestsRouter } from "./customers/routes/editRequests.js";
import { pinReviewRouter } from "./customers/routes/pinReview.js";
import { volumeReportRouter } from "./reports/routes/volumeReport.js";
import { locationsRouter } from "./field/routes/locations.js";
import { integrationRouter } from "./erp/routes/integration.js";
import { integrationAdminRouter } from "./erp/routes/integrationAdmin.js";
import { erpSyncRouter } from "./erp/routes/erpSync.js";
import { geocodeRouter } from "./customers/routes/geocode.js";
import { visitPlansRouter } from "./field/routes/visitPlans.js";
import { salesPerformanceRouter } from "./reports/routes/salesPerformance.js";
import { productsRouter } from "./products/routes/products.js";
import { productShortcutsRouter } from "./products/routes/productShortcuts.js";
import { productDetailsRouter } from "./products/routes/productDetails.js";
import { companyProfileRouter } from "./system/routes/companyProfile.js";
import { routeDistributionRouter } from "./field/routes/routeDistribution.js";
import { routePlanSetsRouter } from "./field/routes/routePlanSets.js";
import { ordersRouter } from "./orders/routes/orders.js";
import { orderMetaRouter } from "./orders/routes/orderMeta.js";
import { exportsRouter } from "./system/routes/exports.js";
import { pushRouter } from "./system/routes/push.js";
import { notificationSettingsRouter } from "./system/routes/notificationSettings.js";
import { notificationsRouter } from "./system/routes/notifications.js";
import { teamPerformanceRouter } from "./reports/routes/teamPerformance.js";
import { cashExpensesRouter } from "./money/routes/cashExpenses.js";
import { reportsRouter } from "./reports/routes/reports.js";
import { fuelRouter } from "./field/routes/fuel.js";
import { bizReportsRouter } from "./reports/routes/bizReports.js";
import { paymentsRouter } from "./money/routes/payments.js";
import { cashHandoffsRouter } from "./money/routes/cashHandoffs.js";
import { warehouseRouter } from "./orders/routes/warehouse.js";
import { deliveryRouter } from "./orders/routes/delivery.js";
import { stockCountRouter } from "./orders/routes/stockCount.js";
import { cashflowRouter } from "./money/routes/cashflow.js";
import { staffRouter } from "./team/routes/staff.js";
import { returnsRouter } from "./orders/routes/returns.js";
import { debtBalancesRouter } from "./money/routes/debtBalances.js";
import { dataQualityRouter } from "./system/routes/dataQuality.js";
import { systemHealthRouter } from "./system/routes/systemHealth.js";
import { salesRouter } from "./reports/routes/sales.js";
import { badgesRouter } from "./system/routes/badges.js";
import { calculatorLockRouter } from "./system/routes/calculatorLock.js";
import { lockdownRouter } from "./system/routes/lockdown.js";
import { lockdownGate } from "./middleware/lockdown.js";
import { requestTiming } from "./middleware/requestTiming.js";
import { requireCsrf } from "./middleware/csrf.js";
import { clientErrorsRouter } from "./system/routes/clientErrors.js";
import { bonusChallengesRouter } from "./bonus/routes/bonusChallenges.js";
import { bonusRewardClaimsRouter } from "./bonus/routes/bonusRewardClaims.js";
import { bonusSummaryRouter } from "./bonus/routes/bonusSummary.js";
import { tasksRouter } from "./team/routes/tasks.js";
import { wishesRouter } from "./orders/routes/wishes.js";
import { cashSheetsRouter } from "./money/routes/cashSheets.js";
import { vaghinakRouter } from "./team/routes/vaghinak.js";
import { antiFraudRouter } from "./money/routes/antiFraud.js";
import { expensesRouter } from "./money/routes/expenses.js";
import { placesRouter } from "./customers/routes/places.js";
import { askKadRouter } from "./team/routes/askKad.js";
import { partnerRouter } from "./orders/routes/partner.js";
import { appOrdersAdminRouter } from "./orders/routes/appOrdersAdmin.js";
import { opsControlRouter } from "./reports/routes/opsControl.js";
import { tableExportRouter } from "./system/routes/tableExport.js";
import { getCalculatorModeEnabled } from "./shared/settings.js";
import { requireAuth } from "./middleware/auth.js";
import { autoAssignSalesChannel } from "./customers/salesChannelAutofill.js";
import { normalizeCustomerPortfolio } from "./customers/customerChannelPolicy.js";
import { pool } from "./db/pool.js";
import { isTestRun } from "./utils/testRun.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error(
    "JWT_SECRET is missing or too short (must be at least 16 characters). Refusing to start."
  );
  process.exit(1);
}

if (!process.env.ERP_SYNC_KEY && !isTestRun) {
  console.warn(
    "ERP_SYNC_KEY is not set — the /api/erp-sync endpoint will reject all requests until it is."
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "..", "client", "public");
// The deploy build of the scripts (docs/architecture-roadmap.md step 10): the Docker image builds client/dist and runs with
// NODE_ENV=production; CI's browser tests ask for it with CLIENT_BUILD=1. Anywhere else (local runs, the server tests) the source files
// are served, so an old build left on a computer is never served in place of the code being edited.
const clientBuild = useClientBuild();

export const app = express();

app.set("trust proxy", 1);

// Every response through here is currently sent uncompressed -- CSS/JS/JSON
// gzipped for free at essentially no CPU cost, which matters most on the
// slow cellular connections this app already optimizes hard for elsewhere
// (see api.js's GET cache, the offline queue, etc.).
app.use(compression());

app.use(
  helmet({
    // helmet's default is "no-referrer", which strips the Referer from the
    // OpenStreetMap / Wikimedia tile requests. Their tile usage policies
    // require a valid Referer and they refuse (or replace with a placeholder
    // image) requests without one, which showed up as "The map couldn't load"
    // on desktop browsers. strict-origin-when-cross-origin is the browser
    // default: same-origin requests keep the full URL, cross-origin ones
    // (the tile hosts) get only this site's origin.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // CARTO (previously the primary map tile provider, referenced here
        // historically) now requires a paid API key for every tile request
        // and is no longer used anywhere in the client -- see
        // client/public/js/views/map.js's own TILE_URLS comment. OSM is the
        // primary now, Wikimedia the fallback; both need connect-src too,
        // not just img-src, since map.js/app.js prefetch tiles with a plain
        // fetch() (for the opt-in tile-cache-warming feature and idle
        // Armenia-region prewarming) in addition to Leaflet's own <img> tags.
        imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://maps.wikimedia.org"],
        connectSrc: ["'self'", "https://*.tile.openstreetmap.org", "https://maps.wikimedia.org"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // helmet adds upgrade-insecure-requests by default. Production keeps it; the test server (plain http://127.0.0.1) drops it,
        // because Safari's engine (the iPhone browser tests, project "iphone-webkit") obeys it even on 127.0.0.1 and then asks for
        // https://127.0.0.1, which fails every request. Chrome exempts 127.0.0.1 itself.
        ...(process.env.NODE_ENV === "test" ? { upgradeInsecureRequests: null } : {}),
      },
    },
  })
);
// Liveness only -- "the Node process is up and answering HTTP", nothing
// about its dependencies. What the Docker HEALTHCHECK and deploy.sh's
// verify-deployment.mjs actually want (see docs/monitoring.md).
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// Readiness -- also confirms Postgres is actually reachable, not just that
// the process started. Distinct from /api/health on purpose: a container
// can be "alive" (the process is running) while its one dependency is
// down (db container still starting, wrong credentials after a config
// change, connection pool exhausted) -- that's a real, distinguishable
// failure mode this app had no way to detect before. Registered ahead of
// lockdownGate/requireCsrf deliberately -- both also touch the database
// (lockdownGate queries app_settings on every request), so a check meant
// to diagnose "is the database reachable" can't sit behind middleware
// that itself breaks the same way DB is down, or the check never runs at
// all and a caller just sees a generic 500 instead of an honest "db down".
// A short query timeout so a hung Postgres doesn't hang this check itself.
app.get("/api/ready", async (req, res) => {
  try {
    await pool.query({ text: "SELECT 1", query_timeout: 3000 });
    res.json({ ok: true, db: "ok" });
  } catch (err) {
    res.status(503).json({ ok: false, db: "unreachable", error: err.message });
  }
});

app.use(cookieParser());
app.use(lockdownGate);
app.use(requestTiming);
app.use(requireCsrf);

app.use("/api/auth", express.json(), authRouter);
app.use("/api/me", express.json(), meRouter);
app.use("/api/users", express.json(), usersRouter);
app.post("/api/customers", express.json(), requireAuth, autoAssignSalesChannel, normalizeCustomerPortfolio);
app.use("/api/customers", express.json(), customersRouter);
app.use("/api/customer-social", express.json(), customerSocialRouter);
app.use("/api/checkins", checkinsRouter);
app.use("/api/files", express.json(), filesRouter);
app.use("/api/dashboard", express.json(), dashboardRouter);
app.use("/api/settings", express.json(), settingsRouter);
app.use("/api/edit-requests", express.json(), editRequestsRouter);
app.use("/api/pin-review", express.json(), pinReviewRouter);
app.use("/api/volume-report", volumeReportRouter);
app.use("/api/locations", express.json(), locationsRouter);
// A signed PDF from Lily arrives as the raw request body (<= 15 MB).
app.use("/api/integration/v1", express.raw({ type: "application/pdf", limit: "15mb" }), express.json({ limit: "2mb" }), integrationRouter);
app.use("/api/integration-tokens", express.json(), integrationAdminRouter);
app.use("/api/erp-sync", express.json({ limit: "25mb" }), erpSyncRouter);
app.use("/api/geocode", geocodeRouter);
app.use("/api/visit-plans", express.json(), visitPlansRouter);
app.use("/api/sales-performance", salesPerformanceRouter);
app.use("/api/products", express.json(), productShortcutsRouter, productDetailsRouter, productsRouter);
app.use("/api/company-profile", express.json(), companyProfileRouter);
app.use("/api/route-distribution", express.json(), routeDistributionRouter);
app.use("/api/route-plan-sets", express.json(), routePlanSetsRouter);
app.use("/api/orders", express.json(), ordersRouter);
app.use("/api/order-meta", express.json(), orderMetaRouter);
app.use("/api/exports", exportsRouter);
app.use("/api/push", express.json(), pushRouter);
app.use("/api/notification-settings", express.json(), notificationSettingsRouter);
app.use("/api/notifications", express.json(), notificationsRouter);
app.use("/api/team-performance", express.json(), teamPerformanceRouter);
app.use("/api/cash-expenses", express.json(), cashExpensesRouter);
app.use("/api/reports", express.json(), reportsRouter);
app.use("/api/fuel", express.json(), fuelRouter);
app.use("/api/biz-reports", express.json(), bizReportsRouter);
app.use("/api/payments", express.json(), paymentsRouter);
app.use("/api/cash-handoffs", express.json(), cashHandoffsRouter);
app.use("/api/warehouse", express.json(), warehouseRouter);
app.use("/api/delivery", express.json(), deliveryRouter);
app.use("/api/stock-count", express.json(), stockCountRouter);
app.use("/api/cashflow", express.json(), cashflowRouter);
app.use("/api/staff", express.json(), staffRouter);
app.use("/api/returns", express.json(), returnsRouter);
app.use("/api/debt-balances", express.json(), debtBalancesRouter);
app.use("/api/data-quality", express.json(), dataQualityRouter);
app.use("/api/system-health", systemHealthRouter);
app.use("/api/sales", express.json(), salesRouter);
app.use("/api/badges", badgesRouter);
app.use("/api/calculator-lock", express.json(), calculatorLockRouter);
app.use("/api/lockdown", express.json(), lockdownRouter);
app.use("/api/client-errors", express.json(), clientErrorsRouter);
app.use("/api/bonus-challenges", express.json(), bonusChallengesRouter);
app.use("/api/bonus-reward-claims", express.json(), bonusRewardClaimsRouter);
app.use("/api/bonus-summary", bonusSummaryRouter);
app.use("/api/tasks", express.json(), tasksRouter);
app.use("/api/wishes", express.json(), wishesRouter);
app.use("/api/cash-sheets", express.json(), cashSheetsRouter);
app.use("/api/vaghinak", express.json(), vaghinakRouter);
app.use("/api/anti-fraud", express.json(), antiFraudRouter);
app.use("/api/expenses", express.json(), expensesRouter);
app.use("/api/places", express.json(), placesRouter);
app.use("/api/ask-kad", express.json(), askKadRouter);
app.use("/api/partner", express.json(), partnerRouter);
app.use("/api/app-orders", express.json(), appOrdersAdminRouter);
app.use("/api/ops", express.json(), opsControlRouter);
app.use("/api/table-export", express.json({ limit: "8mb" }), tableExportRouter);

// The stylesheets are hand-edited source (comments, full indentation) --
// minifying here at request time, rather than as a separate build step,
// means the served bytes can never drift out of sync with the source the
// way CACHE_VERSION did (see CLAUDE.md): there's nothing to remember to
// rebuild, since every deploy already restarts the process. Cached in
// memory per file after the first request so the minify cost is paid once,
// not per request; skipped entirely outside production so editing a
// stylesheet locally shows up on the next reload without a restart.
const cssMinifyCache = new Map();
// A local `@import url("x.css");` is replaced by that file's text (css/app.css joins the boot stylesheets this way, step 9: one request
// instead of eleven before the first paint). Only plain relative names in the same folder tree; anything else stays an @import.
async function inlineCssImports(filePath, seen = new Set()) {
  seen.add(filePath);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parts = [];
  let last = 0;
  for (const m of raw.matchAll(/@import\s+url\(\s*["']?([\w./-]+\.css)["']?\s*\)\s*;/g)) {
    const target = path.resolve(path.dirname(filePath), m[1]);
    if (!target.startsWith(clientDir + path.sep) || seen.has(target)) continue;
    parts.push(raw.slice(last, m.index), await inlineCssImports(target, seen));
    last = m.index + m[0].length;
  }
  parts.push(raw.slice(last));
  return parts.join("");
}
app.get(/^\/css\/.*\.css$/, async (req, res, next) => {
  const filePath = path.join(clientDir, req.path);
  try {
    let minified = cssMinifyCache.get(filePath);
    if (!minified) {
      const { default: CleanCSS } = await import("clean-css");
      const raw = await inlineCssImports(filePath);
      minified = new CleanCSS({}).minify(raw).styles;
      if (process.env.NODE_ENV === "production") cssMinifyCache.set(filePath, minified);
    }
    res.type("css").send(minified);
  } catch {
    next();
  }
});

// index.html and manifest.json are excluded from static serving (index:
// false, and manifest.json is shadowed by the explicit route below) --
// both are generated per-request from the calculator-mode setting instead;
// everything else in client/public (icons included) still serves directly.
if (clientBuild) {
  app.use("/js", express.static(path.join(CLIENT_DIST_DIR, "js"), { index: false }));
  app.get("/sw.js", (req, res) => res.sendFile(path.join(CLIENT_DIST_DIR, "sw.js")));
}
app.use(express.static(clientDir, { index: false }));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

const indexHtmlPath = path.join(clientDir, "index.html");
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf8");
// Computed once at start-up from the client files themselves (see modulePreload.js).
const modulePreloadHtml = modulePreloadTags(clientDir, clientBuild);
const BOOT_SPLASH_HTML = '<div class="boot-splash" role="status" aria-label="Loading"><span class="boot-splash-spin"></span></div>';

const CALCULATOR_BRANDING = {
  title: "Calculator",
  themeColor: "#1c1c1e",
  manifest: "manifest.calculator.json",
  icon192: "icons/icon-192.png",
  appleTouchIcon: "icons/apple-touch-icon.png",
};
const REAL_APP_BRANDING = {
  title: "KAD Motors",
  themeColor: "#f6f7f9",
  manifest: "manifest.app.json",
  icon192: "icons/app/icon-192.png",
  appleTouchIcon: "icons/app/apple-touch-icon.png",
};

// The demo site (deploy/demo.sh, docs/demo-site.md) is a separate copy of the app with made-up data. It looks different where a person cannot
// miss it: another name on the home screen / in the app switcher / in the tab, and a purple status bar, so it is never mistaken for the real app.
const isDemoSite = () => process.env.DEMO_MODE === "1";
const DEMO_BRANDING = { title: "KAD Demo", themeColor: "#6d28d9" };

app.get("/manifest.json", async (req, res) => {
  if (isDemoSite()) {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(clientDir, "manifest.app.json"), "utf8"));
    Object.assign(manifest, { name: DEMO_BRANDING.title, short_name: DEMO_BRANDING.title, theme_color: DEMO_BRANDING.themeColor });
    res.set("Cache-Control", "no-store");
    res.type("application/manifest+json").send(JSON.stringify(manifest));
    return;
  }
  const calculatorModeEnabled = await getCalculatorModeEnabled();
  // no-store: this file's content depends on an admin setting that can
  // change at any time -- a browser or intermediary cache serving a stale
  // copy would mean a device stuck on the old icon/name after Calculator
  // Mode is toggled, the exact staleness this route exists to avoid. The
  // service worker's own fetch handler is already network-first for this
  // path, so this header is belt-and-suspenders for the HTTP cache layer
  // underneath it (and any proxy in between).
  res.set("Cache-Control", "no-store");
  res.sendFile(
    path.join(clientDir, calculatorModeEnabled ? "manifest.calculator.json" : "manifest.app.json")
  );
});

// A script, style, picture or font that does not exist is a real 404, never the app's own page with "200 OK" (owner, 2026-10-30: white screen after an
// update, Reload spinning for ever). A browser cannot run HTML as a script, and the service worker used to keep that answer under the file's
// address. `no-store`: nothing in between may keep the 404 either (the file can exist after the next deploy).
const ASSET_PATH = /^\/(?:js|css|icons|brand|fonts|vendor|assets)\/|\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|webmanifest)$/i;
app.get(ASSET_PATH, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(404).type("text/plain").send("Not found");
});

// A raw RegExp, not the string "*" -- Express 5's path-to-regexp no longer
// accepts a bare "*" (its named-wildcard replacement, "/*splat", requires
// at least one path segment after the slash and so wouldn't match the
// root path "/" itself, which this route must still serve). A RegExp
// bypasses that string-pattern parsing entirely and is matched directly,
// same approach already used above for the CSS route.
app.get(/.*/, async (req, res) => {
  // Read server-side (never fetched by the client) so the calculator
  // disguise's "touches no network before unlock" property holds whether
  // the feature is on or off -- see bootGate.js.
  const demoSite = isDemoSite();
  const calculatorModeEnabled = demoSite ? false : await getCalculatorModeEnabled();
  const b = demoSite ? { ...REAL_APP_BRANDING, ...DEMO_BRANDING, manifest: "manifest.json" } : calculatorModeEnabled ? CALCULATOR_BRANDING : REAL_APP_BRANDING;
  const head = `<title>${b.title}</title>
    <meta name="theme-color" content="${b.themeColor}" />
    <link rel="manifest" href="${b.manifest}" />
    <link rel="icon" href="${b.icon192}" />
    <link rel="apple-touch-icon" href="${b.appleTouchIcon}" />
    <meta name="apple-mobile-web-app-title" content="${b.title}" />${demoSite ? '\n    <meta name="robots" content="noindex, nofollow" />' : ""}`;
  // A <meta> tag, not an inline <script>, because the CSP above has no
  // 'unsafe-inline' in script-src -- bootGate.js reads this via
  // document.querySelector instead.
  const html = indexHtmlTemplate
    .replace("<!--CALCULATOR_MODE_HEAD-->", head)
    .replace("<!--CALCULATOR_MODE_FLAG-->", `<meta name="calc-mode" content="${calculatorModeEnabled}" />`)
    // Calculator Mode promises that nothing of the real app is fetched or
    // shown before the unlock code is entered, so neither the preload hints
    // nor the spinner are emitted for it.
    // A retry after a failed start (?fv_retry=..., bootGate.js / slowRoute.js) comes WITHOUT the preload hints: Safari keeps a preloaded file that
    // failed and a reload kept getting the same failure (owner, 2026-10-30), whereas a plain import() asks the server again every time.
    .replace("<!--MODULE_PRELOAD-->", calculatorModeEnabled || req.query.fv_retry ? "" : modulePreloadHtml)
    .replace("<!--BOOT_SPLASH-->", calculatorModeEnabled ? "" : BOOT_SPLASH_HTML);
  // Same reasoning as /manifest.json above -- this page's branding depends
  // on the same admin setting and must never be served stale from cache.
  res.set("Cache-Control", "no-store");
  if (demoSite) res.set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(html);
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = typeof err.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = status === 500 ? "Internal server error" : err.message || "Bad request";
  res.status(status).json({ error: message });
});
