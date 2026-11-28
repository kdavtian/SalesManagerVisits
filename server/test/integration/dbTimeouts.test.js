// Improvement plan 0.22: one slow query must not stall every phone. In the web server a request's query is cancelled after the web limit
// (30 s in production; 300 ms here), while background jobs, the Excel sync and scripts keep the long limit (db/pool.js).
process.env.DB_STATEMENT_TIMEOUT_MS = "300";
process.env.DB_IDLE_IN_TX_TIMEOUT_MS = ""; // blank, as docker-compose passes an unset one: the default stays

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { pool, useWebLimits, runLongWork, longWorkMiddleware, currentPoolKind, endPools, DB_LIMITS } = await import("../../src/db/pool.js");

test.after(async () => {
  useWebLimits(false);
  await endPools();
});

test("defaults (a blank setting keeps the default): 30 s per web query, 60 s idle in a transaction, 10 s to get a connection, 15 min for long work", () => {
  // this file overrides the web limit; the others are the shipped defaults
  assert.equal(DB_LIMITS.webStatementMs, 300);
  assert.equal(DB_LIMITS.webIdleInTxMs, 60_000);
  assert.equal(DB_LIMITS.connectMs, 10_000);
  assert.equal(DB_LIMITS.longStatementMs, 15 * 60_000);
});

test("scripts and tests (no web limits switched on) use the long connections", async () => {
  assert.equal(currentPoolKind(), "long");
  const { rows } = await pool.query("SHOW statement_timeout");
  assert.equal(rows[0].statement_timeout, "15min");
  await pool.query("SELECT pg_sleep(0.5)"); // longer than the web limit: fine here
});

test("in the web server a slow query is cancelled; the same query inside runLongWork() finishes", async () => {
  useWebLimits(true);
  try {
    assert.equal(currentPoolKind(), "web");
    const { rows } = await pool.query("SHOW idle_in_transaction_session_timeout");
    assert.equal(rows[0].idle_in_transaction_session_timeout, "1min");
    await assert.rejects(pool.query("SELECT pg_sleep(1)"), (err) => err.code === "57014", "statement timeout");
    // a transaction on a checked-out client gets the limit too
    const client = await pool.connect();
    try {
      await assert.rejects(client.query("SELECT pg_sleep(1)"), (err) => err.code === "57014");
    } finally {
      client.release();
    }
    await runLongWork(async () => {
      assert.equal(currentPoolKind(), "long");
      await pool.query("SELECT pg_sleep(0.5)");
    });
  } finally {
    useWebLimits(false);
  }
});

test("a route behind longWorkMiddleware (the Excel sync) runs on the long connections after its JSON body is read", async () => {
  useWebLimits(true);
  const app = express();
  app.post("/sync", express.json(), longWorkMiddleware, async (req, res) => {
    await new Promise((r) => setTimeout(r, 10));
    await pool.query("SELECT pg_sleep(0.5)");
    res.json({ kind: currentPoolKind(), n: req.body.n });
  });
  app.post("/web", express.json(), async (req, res) => res.json({ kind: currentPoolKind() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path) =>
      fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 7 }) }).then((r) => r.json());
    assert.deepEqual(await post("/sync"), { kind: "long", n: 7 });
    assert.deepEqual(await post("/web"), { kind: "web" });
  } finally {
    await new Promise((r) => server.close(r));
    useWebLimits(false);
  }
});
