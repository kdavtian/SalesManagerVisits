// Texts in two parts (docs/architecture-roadmap.md step 11): before a screen is drawn only `common` and the areas listed for it in
// client/public/js/i18nAreas.js are loaded. A text of another area would show as its raw name until the background load brings it.
// This test reads the code: the texts each start-up file (shell, login, Home: the boot module graph) and each screen (its view and
// everything it imports) uses, and checks they are in `common` or in the screen's list. When it fails: add the area to the screen's list
// in i18nAreas.js (or, for a start-up file, move the text to common).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootModuleHrefs } from "../../src/system/modulePreload.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "client", "public");
const JS = path.join(PUBLIC, "js");
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(JS, rel), "utf8");
  } catch {
    return null;
  }
};
// key -> area, from the English area files (the Armenian ones hold the same keys, i18nParity.test.js)
const areaOfKey = new Map();
for (const f of fs.readdirSync(path.join(JS, "i18n", "en"))) {
  for (const m of read(`i18n/en/${f}`).matchAll(/^ +([a-zA-Z0-9_]+):/gm)) areaOfKey.set(m[1], f.replace(/\.js$/, ""));
}
const keyRe = new Map([...areaOfKey.keys()].map((k) => [k, new RegExp(`["'\`]${k}["'\`]`)]));
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
function staticGraph(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    const src = seen.has(file) ? null : read(file);
    if (src == null) continue;
    seen.add(file);
    for (const m of src.matchAll(IMPORT_RE)) if (m[1].startsWith(".")) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return seen;
}
// the areas (other than common) of the texts these files use
function areasUsed(files) {
  const out = new Map();
  for (const file of files) {
    if (/^i18n/.test(file)) continue;
    const src = read(file);
    for (const [key, re] of keyRe) {
      const area = areaOfKey.get(key);
      if (area !== "common" && re.test(src)) out.set(area, [...(out.get(area) ?? []), `${key} (${file})`]);
    }
  }
  return out;
}

test("the start-up files (shell, login, Home) use only common texts", () => {
  const boot = bootModuleHrefs(PUBLIC).map((h) => h.replace(/^\/js\//, ""));
  assert.ok(boot.includes("app.js") && boot.includes("views/dashboard.js"));
  const used = areasUsed(boot);
  assert.deepEqual(Object.fromEntries([...used].map(([a, keys]) => [a, keys.slice(0, 5)])), {}, "move these texts to i18n/<lang>/common.js");
});

test("every screen loads, before it is drawn, the text areas its files use (i18nAreas.js)", async () => {
  const { ROUTE_TEXT_AREAS, firstTextAreas } = await import(pathToFileURL(path.join(JS, "i18nAreas.js")).href);
  const routes = read("shell/routes.js");
  const problems = [];
  let screens = 0;
  for (const m of routes.matchAll(/path === "(#\/[a-z-]+)"[^{]*\{([\s\S]*?)\n  \}/g)) {
    const views = [...m[2].matchAll(/import\("\.\.\/(views\/[^"]+)"\)/g)].map((x) => x[1]);
    if (!views.length) continue;
    screens += 1;
    const first = firstTextAreas(m[1]);
    if (!(m[1] in ROUTE_TEXT_AREAS)) problems.push(`${m[1]}: not listed in ROUTE_TEXT_AREAS (it loads every area first)`);
    const files = new Set(views.flatMap((v) => [...staticGraph(v)]));
    for (const [area, keys] of areasUsed(files)) if (!first.includes(area)) problems.push(`${m[1]} needs "${area}", e.g. ${keys.slice(0, 2).join(", ")}`);
  }
  assert.ok(screens > 25, `found only ${screens} screens in shell/routes.js: did the routes move?`);
  assert.deepEqual(problems, [], "add the area to the screen's list in client/public/js/i18nAreas.js");
});
