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
