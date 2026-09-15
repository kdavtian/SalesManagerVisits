// The Express app itself, split out from index.js's process bootstrap
// (listen(), background interval jobs) so integration tests can import a
// real, fully-wired app and drive it over HTTP without also starting
// setInterval-based reminder jobs or binding a fixed port. index.js is now
// the thin "run this for real" entrypoint; this file is the "build the
// app" one. See test/integration/testServer.js for how tests use this.
import "dotenv/config";
import "express-async-errors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import { authRouter, meRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { customersRouter } from "./routes/customers.js";
import { customerSocialRouter } from "./routes/customerSocial.js";
import { checkinsRouter } from "./routes/checkins.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { settingsRouter } from "./routes/settings.js";
import { editRequestsRouter } from "./routes/editRequests.js";
import { locationsRouter } from "./routes/locations.js";
import { erpSyncRouter } from "./routes/erpSync.js";
import { geocodeRouter } from "./routes/geocode.js";
import { visitPlansRouter } from "./routes/visitPlans.js";
import { salesPerformanceRouter } from "./routes/salesPerformance.js";
import { productsRouter } from "./routes/products.js";
import { companyProfileRouter } from "./routes/companyProfile.js";
import { routeDistributionRouter } from "./routes/routeDistribution.js";
import { ordersRouter } from "./routes/orders.js";
import { orderMetaRouter } from "./routes/orderMeta.js";
import { exportsRouter } from "./routes/exports.js";
import { pushRouter } from "./routes/push.js";
import { notificationSettingsRouter } from "./routes/notificationSettings.js";
import { notificationsRouter } from "./routes/notifications.js";
import { teamPerformanceRouter } from "./routes/teamPerformance.js";
import { cashExpensesRouter } from "./routes/cashExpenses.js";
import { reportsRouter } from "./routes/reports.js";
import { paymentsRouter } from "./routes/payments.js";
import { cashHandoffsRouter } from "./routes/cashHandoffs.js";
import { warehouseRouter } from "./routes/warehouse.js";
import { deliveryRouter } from "./routes/delivery.js";
import { debtBalancesRouter } from "./routes/debtBalances.js";
import { dataQualityRouter } from "./routes/dataQuality.js";
import { salesRouter } from "./routes/sales.js";
import { badgesRouter } from "./routes/badges.js";
import { calculatorLockRouter } from "./routes/calculatorLock.js";
import { lockdownRouter } from "./routes/lockdown.js";
import { lockdownGate } from "./middleware/lockdown.js";
import { getCalculatorModeEnabled } from "./settings.js";
import { requireAuth } from "./middleware/auth.js";
import { autoAssignSalesChannel } from "./salesChannelAutofill.js";
import { normalizeCustomerPortfolio } from "./customerChannelPolicy.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error(
    "JWT_SECRET is missing or too short (must be at least 16 characters). Refusing to start."
  );
  process.exit(1);
}

