// Step 9 (docs/architecture-roadmap.md): index.html links ONE stylesheet, css/app.css, and the server answers it with the boot stylesheets
// it @imports joined in order and minified, so the first paint waits for one request instead of eleven.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServer, stopTestServer, cleanupAll } from "./helpers.js";

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "client", "public");
let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("css/app.css comes back as the boot stylesheets joined in order, with no @import left", async () => {
  const listed = [...fs.readFileSync(path.join(clientDir, "css/app.css"), "utf8").matchAll(/@import\s+url\(["']?([\w./-]+\.css)["']?\)/g)].map((m) => m[1]);
  assert.ok(listed.length >= 10 && listed[0] === "styles.css", "app.css lists the boot stylesheets, styles.css first");
  const res = await fetch(`${baseUrl}/css/app.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/css/);
  const joined = await res.text();
  assert.doesNotMatch(joined, /@import/);
  // the same bytes as fetching each file on its own, in the listed order: nothing on screen can change
  const separate = [];
  for (const f of listed) separate.push(await (await fetch(`${baseUrl}/css/${f}`)).text());
  assert.equal(joined, separate.join(""));
});

test("index.html links only css/app.css", async () => {
  const html = await (await fetch(`${baseUrl}/`)).text();
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ["css/app.css"]);
});
