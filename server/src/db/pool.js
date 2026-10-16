import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Postgres JIT-compiles any query the planner prices above a high cost threshold. Our biggest queries (per-product
// subselects, aging over thousands of customers) sit just over it, and the compile step then costs more than the query
// itself and makes the first call after idle slow (a 3.6 s first /products against 0.18 s warm was measured). These are
// all short OLTP-style queries: JIT off for every connection (a startup parameter, no extra round trip).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c jit=off",
});

// Without this, an idle client's connection dropping (network blip, DB
// restart) emits an unhandled 'error' on the pool and crashes the whole
// process -- pg surfaces backend-initiated disconnects this way rather than
// through the query that was in flight.
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

export function query(text, params) {
  return pool.query(text, params);
}
