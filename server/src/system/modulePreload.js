// <link rel="modulepreload"> tags for the app's boot module graph.
//
// Cold first launch (nothing cached yet) used to walk that graph one level
// at a time: bootGate.js imports the first enhancer, whose imports are only
// discovered once it has arrived and been parsed, then the next one... each
// step a full network round trip, so on a slow phone link the login screen
// came up 4-5 s after the HTML. Telling the browser about the whole graph up
// front in index.html lets it fetch every module in parallel from the first
// byte; nothing is evaluated earlier, so module order is unchanged.
//
// The list is derived from the files themselves (the module bootGate.js
// awaits, app.js, plus the static imports under it), once at start-up, so a
// new module imported by a boot module is picked up without editing a list.
import fs from "node:fs";
import path from "node:path";
import { CLIENT_DIST_DIR } from "../shared/paths.js";

// Screens opened straight after boot: the login form or the Home screen.
const FIRST_SCREENS = ["js/views/login.js", "js/views/dashboard.js"];
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;

export function bootModuleHrefs(clientDir) {
  try {
    const gate = fs.readFileSync(path.join(clientDir, "js", "bootGate.js"), "utf8");
    const entries = [...gate.matchAll(/await import\("\.\/([^"]+)"\)/g)].map((m) => `js/${m[1]}`);
    const seen = new Set();
    const queue = [...entries, ...FIRST_SCREENS];
    while (queue.length) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      let source;
      try {
        source = fs.readFileSync(path.join(clientDir, file), "utf8");
      } catch {
        continue;
      }
      seen.add(file);
      for (const m of source.matchAll(IMPORT_RE)) {
        if (m[1].startsWith(".")) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
      }
    }
    return [...seen].map((f) => `/${f}`);
  } catch {
    return [];
  }
}

// Whether the deploy build (client/dist, see app.js) is served: it exists, and this is the real server or a test run that asks for it.
export function useClientBuild(env = process.env) {
  if (!fs.existsSync(path.join(CLIENT_DIST_DIR, "build-manifest.json"))) return false;
  return env.NODE_ENV === "production" || env.CLIENT_BUILD === "1";
}

// In the build the boot graph is a handful of bundled files the build script listed (the source files' imports are gone from them).
function builtModuleHrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLIENT_DIST_DIR, "build-manifest.json"), "utf8")).modulePreload ?? [];
  } catch {
    return [];
  }
}

export function modulePreloadTags(clientDir, built = false) {
  return (built ? builtModuleHrefs() : bootModuleHrefs(clientDir))
    .map((href) => `<link rel="modulepreload" href="${href}" />`)
    .join("\n    ");
}
