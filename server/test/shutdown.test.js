// Improvement plan 0.8: a deploy's SIGTERM lets requests in progress finish, starts no new background job, closes the database and exits;
// a request that does not finish is cut at the time limit; a second signal exits at once.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createShutdown } from "../src/system/shutdown.js";

const quiet = { log() {}, warn() {}, error() {} };
const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const get = (server) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: server.address().port, path: "/", agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });

test("a request in progress finishes; new connections are refused; jobs stop; the database closes last; exit 0", async () => {
  const order = [];
  const server = await listen((req, res) => setTimeout(() => res.end("done"), 300));
  let exitCode;
  let inFlight;
  const exited = new Promise((resolve) => {
    const shutdown = createShutdown({
      server,
      log: quiet,
      stopJobs: async (waitMs) => {
        assert.ok(waitMs > 0 && waitMs <= 2000);
        order.push("jobs");
      },
      closeDb: async () => order.push("db"),
      capMs: 2000,
      exit: (code) => {
        exitCode = code;
        resolve();
      },
    });
    inFlight = get(server);
    setTimeout(() => {
      shutdown("SIGTERM");
      setTimeout(() => {
        get(server).then(
          () => order.push("new request answered"),
          () => order.push("new refused")
        );
      }, 20);
    }, 50);
  });
  await exited;
  assert.equal(exitCode, 0);
  assert.deepEqual(await inFlight, { status: 200, body: "done" }, "the request in progress got its full answer");
  assert.ok(order.includes("new refused"), JSON.stringify(order));
  assert.equal(order.at(-1), "db", "the database is closed after requests and jobs");
});

test("a request that never finishes is cut at the time limit, then the process exits", async () => {
  const server = await listen(() => {}); // never answers
  const t0 = Date.now();
  let exitCode;
  let shutdown;
  const exited = new Promise((resolve) => {
    shutdown = createShutdown({
      server,
      log: quiet,
      stopJobs: async () => {},
      closeDb: async () => {},
      capMs: 300,
      exit: (code) => {
        exitCode = code;
        resolve();
      },
    });
  });
  const hung = get(server).catch((err) => err);
  await new Promise((r) => setTimeout(r, 50));
  shutdown("SIGTERM");
  await exited;
  assert.equal(exitCode, 0);
  const took = Date.now() - t0;
  assert.ok(took >= 300 && took < 1500, `took ${took} ms`);
  assert.ok((await hung) instanceof Error, "the hung request's connection was closed");
});

test("a second signal exits at once with code 1", async () => {
  const server = await listen((req, res) => res.end());
  const codes = [];
  const shutdown = createShutdown({
    server,
    log: quiet,
    stopJobs: () => new Promise(() => {}), // a job that never ends
    closeDb: async () => {},
    capMs: 60_000,
    exit: (code) => codes.push(code),
  });
  shutdown("SIGTERM");
  shutdown("SIGINT");
  assert.deepEqual(codes, [1]);
  server.closeAllConnections();
});
