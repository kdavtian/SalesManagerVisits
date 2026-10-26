// The demo site (DEMO_MODE=1, see docs/demo-site.md) must be recognisable at a glance and kept out of search engines; the real app is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll } from "./helpers.js";

let baseUrl;
test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  delete process.env.DEMO_MODE;
  await cleanupAll();
  await stopTestServer();
});

test("normal app: not branded as the demo, indexable", async () => {
  delete process.env.DEMO_MODE;
  const res = await fetch(`${baseUrl}/`);
  const html = await res.text();
  assert.doesNotMatch(html, /KAD Demo/);
  assert.doesNotMatch(html, /noindex/);
  assert.equal(res.headers.get("x-robots-tag"), null);
  const manifest = await (await fetch(`${baseUrl}/manifest.json`)).json();
  assert.notEqual(manifest.name, "KAD Demo");
});

test("demo site: own name, purple status bar, own manifest, noindex", async () => {
  process.env.DEMO_MODE = "1";
  const res = await fetch(`${baseUrl}/`);
  const html = await res.text();
  assert.match(html, /<title>KAD Demo<\/title>/);
  assert.match(html, /apple-mobile-web-app-title" content="KAD Demo"/);
  assert.match(html, /<link rel="manifest" href="manifest\.json"/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const manifest = await (await fetch(`${baseUrl}/manifest.json`)).json();
  assert.equal(manifest.name, "KAD Demo");
  assert.equal(manifest.short_name, "KAD Demo");
  assert.equal(manifest.theme_color, "#6d28d9");
  assert.ok(manifest.icons.length > 0);
});
