#!/usr/bin/env node
// Mechanical, behaviour-preserving refactors (docs/architecture-roadmap.md, steps 5-6). Every command rewrites the code with the parser
// (espree + eslint-scope), never by hand, and is followed by `npm run lint` (undefined names, import check) and the tests.
//
//   node server/scripts/refactor.mjs move <mapping.json>
//       Move files or folders ({ "server/src/a.js": "server/src/orders/a.js", ... }, paths from the repo root) with git mv and rewrite every
//       relative import (static, re-export, literal dynamic import) that points at them or out of them, in server/ and client/public/js;
//       site paths of moved client files ("/js/x.js" in sw.js APP_SHELL, index.html, bootGate) and mentions of the old paths in comments
//       and docs are rewritten too.
//
//   node server/scripts/refactor.mjs extract-top <source.js> <target.js> <name...>
//       Move top-level functions / constants of <source> into <target> (created if missing): they are exported there, imported back into
//       <source> where still used, and every other module that imported them from <source> imports them from <target>.
//
//   node server/scripts/refactor.mjs extract-inner <source.js> <outerFunction> <target.js> <namespace> <name...>
//       Move functions declared directly inside one big function (a screen's render function and its shared state) into <target>.
//       Each moved function receives the screen's state as its first parameter `ctx`: every variable of the outer function it uses is
//       read and written through `ctx` (getters / setters on the real variables, so it always sees the current value). In <source> the
//       function keeps its name as a one-line wrapper, so every caller, event listener and hoisting stays as it was.
//       <outerFunction> "-" does the same for top-level functions sharing the module's own variables (a module nothing may import,
//       like app.js): the ctx object then sits before the module's first statement.
//
//   node server/scripts/refactor.mjs wrap <source.js> <outerFunction> <fromLine> <toLine> <name>
//       Turn the statements of <outerFunction> on those lines into an inner function <name>, called where they were (awaited when they
//       await), so extract-inner can move it; refused when that could change what the code does.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import * as eslintScope from "eslint-scope";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(REPO, "client/public");
const CODE_DIRS = ["server/src", "server/test", "server/scripts", "client/public/js"];
const parse = (src) => espree.parse(src, { ecmaVersion: "latest", sourceType: "module", range: true, loc: true, comment: true });
const read = (f) => fs.readFileSync(f, "utf8");
const rel = (fromFile, toFile) => {
  const r = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  return r.startsWith(".") ? r : `./${r}`;
};
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}
const codeFiles = () => CODE_DIRS.flatMap((d) => walk(path.join(REPO, d)));
// apply [start, end, text] edits (non-overlapping) to a string
function applyEdits(src, edits) {
  let out = src;
  for (const [s, e, t] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  return out;
}
function importSpecifiers(src) {
  const ast = parse(src);
  const out = [];
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) out.push(node.source);
    if (node.type === "ImportExpression" && node.source.type === "Literal") out.push(node.source);
    for (const k in node) {
      if (k === "loc" || k === "range") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(ast);
  return out;
}
const resolveSpec = (file, spec) => {
  if (spec.startsWith("./") || spec.startsWith("../")) return path.resolve(path.dirname(file), spec);
  if (spec.startsWith("/") && file.startsWith(PUBLIC)) return path.join(PUBLIC, spec);
  return null;
};

// ---- move ---------------------------------------------------------------------------------------------------------------------------
function move(mappingFile) {
  const raw = JSON.parse(read(mappingFile));
  const moves = new Map();
  for (const [o, n] of Object.entries(raw)) {
    const old = path.join(REPO, o);
    const neu = path.join(REPO, n);
    if (fs.statSync(old).isDirectory()) for (const f of walk(old).concat(fs.readdirSync(old).filter((x) => !/\.m?js$/.test(x)).map((x) => path.join(old, x)).filter((x) => fs.statSync(x).isFile()))) moves.set(f, path.join(neu, path.relative(old, f)));
    else moves.set(old, neu);
  }
  for (const n of moves.values()) if (fs.existsSync(n)) throw new Error(`target exists: ${n}`);
  const changed = new Map();
  for (const f of codeFiles()) {
    const src = read(f);
    const newF = moves.get(f) ?? f;
    const edits = [];
    for (const lit of importSpecifiers(src)) {
      const target = resolveSpec(f, lit.value);
      if (!target) continue;
      const newTarget = moves.get(target) ?? target;
      if (newTarget === target && newF === f) continue;
      const spec = lit.value.startsWith("/") ? "/" + path.relative(PUBLIC, newTarget).split(path.sep).join("/") : rel(newF, newTarget);
      if (spec !== lit.value) edits.push([lit.range[0] + 1, lit.range[1] - 1, spec]);
    }
    if (edits.length) changed.set(f, applyEdits(src, edits));
  }
  for (const [f, out] of changed) fs.writeFileSync(f, out);
  for (const [o, n] of moves) {
    fs.mkdirSync(path.dirname(n), { recursive: true });
    execFileSync("git", ["mv", o, n], { cwd: REPO });
  }
  // site paths of client files and mentions of repo paths in text
  const pairs = [];
  for (const [o, n] of moves) {
    pairs.push([path.relative(REPO, o), path.relative(REPO, n)]);
    if (o.startsWith(PUBLIC)) pairs.push(["/" + path.relative(PUBLIC, o), "/" + path.relative(PUBLIC, n)]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  const textFiles = execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.md", "*.sql", "*.yml", "*.html", "Dockerfile"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const t of textFiles) {
    const p = path.join(REPO, t);
    if (!fs.existsSync(p)) continue;
    const s = read(p);
    let out = s;
    for (const [o, n] of pairs) out = out.replace(new RegExp(o.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "(?![\\w/.-])", "g"), n);
    if (out !== s) fs.writeFileSync(p, out);
  }
  console.log(`moved ${moves.size} files, rewrote imports in ${changed.size} files`);
}

// ---- shared helpers for the extract commands -----------------------------------------------------------------------------------------
function analyze(src) {
  const ast = parse(src);
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
  return { ast, sm, moduleScope: sm.scopes.find((s) => s.type === "module") };
}
const leadingCommentStart = (ast, src, node) => {
  // comment lines directly above the node (no blank line in between) move with it
  let start = node.range[0];
  const comments = ast.comments.filter((c) => c.range[1] <= start).sort((a, b) => b.range[0] - a.range[0]);
  for (const c of comments) {
    const between = src.slice(c.range[1], start);
    // only a comment on a line of its own: a trailing comment ("let x = 1; // note") stays with its own statement
    const ownLine = /^\s*$/.test(src.slice(src.lastIndexOf("\n", c.range[0] - 1) + 1, c.range[0]));
    if (ownLine && /^\s*$/.test(between) && (between.match(/\n/g) ?? []).length <= 1) start = c.range[0];
    else break;
  }
  return src.lastIndexOf("\n", start - 1) + 1;
};
const lineEnd = (src, i) => {
  const n = src.indexOf("\n", i);
  return n < 0 ? src.length : n + 1;
};
// imports and top-level declarations of <source> that the moved code uses, as import lines for <target>
function importsFor(sourceFile, targetFile, srcAst, moduleScope, names, exportFromSource) {
  const lines = [];
  const byModule = new Map();
  for (const name of names) {
    const v = moduleScope.set.get(name);
    if (!v) continue; // a global (window, document, ...)
    const def = v.defs[0];
    if (def.type === "ImportBinding") {
      const decl = def.parent;
      const spec = def.node;
      const absolute = resolveSpec(sourceFile, decl.source.value);
      if (absolute === targetFile) continue; // declared in the target itself (moved there by an earlier run)
      const from = absolute ? (decl.source.value.startsWith("/") ? decl.source.value : rel(targetFile, absolute)) : decl.source.value;
      if (spec.type === "ImportNamespaceSpecifier") lines.push(`import * as ${name} from "${from}";`);
      else if (spec.type === "ImportDefaultSpecifier") lines.push(`import ${name} from "${from}";`);
      else {
        const imported = spec.imported.name ?? spec.imported.value;
        if (!byModule.has(from)) byModule.set(from, []);
        byModule.get(from).push(imported === name ? name : `${imported} as ${name}`);
      }
    } else {
      // a top-level declaration of the source module: export it there, import it here
      exportFromSource.add(name);
      if (!byModule.has(rel(targetFile, sourceFile))) byModule.set(rel(targetFile, sourceFile), []);
      byModule.get(rel(targetFile, sourceFile)).push(name);
    }
  }
  for (const [from, list] of byModule) lines.push(`import { ${[...new Set(list)].sort().join(", ")} } from "${from}";`);
  return lines;
}
// add `export` to top-level declarations of a source that the target now imports
function exportEdits(ast, names) {
  const edits = [];
  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration") continue;
    const declared = node.type === "VariableDeclaration" ? node.declarations.map((d) => d.id.name) : node.id ? [node.id.name] : [];
    if (declared.some((n) => names.has(n))) edits.push([node.range[0], node.range[0], "export "]);
  }
  return edits;
}
function mergeTarget(targetFile, header, importLines, bodyText) {
  if (!fs.existsSync(targetFile)) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, `${header}\n${[...new Set(importLines)].join("\n")}\n\n${bodyText.trim()}\n`);
    return;
  }
  const existing = read(targetFile);
  const have = new Set(existing.split("\n").filter((l) => l.startsWith("import ")));
  const add = [...new Set(importLines)].filter((l) => !have.has(l));
  const lines = existing.split("\n");
  const lastImport = lines.reduce((acc, l, i) => (l.startsWith("import ") ? i : acc), -1);
  lines.splice(lastImport + 1, 0, ...add);
  fs.writeFileSync(targetFile, `${lines.join("\n").trimEnd()}\n\n${bodyText.trim()}\n`);
}

