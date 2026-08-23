import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { authRouter, meRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { customersRouter } from "./routes/customers.js";
import { checkinsRouter } from "./routes/checkins.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { settingsRouter } from "./routes/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, "..", "..", "client", "public");

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRouter);
app.use("/api/me", meRouter);
app.use("/api/users", usersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/checkins", checkinsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/settings", settingsRouter);

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
  res.status(500).json({ error: "Internal server error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
});
