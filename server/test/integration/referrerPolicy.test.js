// OpenStreetMap / Wikimedia tile servers need a Referer; helmet's default
// "no-referrer" made the desktop map fail with "The map couldn't load".
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll } from "./helpers.js";

let baseUrl;
test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("pages are served with a Referrer-Policy that still sends the origin to tile hosts", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});