// string literals in moved code that are relative module paths ("./views/x.js" given to import(), a list of screens to preload):
// rebased to the target's folder, so they still point at the same file
function rebaseEdits(node, sourceFile, targetFile) {
  const edits = [];
  if (path.dirname(sourceFile) === path.dirname(targetFile)) return edits;
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Literal" && typeof n.value === "string" && /^\.\.?\/.*\.m?js$/.test(n.value)) {
      const spec = rel(targetFile, path.resolve(path.dirname(sourceFile), n.value));
      edits.push([n.range[0] + 1, n.range[1] - 1, spec]);
    }
    for (const k in n) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(node);
  return edits;
}

// ---- extract-top ----------------------------------------------------------------------------------------------------------------------
function extractTop(sourceRel, targetRel, names) {
  const sourceFile = path.resolve(REPO, sourceRel);
  const targetFile = path.resolve(REPO, targetRel);
  const src = read(sourceFile);
  const { ast, moduleScope } = analyze(src);
  const nodes = [];
  for (const name of names) {
    const node = ast.body.find((n) => {
      const d = n.type === "ExportNamedDeclaration" ? n.declaration : n;
      if (!d) return false;
      if (d.type === "VariableDeclaration") return d.declarations.length === 1 && d.declarations[0].id.name === name;
      return d.id?.name === name;
    });
    if (!node) throw new Error(`${name}: not a top-level declaration of ${sourceRel}`);
    nodes.push([name, node]);
  }
  const moved = new Set(names);
  // what the moved code uses from the module scope (imports, other declarations)
  const uses = new Set();
  for (const v of moduleScope.variables) {
    if (moved.has(v.name)) continue;
    for (const r of v.references) for (const [, node] of nodes) if (r.identifier.range[0] >= node.range[0] && r.identifier.range[1] <= node.range[1]) uses.add(v.name);
  }
  const exportFromSource = new Set();
  const importLines = importsFor(sourceFile, targetFile, ast, moduleScope, uses, exportFromSource);
  // the source imports the target, so the target runs first: a moved value computed at load time from something that stays in the
  // source would read it before it exists (an import cycle, ReferenceError on load). Move what it needs along, or leave it.
  for (const [name, node] of nodes) {
    const eager = [];
    (function collect(n) {
      if (!n || typeof n.type !== "string") return;
      if (/Function/.test(n.type) || n.type === "ClassBody") return; // runs later, when called
      if (n.type === "Identifier") eager.push(n.range);
      for (const k in n) {
        if (k === "loc" || k === "range") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v.type === "string") collect(v);
      }
    })((node.declaration ?? node).type === "VariableDeclaration" ? (node.declaration ?? node).declarations[0].init : null);
    for (const dep of exportFromSource) {
      const r = moduleScope.set.get(dep).references.find((ref) => eager.some(([a, b]) => ref.identifier.range[0] === a && ref.identifier.range[1] === b));
      if (r) throw new Error(`${name} is computed at load time from ${dep}, which stays in ${sourceRel}: move ${dep} too`);
    }
  }
  const pieces = nodes.map(([, node]) => {
    const start = leadingCommentStart(ast, src, node);
    const text = applyEdits(src.slice(start, lineEnd(src, node.range[1])), rebaseEdits(node, sourceFile, targetFile).map(([a, b, t]) => [a - start, b - start, t]));
    return node.type === "ExportNamedDeclaration" ? text : text.replace(/^(\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*)/, "$1export ");
  });
  const removeEdits = removalEdits(src, nodes.map(([, node]) => [leadingCommentStart(ast, src, node), lineEnd(src, node.range[1])]));
  // still used in the source? import them back
  const stillUsed = names.filter((n) => moduleScope.set.get(n).references.some((r) => !nodes.some(([, node]) => r.identifier.range[0] >= node.range[0] && r.identifier.range[1] <= node.range[1])));
  const exported = names.filter((n) => nodes.find(([m]) => m === n)[1].type === "ExportNamedDeclaration");
  let out = applyEdits(src, [...removeEdits, ...exportEdits(ast, exportFromSource)]);
  if (stillUsed.length) out = addImportLine(out, `import { ${stillUsed.join(", ")} } from "${rel(sourceFile, targetFile)}";`);
  fs.writeFileSync(sourceFile, out);
  pruneImports(sourceFile);
  mergeTarget(targetFile, `// Moved out of ${path.basename(sourceFile)} (docs/architecture-roadmap.md, step 6).`, importLines, pieces.join("\n"));
  // importers of the exported names now import them from the target
  if (exported.length) for (const f of codeFiles()) if (f !== sourceFile && f !== targetFile) retargetImports(f, sourceFile, targetFile, new Set(exported));
  console.log(`moved ${names.length} declarations to ${targetRel}`);
}
// drop import names nothing uses any more (they moved out with the code that used them)
function pruneImports(file) {
  const src = read(file);
  const { ast, moduleScope } = analyze(src);
  const edits = [];
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || !node.specifiers.length) continue;
    const unused = node.specifiers.filter((s) => (moduleScope.set.get(s.local.name)?.references.length ?? 0) === 0);
    if (!unused.length) continue;
    const keep = node.specifiers.filter((s) => !unused.includes(s));
    const text = (s) => src.slice(s.range[0], s.range[1]);
    if (!keep.length) edits.push([node.range[0], lineEnd(src, node.range[1]), ""]);
    else {
      const def = keep.find((s) => s.type === "ImportDefaultSpecifier");
      const ns = keep.find((s) => s.type === "ImportNamespaceSpecifier");
      const named = keep.filter((s) => s.type === "ImportSpecifier");
      const parts = [def ? text(def) : null, ns ? text(ns) : null, named.length ? `{ ${named.map(text).join(", ")} }` : null].filter(Boolean);
      edits.push([node.range[0], node.range[1], `import ${parts.join(", ")} from ${src.slice(node.source.range[0], node.source.range[1])};`]);
    }
  }
  // a file whose only imports went away does not start with an empty line
  if (edits.length) fs.writeFileSync(file, applyEdits(src, edits).replace(/^\n+/, ""));
}
function addImportLine(src, line) {
  // right after the last import statement (its own line end, so a trailing comment stays where it was)
  const imports = parse(src).body.filter((n) => n.type === "ImportDeclaration");
  if (!imports.length) return `${line}\n${src}`;
  const at = lineEnd(src, imports.at(-1).range[1]);
  return `${src.slice(0, at)}${line}\n${src.slice(at)}`;
}
// removal edits for whole-line ranges: touching ranges become one, and a removed block between two blank lines takes one of them
// along, so no run of empty lines is left behind
function removalEdits(src, ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => {
    const blankBefore = start >= 2 && src.slice(start - 2, start) === "\n\n";
    const next = src.indexOf("\n", end);
    if (blankBefore && next >= 0 && /^[ \t]*$/.test(src.slice(end, next))) return [start, next + 1, ""];
    return [start, end, ""];
  });
}
function retargetImports(file, sourceFile, targetFile, names) {
  const src = read(file);
  if (!src.includes(path.basename(sourceFile))) return;
  const ast = parse(src);
  const edits = [];
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || resolveSpec(file, node.source.value) !== sourceFile) continue;
    const named = node.specifiers.filter((s) => s.type === "ImportSpecifier");
    const movedSpecs = named.filter((s) => names.has(s.imported.name));
    if (!movedSpecs.length) continue;
    const keep = node.specifiers.filter((s) => !movedSpecs.includes(s));
    const text = (s) => src.slice(s.range[0], s.range[1]);
    const spec = node.source.value.startsWith("/") ? "/" + path.relative(PUBLIC, targetFile).split(path.sep).join("/") : rel(file, targetFile);
    let line = `import { ${movedSpecs.map(text).join(", ")} } from "${spec}";`;
    if (keep.length) {
      const def = keep.find((s) => s.type === "ImportDefaultSpecifier");
      const rest = keep.filter((s) => s.type === "ImportSpecifier");
      line = `import ${[def ? text(def) : null, rest.length ? `{ ${rest.map(text).join(", ")} }` : null].filter(Boolean).join(", ")} from "${node.source.value}";\n${line}`;
    }
    edits.push([node.range[0], node.range[1], line]);
  }
  if (edits.length) fs.writeFileSync(file, applyEdits(src, edits));
}

