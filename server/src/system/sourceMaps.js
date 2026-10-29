// Error reports from phones name the real file and line again after the deploy build (docs/architecture-roadmap.md step 10).
//
// The built scripts are minified into a few files (client/dist), so a phone's stack trace says "/js/chunks/chunk-AB12.js:1:48213". The
// build writes a source map next to every file; here a stack line that points into a built file is turned back into the source file,
// line and column ("/js/util.js:120:7") before the report is stored (routes/clientErrors.js), so Settings > System health stays readable.
// Without a build (local runs, tests) nothing is changed.
import fs from "node:fs";
import path from "node:path";
import { CLIENT_DIST_DIR, CLIENT_PUBLIC_DIR } from "../shared/paths.js";
import { useClientBuild } from "./modulePreload.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

// One line of a source map's "mappings": segments of [generated column, source index, source line, source column], the last three
// running totals across the whole map as the format defines.
export function decodeMappings(mappings) {
  const lines = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const line of mappings.split(";")) {
    const segments = [];
    let genCol = 0;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const values = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = B64_VALUE.get(char);
        if (digit === undefined) break;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += values[0] ?? 0;
      if (values.length >= 4) {
        srcIndex += values[1];
        srcLine += values[2];
        srcCol += values[3];
        segments.push([genCol, srcIndex, srcLine, srcCol]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

const maps = new Map(); // built file's map path -> { sources, lines } (or null: no map)
const MAX_MAPS = 40;

function loadMap(mapFile) {
  if (maps.has(mapFile)) return maps.get(mapFile);
  let entry = null;
  try {
    const raw = JSON.parse(fs.readFileSync(mapFile, "utf8"));
    const sources = raw.sources.map((s) => path.relative(CLIENT_PUBLIC_DIR, path.resolve(path.dirname(mapFile), s)).split(path.sep).join("/"));
    entry = { sources, lines: decodeMappings(raw.mappings) };
  } catch {
    entry = null;
  }
  if (maps.size >= MAX_MAPS) maps.delete(maps.keys().next().value);
  maps.set(mapFile, entry);
  return entry;
}

// The source position of a 1-based line / column in a built file ("js/chunks/chunk-AB12.js"), or null.
export function originalPosition(builtRel, line, column, distDir = CLIENT_DIST_DIR) {
  if (builtRel.includes("..")) return null;
  const map = loadMap(path.join(distDir, `${builtRel}.map`));
  const segments = map?.lines[line - 1];
  if (!segments?.length) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid][0] <= column - 1) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const [, src, srcLine, srcCol] = segments[found];
  const file = map.sources[src];
  return file && !file.startsWith("..") ? { file, line: srcLine + 1, column: srcCol + 1 } : null;
}

// "https://host/js/chunks/chunk-AB12.js:1:48213" (or "/js/...") -> "/js/util.js:120:7"; anything else stays as it is.
// Only while the build is what the phones get (the same rule as app.js): an old build left on a computer must not rewrite its reports.
const buildServed = useClientBuild();
export function mapStackText(text, { enabled = buildServed, distDir = CLIENT_DIST_DIR } = {}) {
  if (!enabled || typeof text !== "string" || !text.includes("/js/")) return text;
  return text.replace(/(?:https?:\/\/[^/\s()]+)?\/(js\/[\w./-]+\.js):(\d+):(\d+)/g, (whole, file, line, column) => {
    const pos = originalPosition(file, Number(line), Number(column), distDir);
    return pos ? `/${pos.file}:${pos.line}:${pos.column}` : whole;
  });
}
