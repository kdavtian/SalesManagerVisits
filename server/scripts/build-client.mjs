// Bundles the phone app's scripts for deploy (docs/architecture-roadmap.md step 10, owner decision 1 = A).
//
// The source in client/public stays file-per-module: local runs, the tests and the code you read are unchanged. This script writes
// client/dist (git-ignored), which the server serves in front of client/public when it exists (server/src/app.js):
//   - js/bootGate.js, js/app.js, every screen (js/views/*.js), the text files (js/i18n/**) and the few modules the browser tests import
//     keep their usual address; each is minified with the code only it uses inlined;
//   - code several of them share goes into js/chunks/<name>-<hash>.js (a new hash per change, so an old copy is never served for a new one);
//   - the 4 plain scripts index.html loads first (theme-init.js, ...) are minified as they are;
//   - source maps (.map) next to every file, so an error report still names the real file and line;
//   - sw.js with APP_SHELL listing the built files instead of the source files (its own bytes change with every build, so phones update);
//   - build-manifest.json: the files the first screen needs, for the <link rel="modulepreload"> hints (server/src/system/modulePreload.js).
//
// Run: node server/scripts/build-client.mjs   (the Dockerfile runs it; `--out <dir>` writes elsewhere)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(root, "client", "public");
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, "client", "dist");

// Safari 15 / Chrome 92 and newer (browser-check.js turns older browsers away): top-level await and ES2022 syntax stay as written.
const TARGET = ["es2022", "safari15", "chrome92"];
// Plain (non-module) scripts index.html loads before the app: minified one by one, never bundled.
const CLASSIC_SCRIPTS = ["theme-init.js", "perf-mode-init.js", "zoom-lock.js", "browser-check.js"];
// Modules the browser tests import by their address (page.evaluate(() => import("/js/..."))): they must exist at that address in the
// build and share their state with the app's copy (they become entries, so their code sits in the shared chunk the app uses too).
const TEST_IMPORTED = ["api.js", "i18n.js", "util.js", "orderDetailSheet.js", "statusBarTap.js", "activityDatePicker.js"];
// The first screens after boot (the login form or Home): their files are preloaded with the app's own.
const FIRST_SCREENS = ["js/views/login.js", "js/views/dashboard.js"];

const rel = (file) => path.relative(src, file).split(path.sep).join("/");
const list = (dir) => fs.readdirSync(path.join(src, dir)).filter((f) => f.endsWith(".js")).map((f) => `${dir}/${f}`);

function entryPoints() {
  const textDirs = fs.readdirSync(path.join(src, "js", "i18n")).map((lang) => `js/i18n/${lang}`);
  return [
    "js/bootGate.js",
    "js/app.js",
    "js/i18n-en.js",
    "js/i18n-hy.js",
    ...list("js/views"),
    ...textDirs.flatMap(list),
    ...TEST_IMPORTED.map((f) => `js/${f}`),
  ];
}

// The text files are entries of their own and are also imported by the joining files (i18n-en.js / i18n-hy.js): those imports stay
// imports of the text file's own address, so a text file is never split into a shared chunk (one request each, as i18n.js expects).
const keepTextFilesApart = {
  name: "keep-text-files-apart",
  setup(build) {
    build.onResolve({ filter: /^\.\/i18n\/[a-z]+\/[a-zA-Z]+\.js$/ }, (args) =>
      rel(args.importer) === "js/i18n-en.js" || rel(args.importer) === "js/i18n-hy.js" ? { path: args.path, external: true } : undefined
    );
  },
};

// The modules the first screen needs (app.js, everything it imports, the first screens' imports): ONE shared chunk instead of the ~20 that
// esbuild's automatic splitting cuts them into (it makes one chunk per set of entries using a module, and every screen uses a different
// subset). Every entry imports the whole group (an import of modules app.js has already run does nothing), so they all share it.
async function firstScreenModules(entries) {
  const { metafile } = await esbuild.build({ absWorkingDir: src, entryPoints: entries, bundle: true, splitting: true, format: "esm", outdir: "/", write: false, metafile: true, logLevel: "silent", plugins: [keepTextFilesApart] });
  const inputs = metafile.inputs;
  const group = new Set();
  const queue = ["js/app.js", ...FIRST_SCREENS];
  while (queue.length) {
    const file = queue.shift();
    if (group.has(file) || !inputs[file]) continue;
    group.add(file);
    for (const imp of inputs[file].imports) if (imp.kind === "import-statement" && !imp.external) queue.push(imp.path);
  }
  // app.js and the first screens stay files of their own (bootGate.js / the router load them by address); a screen or test module the
  // first screen imports (views/homeKpis.js, i18n.js, ...) goes into the group like any other module
  for (const file of ["js/app.js", ...FIRST_SCREENS]) group.delete(file);
  return [...group];
}

