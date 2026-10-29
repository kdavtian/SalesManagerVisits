// The deploy build of the phone app's scripts (server/scripts/build-client.mjs, docs/architecture-roadmap.md step 10): builds into a
// temporary folder and checks what the phones will get.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapStackText } from "../src/system/sourceMaps.js";

// esbuild is a development tool: the production image (deploy.sh can run the tests inside it) does not have it, so there these tests skip.
const hasEsbuild = await import("esbuild").then(() => true, () => false);
const test = hasEsbuild ? nodeTest : nodeTest.skip;
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.resolve(SERVER, "..", "client", "public");
let out;
let manifest;
const read = (rel) => fs.readFileSync(path.join(out, rel), "utf8");
const builtScripts = () => {
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(out, dir))) {
      const rel = `${dir}/${name}`;
      if (fs.statSync(path.join(out, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith(".js")) files.push(rel);
    }
  })("js");
  return files;
};

before(() => {
  if (!hasEsbuild) return;
  out = fs.mkdtempSync(path.join(os.tmpdir(), "fv-client-build-"));
  execFileSync(process.execPath, [path.join(SERVER, "scripts", "build-client.mjs"), "--out", out], { stdio: "pipe" });
  manifest = JSON.parse(read("build-manifest.json"));
});
after(() => out && fs.rmSync(out, { recursive: true, force: true }));

test("every file loaded by its address keeps it: the boot files, every screen, every text file, the plain scripts", () => {
  const sources = [
    "js/bootGate.js",
    "js/app.js",
    "js/i18n-en.js",
    "js/i18n-hy.js",
    "js/theme-init.js",
    "js/perf-mode-init.js",
    "js/zoom-lock.js",
    "js/browser-check.js",
    ...fs.readdirSync(path.join(PUBLIC, "js", "views")).filter((f) => f.endsWith(".js")).map((f) => `js/views/${f}`),
    ...["en", "hy"].flatMap((lang) => fs.readdirSync(path.join(PUBLIC, "js", "i18n", lang)).map((f) => `js/i18n/${lang}/${f}`)),
  ];
  for (const file of sources) assert.ok(fs.existsSync(path.join(out, file)), `${file} missing from the build`);
});

test("the first screen needs a handful of script files, not the ~100 source modules", () => {
  assert.ok(manifest.modulePreload.length <= 6, `first screen loads ${manifest.modulePreload.length} files: ${manifest.modulePreload.join(", ")}`);
  for (const href of manifest.modulePreload) assert.ok(fs.existsSync(path.join(out, href)), `${href} listed but not built`);
});

test("bootGate.js loads nothing of the app before it opens (Calculator Mode) and the plain scripts stay plain scripts", () => {
  const gate = read("js/bootGate.js");
  assert.doesNotMatch(gate, /^\s*import\s*["'{*\w]/m, "bootGate.js must not import anything statically");
  assert.match(gate, /import\("\.\/app\.js"\)/);
  for (const file of ["theme-init.js", "perf-mode-init.js", "zoom-lock.js", "browser-check.js"]) {
    assert.doesNotMatch(read(`js/${file}`), /\bimport\b[\s\S]*\bfrom\b|\bexport\s*[{\w]/, `${file} must stay a plain script`);
  }
});

test("a text file is one request: it imports nothing; i18n.js fetches them by their address", () => {
  for (const lang of ["en", "hy"]) {
    for (const f of fs.readdirSync(path.join(out, "js", "i18n", lang)).filter((n) => n.endsWith(".js"))) {
      // an import statement (not the word in a text: "import" is in several texts)
      assert.ok(!/(?:^|[;\n])\s*import\s*[{"*\w(]/.test(read(`js/i18n/${lang}/${f}`)), `i18n/${lang}/${f} imports something`);
    }
    assert.match(read(`js/i18n-${lang}.js`), /from"\.\/i18n\/[a-z]+\/common\.js"/, `i18n-${lang}.js should import the text files by address`);
  }
});

test("every import in the build points at a built file", () => {
  for (const file of builtScripts()) {
    const code = read(file);
    for (const m of code.matchAll(/(?:from|import\(?)\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = path.join(path.dirname(path.join(out, file)), m[1]);
      assert.ok(fs.existsSync(target), `${file} imports ${m[1]}, which is not in the build`);
    }
  }
});

test("sw.js lists exactly the built scripts for offline use, plus the non-script files it listed before", () => {
  const sw = read("sw.js");
  const shell = [...sw.match(/const APP_SHELL = \[([\s\S]*?)\n\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const scripts = shell.filter((p) => p.startsWith("/js/")).sort();
  assert.deepEqual(scripts, builtScripts().map((f) => `/${f}`).sort());
  assert.ok(shell.includes("/css/app.css") && shell.includes("/index.html"), "the non-script entries are kept");
  assert.equal(sw.match(/const CACHE_VERSION = "([^"]+)"/)?.[1], fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8").match(/const CACHE_VERSION = "([^"]+)"/)?.[1]);
});

test("an error in a built file is reported with the real file and line (source maps)", () => {
  const marker = "Screen failed to render:";
  const sourceLine = fs.readFileSync(path.join(PUBLIC, "js", "app.js"), "utf8").split("\n").findIndex((l) => l.includes(marker)) + 1;
  assert.ok(sourceLine > 0);
  // where the marker ended up in the build
  const file = builtScripts().find((f) => read(f).includes(marker));
  const lines = read(file).split("\n");
  const line = lines.findIndex((l) => l.includes(marker));
  const column = lines[line].indexOf(marker) + 1;
  const stack = `Error: x\n    at showRenderFailure (https://app.example/${file}:${line + 1}:${column})`;
  const mapped = mapStackText(stack, { enabled: true, distDir: out });
  const m = mapped.match(/\/js\/app\.js:(\d+):\d+/);
  assert.ok(m, `not mapped back to js/app.js: ${mapped}`);
  assert.ok(Math.abs(Number(m[1]) - sourceLine) <= 1, `mapped to line ${m[1]}, the text is on line ${sourceLine}`);
  // untouched without a build, and for addresses that are not built files
  assert.equal(mapStackText(stack, { enabled: false, distDir: out }), stack);
  assert.equal(mapStackText("at x (https://app.example/vendor/leaflet/leaflet.js:1:5)", { enabled: true, distDir: out }), "at x (https://app.example/vendor/leaflet/leaflet.js:1:5)");
});
