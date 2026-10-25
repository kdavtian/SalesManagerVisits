// Cold-start boot hints: index.html lists the whole boot module graph as
// <link rel="modulepreload"> so a first launch fetches it in parallel instead
// of one network round trip per import level -- but never while Calculator
// Mode is on, because that mode promises the real app's code is not fetched
// (or shown) before the unlock code is entered.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServer, stopTestServer, cleanupAll } from "./helpers.js";
import { bootModuleHrefs } from "../../src/modulePreload.js";
import { setCalculatorModeEnabled } from "../../src/settings.js";

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "client", "public");
let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  await setCalculatorModeEnabled(false).catch(() => {});
  await cleanupAll();
  await stopTestServer();
});

test("boot graph includes the gate's modules, their imports and the first screens", () => {
  const hrefs = bootModuleHrefs(clientDir);
  for (const expected of ["/js/app.js", "/js/api.js", "/js/i18n.js", "/js/state.js", "/js/util.js", "/js/views/login.js", "/js/views/dashboard.js"]) {
    assert.ok(hrefs.includes(expected), `${expected} should be preloaded`);
  }
  assert.equal(new Set(hrefs).size, hrefs.length, "no duplicates");
  // map.js and the other screens are warmed later, in idle time, not at boot.
  assert.ok(!hrefs.includes("/js/views/map.js"));
});

async function getIndex() {
  const res = await fetch(`${baseUrl}/`);
  return res.text();
}

test("index.html carries the preload hints and the spinner while Calculator Mode is off", async () => {
  await setCalculatorModeEnabled(false);
  const html = await getIndex();
  assert.match(html, /<link rel="modulepreload" href="\/js\/app\.js" \/>/);
  assert.match(html, /class="boot-splash"/);
  assert.doesNotMatch(html, /<!--MODULE_PRELOAD-->|<!--BOOT_SPLASH-->/);
});

test("Calculator Mode: no preload hints and no spinner before unlock", async () => {
  await setCalculatorModeEnabled(true);
  try {
    const html = await getIndex();
    assert.doesNotMatch(html, /modulepreload/);
    assert.doesNotMatch(html, /boot-splash"/);
    assert.match(html, /<meta name="calc-mode" content="true" \/>/);
  } finally {
    await setCalculatorModeEnabled(false);
  }
});
