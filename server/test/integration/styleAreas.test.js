// Styles per area (docs/architecture-roadmap.md step 8c): css/app.css holds what every screen needs, css/areas/<area>.css what only
// some screens need (loaded by js/styles.js before such a screen is drawn: the area lists in js/i18nAreas.js). This test reads the code
// and fails when a screen would be drawn without its styles:
//   - the start-up files (shell, login, Home and what they open) use no class that only an area stylesheet styles;
//   - every listed screen uses area-only classes of its own areas only;
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

function classesOf(text) {
  const out = new Set();
  const visit = (body) => {
    for (const item of parseCss(body).items) {
      if (item.kind === "rule") for (const sel of splitSelectors(item.head)) for (const n of selectorNames(sel).positive) out.add(n);
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
const shared = new Set();
for (const f of [...fs.readFileSync(path.join(CSS, "app.css"), "utf8").matchAll(/@import\s+url\("([\w.-]+\.css)"\)/g)].map((m) => m[1])) {
  for (const c of classesOf(fs.readFileSync(path.join(CSS, f), "utf8"))) shared.add(c);
}
// class -> the area files that style it, for the classes css/app.css does not style at all
const areaOnly = new Map();
for (const area of areaFiles) {
  for (const c of classesOf(fs.readFileSync(path.join(CSS, "areas", `${area}.css`), "utf8"))) {
    if (!shared.has(c)) areaOnly.set(c, [...(areaOnly.get(c) ?? []), area]);
  }
}
function areaClassesUsed(files) {
  const out = new Map(); // class -> file
  for (const file of files) {
    const src = read(file);
    for (const c of areaOnly.keys()) if (!out.has(c) && new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(src)) out.set(c, file);
  }
  return out;
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
  const used = areaClassesUsed(files);
  assert.deepEqual([...used].slice(0, 10).map(([c, f]) => `${c} (${f}, styled only in ${areaOnly.get(c).join("/")})`), []);
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
    for (const [c, file] of areaClassesUsed(graph(views, { dynamic: false }))) {
      if (!areaOnly.get(c).some((a) => list.includes(a))) problems.push(`${m[1]} uses ${c} (${file}), styled only in ${areaOnly.get(c).join("/")}`);
    }
  }
  assert.ok(screens > 25, `found only ${screens} screens in shell/routes.js`);
  assert.deepEqual(problems.slice(0, 20), [], "add the area to the screen's list in client/public/js/i18nAreas.js, or keep the rule shared");
});
