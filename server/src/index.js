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
import { warehouseRouter } from "./routes/warehouse.js";
import { deliveryRouter } from "./routes/delivery.js";
import { startOverdueReminders } from "./overdueReminders.js";
import { startStalePackedReminder } from "./stalePackedReminder.js";
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

const app = express();

app.set("trust proxy", 1);

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
app.use("/api/warehouse", express.json(), warehouseRouter);
app.use("/api/delivery", express.json(), deliveryRouter);

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(clientDir));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = typeof err.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message = status === 500 ? "Internal server error" : err.message || "Bad request";
  res.status(status).json({ error: message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startOverdueReminders();
  startStalePackedReminder();
});
