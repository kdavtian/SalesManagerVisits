import "dotenv/config";
import "express-async-errors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { authRouter, meRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { customersRouter } from "./routes/customers.js";
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
import { ordersRouter } from "./routes/orders.js";
import { exportsRouter } from "./routes/exports.js";

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

const app = express();

app.use(
  helmet({
    // The app serves its own HTML/CSS/JS same-origin and loads map tiles
    // from basemaps.cartocdn.com, so a default strict CSP would break the
    // map; disable CSP here rather than ship one that's wrong.
    contentSecurityPolicy: false,
  })
);
app.use(cookieParser());

app.use("/api/auth", express.json(), authRouter);
app.use("/api/me", express.json(), meRouter);
app.use("/api/users", express.json(), usersRouter);
app.use("/api/customers", express.json(), customersRouter);
app.use("/api/checkins", checkinsRouter);
app.use("/api/dashboard", express.json(), dashboardRouter);
app.use("/api/settings", express.json(), settingsRouter);
app.use("/api/edit-requests", express.json(), editRequestsRouter);
app.use("/api/locations", express.json(), locationsRouter);
// A real ERP extract (hundreds of customers with debt + recent orders, plus
// full all-time order-line history for the "show all orders" drill-down)
// can comfortably exceed express's 100kb default JSON body limit, so this
// route gets a much higher one -- it's machine-authenticated (X-Sync-Key),
// not user-facing, so a larger limit here doesn't widen the attack surface
// the way it would on a route any logged-in user can hit.
app.use("/api/erp-sync", express.json({ limit: "25mb" }), erpSyncRouter);
app.use("/api/geocode", geocodeRouter);
app.use("/api/visit-plans", express.json(), visitPlansRouter);
app.use("/api/sales-performance", salesPerformanceRouter);
app.use("/api/products", express.json(), productsRouter);
app.use("/api/orders", express.json(), ordersRouter);
app.use("/api/exports", exportsRouter);

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(clientDir));

// Non-error 404 for unmatched API routes, before falling back to the SPA shell.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  // Known client-error cases (oversized body, malformed JSON) carry their
  // own status via body-parser/http-errors conventions -- surface that
  // instead of masking every error as a generic 500, which made a simple
  // "payload too large" indistinguishable from a real server bug.
  const status = typeof err.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = status === 500 ? "Internal server error" : err.message || "Bad request";
  res.status(status).json({ error: message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
});
