#!/usr/bin/env node
// Fails CI if server/package.json's version has no matching CHANGELOG.md
// entry. See docs/release-process.md#ci-version-consistency-check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..");

const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"),
);
const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

const version = pkg.version;
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m");

if (!heading.test(changelog)) {
  console.error(
    `server/package.json version "${version}" has no "## [${version}]" entry in CHANGELOG.md.\n` +
      `Add a CHANGELOG entry for this release before merging (see docs/release-process.md).`,
  );
  process.exit(1);
}

console.log(`OK: CHANGELOG.md has an entry for version ${version}.`);
