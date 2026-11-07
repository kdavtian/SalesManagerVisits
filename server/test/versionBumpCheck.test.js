// CLAUDE.md hard rule 1 as a CI check: server/scripts/check-version-consistency.mjs (npm run check:version).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkClientBump,
  compareVersions,
  parseAppVersion,
  parseCacheVersion,
  SW_FILE,
  VERSION_FILE,
} from "../scripts/check-version-consistency.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = { appBase: [1, 529, 0], cacheBase: 545 };
const bumped = { appNow: [1, 530, 0], cacheNow: 546 };

test("parses the real version.js and sw.js of this repo", () => {
  assert.ok(parseAppVersion(readFileSync(path.join(repoRoot, VERSION_FILE), "utf8")));
  assert.equal(typeof parseCacheVersion(readFileSync(path.join(repoRoot, SW_FILE), "utf8")), "number");
});

test("parses APP_VERSION and the number inside CACHE_VERSION", () => {
  assert.deepEqual(parseAppVersion('export const APP_VERSION = "1.529.0";'), [1, 529, 0]);
  assert.deepEqual(parseAppVersion("export const APP_VERSION = '2.0.13';"), [2, 0, 13]);
  assert.equal(parseAppVersion("export const APP_VERSION = 'v1';"), null);
  assert.equal(parseAppVersion(null), null);
  assert.equal(parseCacheVersion('const CACHE_VERSION = "field-visits-v545";'), 545);
  assert.equal(parseCacheVersion('const CACHE_VERSION = "field-visits-v1000";'), 1000);
  assert.equal(parseCacheVersion("const CACHE_VERSION = 545;"), null);
});

test("compares versions numerically, not as text", () => {
  assert.ok(compareVersions([1, 530, 0], [1, 529, 9]) > 0);
  assert.ok(compareVersions([1, 99, 0], [1, 100, 0]) < 0);
  assert.ok(compareVersions([2, 0, 0], [1, 999, 999]) > 0);
  assert.equal(compareVersions([1, 529, 0], [1, 529, 0]), 0);
  assert.ok(compareVersions([1, 529, 1], [1, 529, 0]) > 0);
});

test("a change with nothing under client/public needs no bump", () => {
  const changedFiles = ["docs/release-process.md", "server/src/orders/orderStock.js", ".github/workflows/ci.yml"];
  assert.deepEqual(checkClientBump({ changedFiles, appNow: [1, 529, 0], cacheNow: 545, ...base }), []);
  assert.deepEqual(checkClientBump({ changedFiles: [], appNow: [1, 529, 0], cacheNow: 545, ...base }), []);
});

test("a client change with both versions bumped passes", () => {
  const changedFiles = ["client/public/js/views/map.js", VERSION_FILE, SW_FILE];
  assert.deepEqual(checkClientBump({ changedFiles, ...bumped, ...base }), []);
});

test("a client change without any bump fails on both versions", () => {
  const errors = checkClientBump({ changedFiles: ["client/public/css/app.css"], appNow: [1, 529, 0], cacheNow: 545, ...base });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /APP_VERSION is 1\.529\.0 \(base 1\.529\.0\)/);
  assert.match(errors[1], /CACHE_VERSION is field-visits-v545 \(base field-visits-v545\)/);
});

test("bumping only APP_VERSION (the old mistake) fails on CACHE_VERSION", () => {
  const errors = checkClientBump({ changedFiles: ["client/public/js/app.js", VERSION_FILE], appNow: [1, 530, 0], cacheNow: 545, ...base });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CACHE_VERSION/);
});

test("bumping only CACHE_VERSION fails on APP_VERSION; a lower version is not a bump", () => {
  const onlyCache = checkClientBump({ changedFiles: ["client/public/js/app.js", SW_FILE], appNow: [1, 529, 0], cacheNow: 546, ...base });
  assert.equal(onlyCache.length, 1);
  assert.match(onlyCache[0], /APP_VERSION/);
  const lower = checkClientBump({ changedFiles: ["client/public/index.html"], appNow: [1, 528, 9], cacheNow: 544, ...base });
  assert.equal(lower.length, 2);
});

test("editing sw.js alone (e.g. APP_SHELL) still needs both bumps", () => {
  assert.equal(checkClientBump({ changedFiles: [SW_FILE], appNow: [1, 529, 0], cacheNow: 545, ...base }).length, 2);
});

test("an unreadable version format fails even without a client change", () => {
  assert.equal(checkClientBump({ changedFiles: [], appNow: null, cacheNow: 545, ...base }).length, 1);
  assert.equal(checkClientBump({ changedFiles: [], appNow: [1, 0, 0], cacheNow: null, ...base }).length, 1);
});
