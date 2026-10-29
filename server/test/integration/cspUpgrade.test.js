// The security header keeps "upgrade-insecure-requests" in production; only the test server (plain http://127.0.0.1, NODE_ENV=test) drops
// it, because Safari's engine in the iPhone browser tests would otherwise ask for https://127.0.0.1 and fail every request (src/app.js).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "app.js")).href;
function csp(nodeEnv) {
  const script = `const { app } = await import(${JSON.stringify(APP)});
const srv = app.listen(0, async () => {
  const res = await fetch("http://127.0.0.1:" + srv.address().port + "/api/health");
  process.stdout.write(String(res.headers.get("content-security-policy")));
  process.exit(0);
});`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_ENV: nodeEnv }, encoding: "utf8", timeout: 20000 });
}

test("production keeps upgrade-insecure-requests; the test server leaves it out", () => {
  const production = csp("production");
  assert.match(production, /default-src 'self'/);
  assert.match(production, /upgrade-insecure-requests/);
  const testing = csp("test");
  assert.match(testing, /default-src 'self'/);
  assert.doesNotMatch(testing, /upgrade-insecure-requests/);
});