// ---- extract-inner --------------------------------------------------------------------------------------------------------------------
function extractInner(sourceRel, outerName, targetRel, namespace, names) {
  const sourceFile = path.resolve(REPO, sourceRel);
  const targetFile = path.resolve(REPO, targetRel);
  const src = read(sourceFile);
  const { ast, sm, moduleScope } = analyze(src);
  // outerName "-": the functions are top-level ones and the shared state is the module's own variables (app.js, which no other
  // module may import)
  const moduleMode = outerName === "-";
  const top = moduleMode ? null : ast.body.find((n) => (n.declaration ?? n).id?.name === outerName);
  if (!moduleMode && !top) throw new Error(`${outerName}: not a top-level function of ${sourceRel}`);
  const outer = moduleMode ? null : top.declaration ?? top;
  const outerScope = moduleMode ? moduleScope : sm.acquire(outer);
  const statements = moduleMode ? ast.body : outer.body.body;
  const pad = moduleMode ? "" : "  ";
  const CTX = "ctx";
  if (moduleScope.set.has(namespace)) throw new Error(`name clash: ${namespace}`);
  // a ctx made by an earlier run is extended; any other variable called ctx is a clash
  let ctxDecl = null;
  if (outerScope.set.has(CTX)) {
    ctxDecl = outerScope.set.get(CTX).defs[0]?.node;
    if (ctxDecl?.init?.type !== "ObjectExpression" || ctxDecl.init.properties.some((p) => p.kind !== "get" && p.kind !== "set")) throw new Error(`name clash: ${CTX}`);
  }
  const ctxNames = new Map(); // name -> { write: bool }
  const pieces = [];
  const edits = [];
  const moduleUses = new Set();
  for (const name of names) {
    const node = statements.find((s) => s.type === "FunctionDeclaration" && s.id.name === name);
    if (!node) throw new Error(`${name}: not a function declared directly in ${moduleMode ? sourceRel : outerName}${moduleMode ? " (exported ones stay)" : ""}`);
    const scope = sm.acquire(node);
    // `this` / `arguments` of the moved function itself would change meaning
    (function noThis(n, top) {
      if (!n || typeof n.type !== "string") return;
      if (!top && /^Function(Declaration|Expression)$/.test(n.type)) return;
      if (n.type === "ThisExpression") throw new Error(`${name} uses this`);
      if (n.type === "Identifier" && n.name === "arguments") throw new Error(`${name} uses arguments`);
      for (const k in n) {
        if (k === "loc" || k === "range") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => noThis(c, false));
        else if (v && typeof v.type === "string") noThis(v, false);
      }
    })(node, true);
    if (scope.set.has(CTX)) throw new Error(`${name} already has a variable ${CTX}`);
    const local = [];
    const all = [];
    (function collect(s) {
      all.push(...s.references);
      s.childScopes.forEach(collect);
    })(scope);
    for (const r of all) {
      if (!r.resolved) continue;
      if (r.resolved.scope === outerScope && !(moduleMode && r.resolved.defs[0]?.type === "ImportBinding")) {
        const entry = ctxNames.get(r.identifier.name) ?? { write: false };
        if (r.isWrite()) entry.write = true;
        ctxNames.set(r.identifier.name, entry);
        local.push(r.identifier);
      } else if (r.resolved.scope === moduleScope) moduleUses.add(r.identifier.name);
    }
    // the moved text, with the outer function's variables read through ctx
    const start = leadingCommentStart(ast, src, node);
    const idEdits = [];
    const parentOf = new Map();
    (function link(n, parent) {
      if (!n || typeof n.type !== "string") return;
      parentOf.set(n, parent);
      for (const k in n) {
        if (k === "loc" || k === "range") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => link(c, n));
        else if (v && typeof v.type === "string") link(v, n);
      }
    })(node, null);
    for (const id of local) {
      const p = parentOf.get(id);
      if (p?.type === "Property" && p.shorthand && p.value === id) idEdits.push([id.range[0], id.range[1], `${id.name}: ${CTX}.${id.name}`]);
      else idEdits.push([id.range[0], id.range[1], `${CTX}.${id.name}`]);
    }
    const shift = (e) => [e[0] - start, e[1] - start, e[2]];
    let text = applyEdits(src.slice(start, node.range[1]), [...idEdits, ...rebaseEdits(node, sourceFile, targetFile)].map(shift));
    // signature: (ctx, ...original params)
    const headRe = new RegExp(`(^|\\n)(\\s*)(async\\s+)?function(\\s*\\*)?\\s+${name}\\s*\\(`);
    if (!headRe.test(text)) throw new Error(`${name}: could not read its signature`);
    text = text.replace(headRe, (m, nl, ind, asy, gen) => `${nl}${ind}export ${asy ?? ""}function${gen ?? ""} ${name}(${CTX}${node.params.length ? ", " : ""}`);
    const indent = src.slice(src.lastIndexOf("\n", node.range[0] - 1) + 1, node.range[0]).match(/^\s*/)[0];
    // dedent, except lines inside a multi-line template string (their spaces are part of the text)
    const templates = [];
    (function findTemplates(n) {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "TemplateLiteral") templates.push(n.range);
      for (const k in n) {
        if (k === "loc" || k === "range") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(findTemplates);
        else if (v && typeof v.type === "string") findTemplates(v);
      }
    })(node);
    const lineStarts = [start];
    for (let i = src.indexOf("\n", start); i >= 0 && i < node.range[1]; i = src.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    const inTemplate = (i) => templates.some(([a, b]) => lineStarts[i] > a && lineStarts[i] < b);
    pieces.push(text.split("\n").map((l, i) => (inTemplate(i) ? l : l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join("\n"));
    // in the source: a one-line wrapper with the same name (hoisted like the original)
    if (node.generator) throw new Error(`${name} is a generator`);
    const wrapIndent = src.slice(src.lastIndexOf("\n", node.range[0] - 1) + 1, node.range[0]).match(/^\s*/)[0];
    edits.push([start, lineEnd(src, node.range[1]), `${wrapIndent}function ${name}(...args) { return ${namespace}.${name}(${CTX}, ...args); }\n`]);
  }
  // the context object: one getter (and a setter where a moved function assigns) per variable, created first thing in the function
  const have = new Set((ctxDecl?.init.properties ?? []).map((p) => `${p.kind}:${p.key.name}`));
  const props = [...ctxNames]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, { write }]) =>
      // one line per variable, so a big screen's ctx stays short
      [have.has(`get:${n}`) ? "" : `get ${n}() { return ${n}; },`, write && !have.has(`set:${n}`) ? `set ${n}(v) { ${n} = v; },` : ""].filter(Boolean).join(" ")
    )
    .filter(Boolean)
    .map((line) => `${pad}  ${line}`)
    .join("\n");
  if (ctxDecl) {
    const at = src.lastIndexOf("\n", ctxDecl.init.range[1] - 1) + 1; // the line of the closing brace
    if (props) edits.push([at, at, `${props}\n`]);
  } else {
    const note = `${pad}// The ${moduleMode ? "module" : "screen"}'s variables, for its parts in other files (read and written through getters / setters, so they always see the current value).`;
    if (moduleMode) {
      // before the module's first statement, so code that runs while the module loads can already call the wrappers
      const first = ast.body.find((n) => n.type !== "ImportDeclaration");
      const at = leadingCommentStart(ast, src, first);
      edits.push([at, at, `${note}\nconst ${CTX} = {\n${props}\n};\n\n`]);
    } else {
      const bodyStart = outer.body.range[0] + 1;
      edits.push([bodyStart, bodyStart, `\n${note}\n  const ${CTX} = {\n${props}\n  };`]);
    }
  }
  const exportFromSource = new Set();
  const importLines = importsFor(sourceFile, targetFile, ast, moduleScope, moduleUses, exportFromSource);
  let out = applyEdits(src, [...edits, ...exportEdits(ast, exportFromSource)]);
  out = addImportLine(out, `import * as ${namespace} from "${rel(sourceFile, targetFile)}";`);
  fs.writeFileSync(sourceFile, out);
  pruneImports(sourceFile);
  const owner = moduleMode ? path.basename(sourceFile) : `${outerName} (${path.basename(sourceFile)})`;
  mergeTarget(targetFile, `// Parts of ${owner}, moved out with the refactor tool (docs/architecture-roadmap.md, step 6). Each\n// function takes the shared state as \`ctx\` (see the ctx object at the top of ${moduleMode ? path.basename(sourceFile) : outerName}).`, importLines, pieces.join("\n\n"));
  console.log(`moved ${names.length} functions of ${outerName} to ${targetRel} (${ctxNames.size} shared variables)`);
}

