// A script, style or picture that does not exist is a real 404, never the app's own page with "200 OK" (owner, 2026-10-30: after an update a white
// screen, Reload spinning for ever). The service worker used to keep that HTML under the file's address.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer } from "./helpers.js";

let base;
test.before(async () => {
  base = await startTestServer();
});
test.after(stopTestServer);

const get = (path) => fetch(`${base}${path}`, { redirect: "manual" });

test("missing script / style / picture / font files answer 404 and are never kept by a cache", async () => {
  for (const path of ["/js/chunks/shared-OLDHASH123.js", "/js/views/not-a-screen.js", "/css/areas/not-an-area.css", "/icons/not-an-icon.png", "/nope.js", "/apple-touch-icon.png", "/favicon.ico"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/, path);
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /html/, path);
  }
});

test("real files and the app's own pages are untouched", async () => {
  const sw = await get("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type") ?? "", /javascript/);
  const app = await get("/js/app.js");
  assert.equal(app.status, 200);
  for (const path of ["/", "/index.html", "/customers/12"]) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get("content-type") ?? "", /html/, path);
  }
});
