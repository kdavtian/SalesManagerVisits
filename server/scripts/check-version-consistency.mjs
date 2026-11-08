#!/usr/bin/env node
// npm run check:version - two release checks (see docs/release-process.md#ci-version-consistency-check):
//  1. server/package.json's version has a matching "## [x.y.z]" CHANGELOG.md entry.
//  2. CLAUDE.md hard rule 1: when anything under client/public/ changed against the base (BASE_REF, else origin/main, else main),
//     APP_VERSION (client/public/js/version.js) AND CACHE_VERSION (client/public/sw.js, "field-visits-vNNN") are both greater than
//     the base's. Phones only reinstall the service worker when sw.js changes; a forgotten CACHE_VERSION bump strands users on an
//     old version with "no updates available". A change with nothing under client/public/ (docs, server, CI) needs no bump.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION_FILE = "client/public/js/version.js";
export const SW_FILE = "client/public/sw.js";
export const CLIENT_DIR = "client/public/";

/** "export const APP_VERSION = "1.529.0";" -> [1, 529, 0], or null. */
export function parseAppVersion(src) {
  const m = /APP_VERSION\s*=\s*["'](\d+)\.(\d+)\.(\d+)["']/.exec(src ?? "");
  return m ? m.slice(1).map(Number) : null;
}

/** "const CACHE_VERSION = "field-visits-v545";" -> 545, or null. */
export function parseCacheVersion(src) {
  const m = /const\s+CACHE_VERSION\s*=\s*["']field-visits-v(\d+)["']/.exec(src ?? "");
  return m ? Number(m[1]) : null;
}

/** Semver compare of two [major, minor, patch] arrays: < 0, 0, > 0. */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The bump rule itself, without git or files. Returns a list of error lines (empty = OK).
 * changedFiles: repo-relative paths changed against the base. base*: null when the base has no such file (first commit of it).
 */
export function checkClientBump({ changedFiles, appNow, appBase, cacheNow, cacheBase }) {
  const errors = [];
  if (!appNow) errors.push(`${VERSION_FILE}: APP_VERSION must look like "1.2.3"`);
  if (cacheNow === null || cacheNow === undefined) errors.push(`${SW_FILE}: CACHE_VERSION must look like "field-visits-v123"`);
  if (errors.length) return errors;
  const client = changedFiles.filter((f) => f.startsWith(CLIENT_DIR));
  if (!client.length) return errors;
  const example = client.find((f) => f !== VERSION_FILE && f !== SW_FILE) ?? client[0];
  const what = `client/public changed (${client.length} file${client.length === 1 ? "" : "s"}, e.g. ${example})`;
  if (appBase && compareVersions(appNow, appBase) <= 0) {
    errors.push(`${what} but APP_VERSION is ${appNow.join(".")} (base ${appBase.join(".")}). Bump it in ${VERSION_FILE}.`);
  }
  if (cacheBase !== null && cacheBase !== undefined && cacheNow <= cacheBase) {
    errors.push(
      `${what} but CACHE_VERSION is field-visits-v${cacheNow} (base field-visits-v${cacheBase}). Bump it in ${SW_FILE}, ` +
        `otherwise phones never see the update.`,
    );
  }
  return errors;
}

/** The highest of several [major, minor, patch] (nulls ignored), or null. */
export function highestAppVersion(list) {
  return list.filter(Boolean).sort(compareVersions).at(-1) ?? null;
}

/** The highest of several numbers (null/undefined ignored), or null. */
export function highestNumber(list) {
  const nums = list.filter((n) => typeof n === "number");
  return nums.length ? Math.max(...nums) : null;
}

function checkChangelog(repoRoot) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"));
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const version = pkg.version;
  const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m");
  if (!heading.test(changelog)) {
    return [
      `server/package.json version "${version}" has no "## [${version}]" entry in CHANGELOG.md. ` +
        `Add a CHANGELOG entry for this release before merging (see docs/release-process.md).`,
    ];
  }
  console.log(`OK: CHANGELOG.md has an entry for version ${version}.`);
  return [];
}

function checkBumpAgainstBase(repoRoot) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const appNow = parseAppVersion(readFileSync(path.join(repoRoot, VERSION_FILE), "utf8"));
  const cacheNow = parseCacheVersion(readFileSync(path.join(repoRoot, SW_FILE), "utf8"));

  let base = null;
  let baseName = null;
  for (const candidate of [process.env.BASE_REF, "origin/main", "main"].filter(Boolean)) {
    try {
      base = git("merge-base", "HEAD", candidate);
      baseName = candidate;
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (!base) {
    console.warn("check:version: no base ref found (shallow clone? set BASE_REF) - only the version formats were checked");
    return checkClientBump({ changedFiles: [], appNow, appBase: null, cacheNow, cacheBase: null });
  }

  // Working tree against the base (committed + uncommitted), plus new untracked files: a local run sees the edit before the commit.
  const changedFiles = [
    ...git("diff", "--name-only", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter(Boolean);
  const show = (file) => {
    try {
      return git("show", `${base}:${file}`);
    } catch {
      return null;
    }
  };
  // Compared with the HIGHER of where this branch started and the base branch as it is now: a local run (scripts/local-ci.sh) on a
  // branch started before another PR merged the same new version used to pass (CI itself tests the PR merged into main).
  let tip = null;
  try {
    tip = git("rev-parse", baseName);
  } catch {
    /* no tip: the merge-base alone */
  }
  const showAt = (rev, file) => {
    try {
      return git("show", `${rev}:${file}`);
    } catch {
      return null;
    }
  };
  const errors = checkClientBump({
    changedFiles,
    appNow,
    appBase: highestAppVersion([parseAppVersion(show(VERSION_FILE)), tip && parseAppVersion(showAt(tip, VERSION_FILE))]),
    cacheNow,
    cacheBase: highestNumber([parseCacheVersion(show(SW_FILE)), tip && parseCacheVersion(showAt(tip, SW_FILE))]),
  });
  if (!errors.length) {
    const client = changedFiles.filter((f) => f.startsWith(CLIENT_DIR)).length;
    console.log(
      `OK: version bump vs ${baseName} (${base.slice(0, 8)}): ${client ? `${client} client/public file(s) changed, ` : "no client/public change, "}` +
        `APP_VERSION ${appNow.join(".")}, CACHE_VERSION field-visits-v${cacheNow}.`,
    );
  }
  return errors;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const errors = [...checkChangelog(repoRoot), ...checkBumpAgainstBase(repoRoot)];
  if (errors.length) {
    console.error("check:version FAILED");
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
}
