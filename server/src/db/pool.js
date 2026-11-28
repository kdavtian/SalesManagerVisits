import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// a setting left blank or unreadable keeps the default (never "0 = no limit" by accident); 0 written on purpose lifts the limit
const ms = (name, fallback) => {
  const raw = String(process.env[name] ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

// Time limits (improvement plan 0.22): one slow query must not stall every phone. Two groups of connections share one database:
//   - web: what a phone or desktop request runs. A query over 30 s is cancelled, a transaction left open and idle over 60 s is closed.
//   - long: background jobs, the Excel sync, startup work, scripts and migrations. They legitimately run longer, so they get 15 min per
//     query (migrations lift it entirely, db/migrate.js) and 10 min idle in a transaction.
// Every value can be changed in the server's .env without a code change. Waiting for a free connection is capped (10 s web, 60 s long:
// ~20 jobs start together at the top of an hour), so a full pool answers with an error instead of hanging forever. Each group has its own
// 10 connections, so jobs and the Excel sync never take the phones' connections.
export const DB_LIMITS = Object.freeze({
  webStatementMs: ms("DB_STATEMENT_TIMEOUT_MS", 30_000),
  webIdleInTxMs: ms("DB_IDLE_IN_TX_TIMEOUT_MS", 60_000),
  longStatementMs: ms("DB_LONG_STATEMENT_TIMEOUT_MS", 15 * 60_000),
  longIdleInTxMs: ms("DB_LONG_IDLE_IN_TX_TIMEOUT_MS", 10 * 60_000),
  connectMs: ms("DB_CONNECT_TIMEOUT_MS", 10_000),
  longConnectMs: ms("DB_LONG_CONNECT_TIMEOUT_MS", 60_000),
});

// Postgres JIT-compiles any query the planner prices above a high cost threshold. Our biggest queries (per-product
// subselects, aging over thousands of customers) sit just over it, and the compile step then costs more than the query
// itself and makes the first call after idle slow (a 3.6 s first /products against 0.18 s warm was measured). These are
// all short OLTP-style queries: JIT off for every connection (a startup parameter, no extra round trip). The time limits
// travel the same way.
function makePool({ statementMs, idleInTxMs, connectMs }) {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c jit=off -c statement_timeout=${statementMs} -c idle_in_transaction_session_timeout=${idleInTxMs}`,
    connectionTimeoutMillis: connectMs,
  });
  // Without this, an idle client's connection dropping (network blip, DB
  // restart) emits an unhandled 'error' on the pool and crashes the whole
  // process -- pg surfaces backend-initiated disconnects this way rather than
  // through the query that was in flight.
  p.on("error", (err) => {
    console.error("Unexpected error on idle database client", err);
  });
  return p;
}

const webPool = makePool({ statementMs: DB_LIMITS.webStatementMs, idleInTxMs: DB_LIMITS.webIdleInTxMs, connectMs: DB_LIMITS.connectMs });
const longPool = makePool({ statementMs: DB_LIMITS.longStatementMs, idleInTxMs: DB_LIMITS.longIdleInTxMs, connectMs: DB_LIMITS.longConnectMs });

// Which group a query uses: code wrapped in runLongWork() (a background job, the Excel sync) always takes the long group. Everything else
// takes the web group only in the web server (index.js calls useWebLimits() at start); scripts, migrations and tests keep the long group,
// so a one-off script is never cut at 30 s.
const longWork = new AsyncLocalStorage();
let webLimits = false;

export function useWebLimits(on = true) {
  webLimits = on;
}

export function runLongWork(fn) {
  return longWork.run(true, fn);
}

// For an Express route that legitimately runs long (the Excel sync): placed after the body parser, so the rest of the chain runs inside.
export function longWorkMiddleware(req, res, next) {
  longWork.run(true, next);
}

export const currentPoolKind = () => (webLimits && !longWork.getStore() ? "web" : "long");
const current = () => (currentPoolKind() === "web" ? webPool : longPool);

// One `pool` for the whole code base, as before: every call goes to the group of the work it runs in (query, connect, end, on, counts).
export const pool = new Proxy(
  {},
  {
    get(_target, prop) {
      const target = current();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }
);

// Shutdown: both groups closed (pool.end() alone closes only the current one).
export async function endPools() {
  await Promise.allSettled([webPool.ended ? null : webPool.end(), longPool.ended ? null : longPool.end()]);
}

export function query(text, params) {
  return current().query(text, params);
}