function shareFirstScreenModules(entries, group) {
  // not the text files (plain data, one request each) and not bootGate.js: in Calculator Mode nothing of the app may load before the
  // unlock code, and the group must run after the gate, as app.js's imports
  const entrySet = new Set(entries.filter((e) => !e.startsWith("js/i18n/") && e !== "js/bootGate.js"));
  const groupImports = group.map((f) => `import ${JSON.stringify(path.join(src, f))};`).join("\n");
  return {
    name: "share-first-screen-modules",
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, async (args) => {
        if (!entrySet.has(rel(args.path))) return undefined;
        const source = await fs.promises.readFile(args.path, "utf8");
        // appended at the end so the source map's line numbers stay those of the file
        return { contents: `${source}\n${groupImports}\n`, loader: "js" };
      });
    },
  };
}

async function build() {
  fs.rmSync(out, { recursive: true, force: true });
  const entries = entryPoints();
  const group = await firstScreenModules(entries);
  const result = await esbuild.build({
    absWorkingDir: src,
    entryPoints: entries,
    outdir: out,
    outbase: src,
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    sourcemap: "linked",
    target: TARGET,
    chunkNames: "js/chunks/[name]-[hash]",
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
    plugins: [keepTextFilesApart, shareFirstScreenModules(entries, group)],
  });
  await esbuild.build({
    absWorkingDir: src,
    entryPoints: CLASSIC_SCRIPTS.map((f) => `js/${f}`),
    outdir: out,
    outbase: src,
    bundle: false,
    minify: true,
    sourcemap: "linked",
    target: TARGET,
    legalComments: "none",
    logLevel: "warning",
  });
  return result.metafile;
}

// Every module file the first screen needs: app.js and what it imports statically, plus the first screens' files and theirs.
function firstScreenFiles(meta) {
  const outputs = meta.outputs;
  const outRel = (p) => path.relative(out, path.resolve(src, p)).split(path.sep).join("/");
  const byOut = new Map(Object.entries(outputs).map(([p, o]) => [outRel(p), o]));
  const seen = new Set();
  const queue = ["js/app.js", ...FIRST_SCREENS];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !byOut.has(file)) continue;
    seen.add(file);
    for (const imp of byOut.get(file).imports) {
      if (imp.kind === "import-statement" && !imp.external) queue.push(outRel(imp.path));
    }
  }
  return [...seen];
}

function writeServiceWorker(files) {
  const sw = fs.readFileSync(path.join(src, "sw.js"), "utf8");
  const shell = sw.match(/const APP_SHELL = \[([\s\S]*?)\n\];/);
  if (!shell) throw new Error("sw.js: APP_SHELL not found");
  // the non-script entries (start page, stylesheet, icons, map library) stay as they are; the script entries become the built files
  const kept = [...shell[1].matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]).filter((p) => !p.startsWith("/js/"));
  const entries = [...kept, ...files.map((f) => `/${f}`)];
  const next = sw.replace(shell[0], `const APP_SHELL = [\n${entries.map((p) => `  ${JSON.stringify(p)},`).join("\n")}\n];`);
  fs.writeFileSync(path.join(out, "sw.js"), next);
}

const started = Date.now();
const meta = await build();
const scripts = [];
(function walk(dir) {
  for (const name of fs.readdirSync(path.join(out, dir))) {
    const p = dir ? `${dir}/${name}` : name;
    if (fs.statSync(path.join(out, p)).isDirectory()) walk(p);
    else if (p.endsWith(".js")) scripts.push(p);
  }
})("js");
scripts.sort();
writeServiceWorker(scripts);
const modulePreload = firstScreenFiles(meta).map((f) => `/${f}`);
fs.writeFileSync(path.join(out, "build-manifest.json"), `${JSON.stringify({ builtAt: new Date().toISOString(), modulePreload, scripts: scripts.length }, null, 2)}\n`);
console.log(`client build: ${scripts.length} script files, ${modulePreload.length} before the first screen, ${Date.now() - started} ms -> ${path.relative(root, out)}`);
