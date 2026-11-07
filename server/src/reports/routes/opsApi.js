// The read-only, pseudonymised data feed of the Claude scheduled agents (owner, 2026-11-07): the daily Reconciler (app vs Excel) and the
// Monday business brief, later the analyst / department agents. docs/ops-api.md.
//   - bearer token of scope 'ops-read' only (an accounting token of Lily gets 403; erp/integrationTokens.js checkBearer)
//   - GET only, rate limited, every call in integration_audit_log
//   - PRIVACY: customers only as their ERP customer ID, amounts whole AMD; no names, phones, addresses, TINs, salaries or staff ever
//     (test/integration/opsApi.test.js scans every response)
// Mounted at /api/ops/v1 AHEAD of the Operations control router (/api/ops, a person's session): every /v1 path ends here.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../../db/pool.js";
import { checkBearer } from "../../erp/integrationTokens.js";
import { reconcile } from "../opsFeed/reconcile.js";
import { kpi, KPI_PERIODS, KPI_MODES } from "../opsFeed/kpi.js";

export const opsApiRouter = Router();

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// A scheduled agent makes a handful of calls a day; 30 a minute per address is plenty and stops a token guesser.
opsApiRouter.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => fail(res, 429, "rate_limited", "Too many requests, try again in a minute"),
  })
);

// Named: test/architecture.test.js counts it as the login of every route below.
opsApiRouter.use(async function requireOpsToken(req, res, next) {
  if (req.method !== "GET") return fail(res, 405, "read_only", "The ops API is read-only (GET)");
  const auth = await checkBearer(req, "ops-read");
  if (!auth.token) return fail(res, auth.status, auth.code, auth.message);
  req.opsToken = auth.token;
  res.set("Cache-Control", "no-store");
  res.on("finish", () => {
    pool
      .query(
        `INSERT INTO integration_audit_log (token_id, token_name, method, path, status_code, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
        [auth.token.id, auth.token.name, req.method, req.originalUrl.split("?")[0], res.statusCode, req.ip]
      )
      .catch((err) => console.error("Ops API audit log failed:", err));
  });
  next();
});

opsApiRouter.get("/reconcile", async (_req, res) => {
  res.json(await reconcile(pool));
});

opsApiRouter.get("/kpi", async (req, res) => {
  const period = String(req.query.period ?? "week");
  const mode = String(req.query.mode ?? "complete");
  if (!KPI_PERIODS.includes(period)) return fail(res, 400, "bad_period", `period must be one of: ${KPI_PERIODS.join(", ")}`);
  if (!KPI_MODES.includes(mode)) return fail(res, 400, "bad_mode", `mode must be one of: ${KPI_MODES.join(", ")}`);
  res.json(await kpi(pool, { period, mode }));
});

// Anything else under /v1 stops here (never falls through to the Operations control router behind it).
opsApiRouter.use((_req, res) => fail(res, 404, "not_found", "Unknown ops API endpoint"));