// ---- wrap ------------------------------------------------------------------------------------------------------------------------------
// Turn statements of a big function (lines <from>..<to>: a block of event wiring, an admin-only `if`, the screen's markup) into an inner
// function called at the same place, so extract-inner can then move it. Refused when that could change what the code does: a
// declaration in the range used after it, a `return` / `yield` / `this` / `arguments` of the outer function, a jump out of the range.
function wrap(sourceRel, outerName, from, to, name) {
  const sourceFile = path.resolve(REPO, sourceRel);
  const src = read(sourceFile);
  const { ast, sm } = analyze(src);
  const top = ast.body.find((n) => (n.declaration ?? n).id?.name === outerName);
  if (!top) throw new Error(`${outerName}: not a top-level function of ${sourceRel}`);
  const outer = top.declaration ?? top;
  const outerScope = sm.acquire(outer);
  if (outerScope.set.has(name)) throw new Error(`name clash: ${name}`);
  const body = outer.body.body;
  const inRange = body.filter((st) => st.loc.start.line >= from && st.loc.end.line <= to);
  const cut = body.find((st) => !inRange.includes(st) && st.loc.start.line <= to && st.loc.end.line >= from);
  if (cut) throw new Error(`the statement at line ${cut.loc.start.line} (to ${cut.loc.end.line}) is only partly inside ${from}-${to}`);
  if (!inRange.length) throw new Error(`no statement of ${outerName} lies within lines ${from}-${to}`);
  const [first, last] = [inRange[0], inRange.at(-1)];
  let usesAwait = false;
  (function check(n, fnDepth, arrowDepth) {
    if (!n || typeof n.type !== "string") return;
    const isFn = /^Function(Declaration|Expression)$/.test(n.type);
    const isArrow = n.type === "ArrowFunctionExpression";
    if (fnDepth === 0) {
      if (n.type === "ReturnStatement" && arrowDepth === 0) throw new Error(`line ${n.loc.start.line}: a return of ${outerName}`);
      if (n.type === "YieldExpression") throw new Error(`line ${n.loc.start.line}: yield`);
      if (n.type === "ThisExpression") throw new Error(`line ${n.loc.start.line}: this`);
      if (n.type === "Identifier" && n.name === "arguments") throw new Error(`line ${n.loc.start.line}: arguments`);
      if ((n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await)) && arrowDepth === 0) usesAwait = true;
      if ((n.type === "BreakStatement" || n.type === "ContinueStatement") && n.label && arrowDepth === 0) {
        const label = n.label.name;
        let declared = false;
        (function find(m) {
          if (!m || typeof m.type !== "string") return;
          if (m.type === "LabeledStatement" && m.label.name === label) declared = true;
          for (const k in m) {
            if (k === "loc" || k === "range") continue;
            const v = m[k];
            if (Array.isArray(v)) v.forEach(find);
            else if (v && typeof v.type === "string") find(v);
          }
        })({ type: "Program", body: inRange });
        if (!declared) throw new Error(`line ${n.loc.start.line}: jumps to label ${label} outside the range`);
      }
    }
    for (const k in n) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      const next = (c) => check(c, fnDepth + (isFn ? 1 : 0), arrowDepth + (isArrow ? 1 : 0));
      if (Array.isArray(v)) v.forEach(next);
      else if (v && typeof v.type === "string") next(v);
    }
  })({ type: "Program", body: inRange }, 0, 0);
  // the outer function's own variables declared in the range (a const / let / function at its top level, a var anywhere) must not be
  // used outside it: after wrapping they live inside the new function
  const [a, b] = [first.range[0], last.range[1]];
  for (const v of outerScope.variables) {
    if (!v.defs.some((d) => d.name.range[0] >= a && d.name.range[1] <= b)) continue;
    const outside = v.references.find((r) => r.identifier.range[0] < a || r.identifier.range[1] > b);
    if (outside) throw new Error(`${v.name} is declared in the range and used at line ${outside.identifier.loc.start.line}`);
  }
  // re-indent by two spaces, except lines inside a multi-line template string (their spaces are part of the text)
  const templates = [];
  (function findTemplates(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "TemplateLiteral") templates.push(n.range);
    for (const k in n) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(findTemplates);
      else if (v && typeof v.type === "string") findTemplates(v);
    }
  })({ type: "Program", body: inRange });
  const start = src.lastIndexOf("\n", a - 1) + 1;
  const end = lineEnd(src, b);
  const indent = src.slice(start, a).match(/^\s*/)[0];
  let offset = start;
  const lines = src.slice(start, end).replace(/\n$/, "").split("\n").map((l) => {
    const at = offset;
    offset += l.length + 1;
    if (!l.trim() || templates.some(([ta, tb]) => at > ta && at < tb)) return l;
    return `  ${l}`;
  });
  const text = `${indent}${usesAwait ? "async " : ""}function ${name}() {\n${lines.join("\n")}\n${indent}}\n${indent}${usesAwait ? "await " : ""}${name}();\n`;
  fs.writeFileSync(sourceFile, applyEdits(src, [[start, end, text]]));
  console.log(`wrapped lines ${first.loc.start.line}-${last.loc.end.line} of ${outerName} as ${usesAwait ? "async " : ""}${name}()`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "move") move(args[0]);
else if (cmd === "extract-top") extractTop(args[0], args[1], args.slice(2));
else if (cmd === "extract-inner") extractInner(args[0], args[1], args[2], args[3], args.slice(4));
else if (cmd === "wrap") wrap(args[0], args[1], Number(args[2]), Number(args[3]), args[4]);
else if (cmd === "prune-imports") args.forEach((f) => pruneImports(path.resolve(REPO, f)));
else {
  console.error("usage: refactor.mjs move <mapping.json> | extract-top <source> <target> <name...> | extract-inner <source> <outer|-> <target> <namespace> <name...> | wrap <source> <outer> <fromLine> <toLine> <name> | prune-imports <file...>");
  process.exit(2);
}