if (!process.env.ERP_SYNC_KEY) {
  console.warn(
    "ERP_SYNC_KEY is not set — the /api/erp-sync endpoint will reject all requests until it is."
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "..", "client", "public");

export const app = express();

app.set("trust proxy", 1);

// Every response through here is currently sent uncompressed -- CSS/JS/JSON
// gzipped for free at essentially no CPU cost, which matters most on the
// slow cellular connections this app already optimizes hard for elsewhere
// (see api.js's GET cache, the offline queue, etc.).
app.use(compression());

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https://*.basemaps.cartocdn.com", "https://*.tile.openstreetmap.org", "https://maps.wikimedia.org"],
        connectSrc: ["'self'", "https://*.basemaps.cartocdn.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);
app.use(cookieParser());
app.use(lockdownGate);

app.use("/api/auth", express.json(), authRouter);
app.use("/api/me", express.json(), meRouter);
app.use("/api/users", express.json(), usersRouter);
app.post("/api/customers", express.json(), requireAuth, autoAssignSalesChannel, normalizeCustomerPortfolio);
app.use("/api/customers", express.json(), customersRouter);
app.use("/api/customer-social", express.json(), customerSocialRouter);
app.use("/api/checkins", checkinsRouter);
app.use("/api/dashboard", express.json(), dashboardRouter);
app.use("/api/settings", express.json(), settingsRouter);
app.use("/api/edit-requests", express.json(), editRequestsRouter);
app.use("/api/locations", express.json(), locationsRouter);
app.use("/api/erp-sync", express.json({ limit: "25mb" }), erpSyncRouter);
app.use("/api/geocode", geocodeRouter);
app.use("/api/visit-plans", express.json(), visitPlansRouter);
app.use("/api/sales-performance", salesPerformanceRouter);
app.use("/api/products", express.json(), productsRouter);
app.use("/api/company-profile", express.json(), companyProfileRouter);
app.use("/api/route-distribution", express.json(), routeDistributionRouter);
app.use("/api/orders", express.json(), ordersRouter);
app.use("/api/order-meta", express.json(), orderMetaRouter);
app.use("/api/exports", exportsRouter);
app.use("/api/push", express.json(), pushRouter);
app.use("/api/notification-settings", express.json(), notificationSettingsRouter);
app.use("/api/notifications", express.json(), notificationsRouter);
app.use("/api/team-performance", express.json(), teamPerformanceRouter);
app.use("/api/cash-expenses", express.json(), cashExpensesRouter);
app.use("/api/reports", express.json(), reportsRouter);
app.use("/api/payments", express.json(), paymentsRouter);
app.use("/api/cash-handoffs", express.json(), cashHandoffsRouter);
app.use("/api/warehouse", express.json(), warehouseRouter);
app.use("/api/delivery", express.json(), deliveryRouter);
app.use("/api/debt-balances", express.json(), debtBalancesRouter);
app.use("/api/data-quality", express.json(), dataQualityRouter);
app.use("/api/sales", express.json(), salesRouter);
app.use("/api/badges", badgesRouter);
app.use("/api/calculator-lock", express.json(), calculatorLockRouter);
app.use("/api/lockdown", express.json(), lockdownRouter);

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// The stylesheets are hand-edited source (comments, full indentation) --
// minifying here at request time, rather than as a separate build step,
// means the served bytes can never drift out of sync with the source the
// way CACHE_VERSION did (see CLAUDE.md): there's nothing to remember to
// rebuild, since every deploy already restarts the process. Cached in
// memory per file after the first request so the minify cost is paid once,
// not per request; skipped entirely outside production so editing a
// stylesheet locally shows up on the next reload without a restart.
const cssMinifyCache = new Map();
app.get(/^\/css\/.*\.css$/, async (req, res, next) => {
  const filePath = path.join(clientDir, req.path);
  try {
    let minified = cssMinifyCache.get(filePath);
    if (!minified) {
      const { default: CleanCSS } = await import("clean-css");
      const raw = await fs.promises.readFile(filePath, "utf8");
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
app.use(express.static(clientDir, { index: false }));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

const indexHtmlPath = path.join(clientDir, "index.html");
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf8");

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

app.get("/manifest.json", async (req, res) => {
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

app.get("*", async (req, res) => {
  // Read server-side (never fetched by the client) so the calculator
  // disguise's "touches no network before unlock" property holds whether
  // the feature is on or off -- see bootGate.js.
  const calculatorModeEnabled = await getCalculatorModeEnabled();
  const b = calculatorModeEnabled ? CALCULATOR_BRANDING : REAL_APP_BRANDING;
  const head = `<title>${b.title}</title>
    <meta name="theme-color" content="${b.themeColor}" />
    <link rel="manifest" href="${b.manifest}" />
    <link rel="icon" href="${b.icon192}" />
    <link rel="apple-touch-icon" href="${b.appleTouchIcon}" />
    <meta name="apple-mobile-web-app-title" content="${b.title}" />`;
  // A <meta> tag, not an inline <script>, because the CSP above has no
  // 'unsafe-inline' in script-src -- bootGate.js reads this via
  // document.querySelector instead.
  const html = indexHtmlTemplate
    .replace("<!--CALCULATOR_MODE_HEAD-->", head)
    .replace("<!--CALCULATOR_MODE_FLAG-->", `<meta name="calc-mode" content="${calculatorModeEnabled}" />`);
  // Same reasoning as /manifest.json above -- this page's branding depends
  // on the same admin setting and must never be served stale from cache.
  res.set("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = typeof err.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = status === 500 ? "Internal server error" : err.message || "Bad request";
  res.status(status).json({ error: message });
});
