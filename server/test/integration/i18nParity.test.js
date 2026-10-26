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
