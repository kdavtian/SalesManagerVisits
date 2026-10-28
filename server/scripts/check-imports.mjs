// Import check (docs/architecture-roadmap.md, step 1), run by `npm run lint`: every relative import of the server, its scripts and tests,
// and the phone app points at a file that exists, and every name it imports is exported there (directly or through `export * from`).
// A wrong name is otherwise only found when that screen opens: the browser refuses the whole module and the screen stays blank.
// Static imports, re-exports and dynamic `import("./literal.js")` are checked; computed dynamic imports are skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "client/public");
const DIRS = ["server/src", "server/scripts", "server/test", "client/public/js"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const parsed = new Map();
function parse(file) {
  if (!parsed.has(file)) {
    const ast = espree.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", loc: true });
    const exports = new Set();
    const starFrom = [];
    const imports = [];
    for (const n of ast.body) {
      if (n.type === "ImportDeclaration") {
        imports.push({ source: n.source.value, line: n.loc.start.line, names: n.specifiers.filter((s) => s.type === "ImportSpecifier").map((s) => s.imported.name ?? s.imported.value), wantsDefault: n.specifiers.some((s) => s.type === "ImportDefaultSpecifier") });
      } else if (n.type === "ExportDefaultDeclaration") exports.add("default");
      else if (n.type === "ExportNamedDeclaration") {
        if (n.declaration?.id) exports.add(n.declaration.id.name);
        for (const d of n.declaration?.declarations ?? []) collectNames(d.id, exports);
        for (const s of n.specifiers) exports.add(s.exported.name ?? s.exported.value);
        if (n.source) imports.push({ source: n.source.value, line: n.loc.start.line, names: n.specifiers.map((s) => s.local.name ?? s.local.value), wantsDefault: false });
      } else if (n.type === "ExportAllDeclaration") {
        if (n.exported) exports.add(n.exported.name);
        else starFrom.push(n.source.value);
        imports.push({ source: n.source.value, line: n.loc.start.line, names: [], wantsDefault: false });
      }
    }
    (function findDynamic(node) {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "ImportExpression" && node.source.type === "Literal" && typeof node.source.value === "string") {
        imports.push({ source: node.source.value, line: node.loc.start.line, names: [], wantsDefault: false });
      }
      for (const k in node) {
        if (k === "loc") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(findDynamic);
        else if (v && typeof v.type === "string") findDynamic(v);
      }
    })(ast);
    parsed.set(file, { exports, starFrom, imports });
  }
  return parsed.get(file);
}

function collectNames(pattern, into) {
  if (!pattern) return;
  if (pattern.type === "Identifier") into.add(pattern.name);
  else if (pattern.type === "ObjectPattern") pattern.properties.forEach((p) => collectNames(p.value ?? p.argument, into));
  else if (pattern.type === "ArrayPattern") pattern.elements.forEach((e) => collectNames(e, into));
  else if (pattern.type === "RestElement") collectNames(pattern.argument, into);
  else if (pattern.type === "AssignmentPattern") collectNames(pattern.left, into);
}

function resolve(from, source) {
  if (source.startsWith("./") || source.startsWith("../")) return path.resolve(path.dirname(from), source);
  // the phone app also imports by site path ("/js/util.js"); the site root is client/public
  if (source.startsWith("/") && from.startsWith(PUBLIC)) return path.join(PUBLIC, source);
  return null; // a package or a URL: not ours to check
}

function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const { exports, starFrom } = parse(file);
  const all = new Set(exports);
  for (const s of starFrom) {
    const target = resolve(file, s);
    if (target && fs.existsSync(target)) for (const name of exportsOf(target, seen)) if (name !== "default") all.add(name);
  }
  return all;
}

const problems = [];
const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
for (const file of files) {
  let info;
  try {
    info = parse(file);
  } catch (err) {
    problems.push(`${path.relative(ROOT, file)}: cannot be read as a module (${err.message})`);
    continue;
  }
  for (const imp of info.imports) {
    const target = resolve(file, imp.source);
    if (!target) continue;
    const where = `${path.relative(ROOT, file)}:${imp.line}`;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      problems.push(`${where}: "${imp.source}" does not exist`);
      continue;
    }
    if (!/\.(m?js)$/.test(target)) continue;
    const exported = exportsOf(target);
    for (const name of imp.names) if (!exported.has(name)) problems.push(`${where}: "${name}" is not exported by ${imp.source}`);
    if (imp.wantsDefault && !exported.has("default")) problems.push(`${where}: ${imp.source} has no default export`);
  }
}

if (problems.length) {
  console.error(`Import check: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Import check: ${files.length} files, every import found`);
