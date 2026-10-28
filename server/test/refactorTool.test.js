// The refactor tool (server/scripts/refactor.mjs) moves code without changing what it does: a screen whose inner functions moved to
// another file (reading and writing the screen's variables through ctx) gives the same results as before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/refactor.mjs");

const SCREEN = `import { twice } from "./helper.js";
const LIMIT = 10;
export function render(root) {
  let count = 0;
  const items = [];
  const label = "n";
  // adds one item and returns the new count
  function add(x = 1) {
    count += x;
    items.push({ count, label });
    if (count > LIMIT) count = LIMIT;
    return twice(count);
  }
  function summary() {
    return \`\${label}:\${count}:\${items.length}:\${root}\`;
  }
  async function later() {
    return add(2);
  }
  const btn = { onClick: add };
  return { add, summary, later, btn, get count() { return count; } };
}
`;
async function run(dir) {
  const { render } = await import(pathToFileURL(path.join(dir, "screen.js")).href + `?${Math.random()}`);
  const s = render("R");
  s.add();
  s.btn.onClick(3);
  await s.later();
  for (let i = 0; i < 5; i++) s.add();
  return [s.summary(), s.count, s.add(0)];
}

test("extract-inner keeps the behaviour: reads and writes of the screen's variables go through ctx", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "helper.js"), "export const twice = (n) => n * 2;\n");
  fs.writeFileSync(path.join(dir, "screen.js"), SCREEN);
  const before = await run(dir);
  execFileSync("node", [TOOL, "extract-inner", path.join(dir, "screen.js"), "render", path.join(dir, "parts/screenParts.js"), "parts", "add", "summary", "later"]);
  const moved = fs.readFileSync(path.join(dir, "parts/screenParts.js"), "utf8");
  assert.match(moved, /export function add\(ctx, x = 1\) \{\n {2}ctx\.count \+= x;/);
  assert.match(moved, /ctx\.items\.push\(\{ count: ctx\.count, label: ctx\.label \}\)/);
  assert.match(fs.readFileSync(path.join(dir, "screen.js"), "utf8"), /function add\(\.\.\.args\) \{ return parts\.add\(ctx, \.\.\.args\); \}/);
  assert.deepEqual(await run(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extract-top into another folder: relative module paths in the moved code still point at the same files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "helper.js"), "export const twice = (n) => n * 2;\n");
  fs.writeFileSync(
    path.join(dir, "boot.js"),
    `import { twice } from "./helper.js";

// screens warmed at start
const SCREENS = ["./helper.js"];
export async function load() {
  const m = await import("./helper.js");
  const all = await Promise.all(SCREENS.map((p) => import(p)));
  return m.twice(2) + all[0].twice(3) + twice(1);
}

export const other = 1;
`
  );
  execFileSync("node", [TOOL, "extract-top", path.join(dir, "boot.js"), path.join(dir, "shell/load.js"), "SCREENS", "load"]);
  const moved = fs.readFileSync(path.join(dir, "shell/load.js"), "utf8");
  assert.match(moved, /const SCREENS = \["\.\.\/helper\.js"\];/);
  assert.match(moved, /await import\("\.\.\/helper\.js"\)/);
  assert.match(moved, /import \{ twice \} from "\.\.\/helper\.js";/);
  const { load } = await import(pathToFileURL(path.join(dir, "shell/load.js")).href);
  assert.equal(await load(), 4 + 6 + 2);
  // what is left of the source: no run of empty lines where the code was
  assert.equal(fs.readFileSync(path.join(dir, "boot.js"), "utf8"), "export const other = 1;\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extract-inner with \"-\": top-level functions move, the module's own variables are shared through ctx", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "helper.js"), "export const twice = (n) => n * 2;\n");
  fs.writeFileSync(
    path.join(dir, "main.js"),
    `import { twice } from "./helper.js";

let total = 0;
const box = { value: 0 };
function bump(x) {
  total += x;
  box.value = total;
  return doubled();
}
function doubled() {
  return twice(total);
}
export function api() {
  return [bump(2), bump(3), total, box.value, doubled()];
}
`
  );
  const before = (await import(pathToFileURL(path.join(dir, "main.js")).href + "?a")).api();
  execFileSync("node", [TOOL, "extract-inner", path.join(dir, "main.js"), "-", path.join(dir, "parts/counter.js"), "counter", "bump", "doubled"]);
  const main = fs.readFileSync(path.join(dir, "main.js"), "utf8");
  assert.match(main, /^const ctx = \{\n {2}get box\(\) \{ return box; \},/m);
  assert.match(main, /get total\(\) \{ return total; \}, set total\(v\) \{ total = v; \},/);
  assert.match(main, /^function bump\(\.\.\.args\) \{ return counter\.bump\(ctx, \.\.\.args\); \}$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "parts/counter.js"), "utf8"), /from "\.\.\/main\.js"/); // the part never imports main.js
  assert.deepEqual((await import(pathToFileURL(path.join(dir, "main.js")).href + "?b")).api(), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extract-inner keeps the text of multi-line template strings exactly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(dir, "share.js"),
    `export function render(name) {
  function message() {
    return \`Route for \${name}:
  1. first stop
    2. second stop\`;
  }
  return message();
}
`
  );
  const before = (await import(pathToFileURL(path.join(dir, "share.js")).href + "?a")).render("Ani");
  execFileSync("node", [TOOL, "extract-inner", path.join(dir, "share.js"), "render", path.join(dir, "parts/share.js"), "shareParts", "message"]);
  assert.match(fs.readFileSync(path.join(dir, "parts/share.js"), "utf8"), /^export function message\(ctx\) \{\n {2}return `Route/m);
  assert.equal((await import(pathToFileURL(path.join(dir, "share.js")).href + "?b")).render("Ani"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("wrap: statements become an inner function called in place (awaited when they await); unsafe ranges are refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const file = path.join(dir, "screen.js");
  fs.writeFileSync(
    file,
    `export async function render(log) {
  let n = 1;
  const seen = [];
  if (n > 0) {
    const step = await Promise.resolve(2);
    n += step;
    seen.push(\`n=\${n}
  (two spaces kept)\`);
  }
  const later = n * 10;
  seen.push(later);
  log(seen);
  return n;
}
`
  );
  const runIt = async (tag) => {
    const out = [];
    const n = await (await import(pathToFileURL(file).href + tag)).render((x) => out.push(...x));
    return [n, out];
  };
  const before = await runIt("?a");
  // line 10 declares `later`, used on line 11: refused, file untouched
  assert.throws(() => execFileSync("node", [TOOL, "wrap", file, "render", "4", "10", "bump"], { stdio: "pipe" }), /later is declared in the range/);
  // a range that cuts a statement in half: refused
  assert.throws(() => execFileSync("node", [TOOL, "wrap", file, "render", "4", "6", "bump"], { stdio: "pipe" }), /only partly inside/);
  execFileSync("node", [TOOL, "wrap", file, "render", "4", "9", "bump"]);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\n {2}async function bump\(\) \{\n {4}if \(n > 0\) \{/);
  assert.match(text, /\n {2}\(two spaces kept\)`\);/);
  assert.match(text, /\n {2}await bump\(\);\n {2}const later/);
  assert.deepEqual(await runIt("?b"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extract-top refuses a moved value computed at load time from something left in the source (import cycle)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const file = path.join(dir, "src.js");
  const text = "const base = 1;\nconst derived = base + 1;\nexport function read() {\n  return derived;\n}\n";
  fs.writeFileSync(file, text);
  assert.throws(() => execFileSync("node", [TOOL, "extract-top", file, path.join(dir, "part.js"), "derived"], { stdio: "pipe" }), /derived is computed at load time from base/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(fs.existsSync(path.join(dir, "part.js")), false);
  // moving what it needs along is fine
  execFileSync("node", [TOOL, "extract-top", file, path.join(dir, "part.js"), "base", "derived"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
