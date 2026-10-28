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
