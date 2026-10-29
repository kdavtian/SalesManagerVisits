// Styles per area (docs/architecture-roadmap.md step 8c): css/app.css holds what every screen needs, css/areas/<area>.css what only
// some screens need (loaded by js/styles.js before such a screen is drawn: the area lists in js/i18nAreas.js). This test reads the code
// and fails when a screen would be drawn without its styles:
//   - the start-up files (shell, login, Home and what they open) can match no selector of an area stylesheet;
//   - every listed screen can match area selectors of its own areas only (a selector can match where the files use all its classes);
//   - js/styles.js, the files in css/areas/ and the service worker's offline list name the same areas.
// When it fails: move the rule to css/app.css's files (a class several areas use) or add the area to the screen's list in i18nAreas.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCss, splitSelectors, selectorNames } from "../../scripts/split-css.mjs";
import { bootModuleHrefs } from "../../src/system/modulePreload.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "client", "public");
const JS = path.join(PUBLIC, "js");
const CSS = path.join(PUBLIC, "css");
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(JS, rel), "utf8");
  } catch {
    return null;
  }
};

// the selectors of a stylesheet, each as the classes an element (or its parents) must have for it to match
function selectorsOf(text) {
  const out = [];
  const visit = (body) => {
    for (const item of parseCss(body).items) {
      if (item.kind === "rule") for (const sel of splitSelectors(item.head)) out.push(selectorNames(sel).positive);
      else if (item.kind === "atblock" && /^@(media|supports)\b/.test(item.head)) visit(item.body);
    }
  };
  visit(text);
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
function graph(starts, { dynamic, notFrom = new Set() }) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const file = queue.shift();
    const src = seen.has(file) ? null : read(file);
    if (src == null) continue;
    seen.add(file);
    for (const m of [...src.matchAll(IMPORT_RE), ...(dynamic && !notFrom.has(file) ? src.matchAll(DYNAMIC_RE) : [])]) {
      if (m[1].startsWith(".")) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
    }
  }
  return seen;
}

const areaFiles = fs.readdirSync(path.join(CSS, "areas")).filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, ""));
// every selector of an area stylesheet with its area; a screen whose files use all of a selector's classes can match it, so it must load
// that area first (unless css/app.css styles the same selector, then nothing changes without the area)
const areaSelectors = areaFiles.flatMap((area) =>
  selectorsOf(fs.readFileSync(path.join(CSS, "areas", `${area}.css`), "utf8")).filter((names) => names.length).map((names) => ({ area, names }))
);
const fileUses = new Map(); // "file\0class" -> bool
function uses(file, name) {
  const key = `${file}\0${name}`;
  if (!fileUses.has(key)) fileUses.set(key, new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(read(file) ?? ""));
  return fileUses.get(key);
}
// the area selectors these files can match: every class of the selector is used by one of the files
function areaSelectorsUsed(files) {
  const list = [...files];
  return areaSelectors.filter(({ names }) => names.every((n) => list.some((f) => uses(f, n))));
}

test("js/styles.js, css/areas/ and the service worker name the same style areas", async () => {
  const { STYLE_AREAS } = await import(pathToFileURL(path.join(JS, "styles.js")).href);
  assert.deepEqual([...areaFiles].sort(), [...STYLE_AREAS].sort());
  const sw = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
  for (const area of STYLE_AREAS) assert.ok(sw.includes(`"/css/areas/${area}.css"`), `sw.js APP_SHELL lacks /css/areas/${area}.css`);
});

test("the start-up files (shell, login, Home and what they open) use only shared styles", () => {
  const boot = bootModuleHrefs(PUBLIC).map((h) => h.replace(/^\/js\//, ""));
  const files = graph(boot, { dynamic: true, notFrom: new Set(["shell/routes.js", "shell/preload.js"]) });
  const used = areaSelectorsUsed(files);
  assert.deepEqual(used.slice(0, 10).map(({ area, names }) => `.${names.join(" .")} (styled only in ${area})`), []);
});

test("every listed screen loads, before it is drawn, the style areas of the classes its files use", async () => {
  const { ROUTE_TEXT_AREAS } = await import(pathToFileURL(path.join(JS, "i18nAreas.js")).href);
  const routes = read("shell/routes.js");
  const problems = [];
  let screens = 0;
  for (const m of routes.matchAll(/path === "(#\/[a-z-]+)"[^{]*\{([\s\S]*?)\n  \}/g)) {
    const views = [...m[2].matchAll(/import\("\.\.\/(views\/[^"]+)"\)/g)].map((x) => x[1]);
    if (!views.length || !(m[1] in ROUTE_TEXT_AREAS) || m[1] === "#/dashboard") continue;
    screens += 1;
    const list = ROUTE_TEXT_AREAS[m[1]];
    for (const { area, names } of areaSelectorsUsed(graph(views, { dynamic: false }))) {
      if (!list.includes(area)) problems.push(`${m[1]} can match .${names.join(" .")}, styled only in ${area}`);
    }
  }
  assert.ok(screens > 25, `found only ${screens} screens in shell/routes.js`);
  assert.deepEqual(problems.slice(0, 20), [], "add the area to the screen's list in client/public/js/i18nAreas.js, or keep the rule shared");
});
