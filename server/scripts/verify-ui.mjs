import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(scriptDir, "../../client/public");

const files = Object.fromEntries(
  await Promise.all(
    [
      "index.html",
      "manifest.json",
      "css/styles.css",
      "js/app.js",
      "js/util.js",
      "js/views/map.js",
      "sw.js",
    ].map(async (name) => [name, await readFile(path.join(publicDir, name), "utf8")]),
  ),
);

const checks = [
  ["safe-area viewport is enabled", "index.html", /viewport-fit=cover/],
  ["main content can receive routed focus", "index.html", /<main[^>]+tabindex="-1"/],
  ["primary navigation has an accessible name", "index.html", /<nav[^>]+aria-label="Primary navigation"/],
  ["page zoom remains available", "index.html", /<meta name="viewport"(?![^>]*maximum-scale)[^>]*>/],
  ["navigation drawer has modal semantics", "index.html", /<aside[^>]+role="dialog"[^>]+aria-modal="true"/],
  ["landscape is allowed by the PWA", "manifest.json", /"orientation"\s*:\s*"any"/],
  ["application content creates an isolated stacking context", "css/styles.css", /\.app-main\s*\{[^}]*isolation:\s*isolate/s],
  ["navigation stays above map controls", "css/styles.css", /\.nav-bar\s*\{[^}]*z-index:\s*1200/s],
  ["map route keeps navigation opaque", "css/styles.css", /\.map-active\s+\.nav-bar\s*\{/],
  ["compact landscape layout exists", "css/styles.css", /@media\s*\(orientation:\s*landscape\)[^{]*\{/],
  ["reduced-motion preference is respected", "css/styles.css", /@media\s*\(prefers-reduced-motion:\s*reduce\)/],
  ["active navigation exposes aria-current", "js/app.js", /aria-current="page"/],
  ["navigation drawer isolates background content", "js/app.js", /setDrawerBackgroundInert\(true\)/],
  ["navigation drawer restores background content", "js/app.js", /setDrawerBackgroundInert\(false\)/],
  ["dialogs use the shared accessible controller", "js/util.js", /export function activateDialog/],
  ["comboboxes use the shared keyboard controller", "js/util.js", /export function activateCombobox/],
  ["map route enables its protected navigation state", "js/views/map.js", /document\.body\.classList\.add\("map-active"\)/],
  ["map cleanup restores the global navigation state", "js/views/map.js", /document\.body\.classList\.remove\("map-active"\)/],
  ["map filters expose their selected state", "js/views/map.js", /aria-pressed=/],
  ["service worker cache is explicitly versioned", "sw.js", /field-visits-v\d+/],
];

let failures = 0;
for (const [label, file, pattern] of checks) {
  if (pattern.test(files[file])) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label} (${file})`);
  }
}

const forbidden = [
  ["legacy landscape blocker is absent", "index.html", /rotate-overlay|rotate-device/i],
  ["legacy landscape blocker styles are absent", "css/styles.css", /rotate-overlay|rotate-device/i],
];

for (const [label, file, pattern] of forbidden) {
  if (!pattern.test(files[file])) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label} (${file})`);
  }
}

if (failures > 0) {
  console.error(`\nUI verification failed: ${failures} regression${failures === 1 ? "" : "s"}.`);
  process.exitCode = 1;
} else {
  console.log(`\nUI verification passed: ${checks.length + forbidden.length} checks.`);
}
