import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
