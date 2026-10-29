// The app loads ONE language file per device (client/public/js/i18n.js), with no fallback to the other: a key missing from either file would
// show as the raw key name. Every key must exist in both, with a non-empty text.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "client", "public", "js");
const load = async (name) => (await import(pathToFileURL(path.join(jsDir, name)).href)).default;

test("English and Armenian texts have exactly the same keys, none empty", async () => {
  const en = await load("i18n-en.js");
  const hy = await load("i18n-hy.js");
  const missingInHy = Object.keys(en).filter((k) => !(k in hy));
  const missingInEn = Object.keys(hy).filter((k) => !(k in en));
  assert.deepEqual(missingInHy, [], "keys missing from i18n-hy.js");
  assert.deepEqual(missingInEn, [], "keys missing from i18n-en.js");
  for (const [name, dict] of [["en", en], ["hy", hy]]) {
    const empty = Object.keys(dict).filter((k) => typeof dict[k] !== "string" || dict[k].trim() === "");
    assert.deepEqual(empty, [], `empty texts in ${name}`);
  }
});

// Step 8b: the texts live in i18n/<lang>/<area>.js. The same area holds the same keys in both languages (a key in en/orders.js but
// hy/common.js would pass the check above yet be in a different file once areas load separately), every area file is joined (AREAS in
// i18n-<lang>.js lists them all), and theme-init.js starts loading exactly those files.
test("each area file has the same keys in English and Armenian, and every area file is listed and preloaded", async () => {
  const fs = await import("node:fs");
  const areaFiles = (lang) => fs.readdirSync(path.join(jsDir, "i18n", lang)).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, "")).sort();
  const en = areaFiles("en");
  assert.deepEqual(areaFiles("hy"), en, "the same area files in both languages");
  for (const lang of ["en", "hy"]) {
    const { AREAS } = await import(pathToFileURL(path.join(jsDir, `i18n-${lang}.js`)).href);
    assert.deepEqual([...AREAS].sort(), en, `AREAS in i18n-${lang}.js lists every area file`);
  }
  const themeInit = fs.readFileSync(path.join(jsDir, "theme-init.js"), "utf8");
  const preloaded = JSON.parse(themeInit.match(/var areas = (\[[^\]]*\])/)[1]).sort();
  assert.deepEqual(preloaded, en, "theme-init.js preloads every area file");
  for (const area of en) {
    const keys = async (lang) => Object.keys(Object.values(await import(pathToFileURL(path.join(jsDir, "i18n", lang, `${area}.js`)).href))[0]).sort();
    const [a, b] = [await keys("en"), await keys("hy")];
    assert.deepEqual(a.filter((k) => !b.includes(k)), [], `keys in en/${area}.js missing from hy/${area}.js`);
    assert.deepEqual(b.filter((k) => !a.includes(k)), [], `keys in hy/${area}.js missing from en/${area}.js`);
  }
});
