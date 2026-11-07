// npm run shots:main [-- <git ref, default origin/main>]  -  "does any screen change by accident?" (owner, 2026-11-07: "You judge by
// what you see, so make the tests judge that way too").
// Takes the pictures of every key screen (test/e2e/shots.visual.mjs) on the code of <ref> (a temporary git worktree), then compares THIS
// code with them; any changed pixel fails. A change that is meant (a new look, a new feature) is not an accident: label the pull request
// "ui-change" and CI skips this check. Both sides run the deploy build (CLIENT_BUILD=1), each on a fresh database of its own with the same
// fixed data (shots-seed.mjs) and the same clock (SHOTS_NOW), with this code's camera (the harness files are copied into the old copy).
// The pictures and the temporary copy are deleted at the end; nothing is committed, so there are no stored baselines to drift with fonts.
// Env: DATABASE_URL (any database on the server; the check uses <its name>_shots next to it), JWT_SECRET, SHOTS_ROLES, SHOTS_MODES,
// SHOTS_PORT (default 3401), SHOTS_BUILT=1 (skip building this code's client/dist).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(server);
const ref = process.argv[2] || "origin/main";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fv-shots-main-"));
const copy = path.join(tmp, "code");
const pictures = path.join(tmp, "pictures");
const HARNESS = ["test/e2e/shots.visual.mjs", "test/e2e/shots.config.mjs", "test/e2e/shots-seed.mjs", "playwright.config.mjs"];

if (!process.env.DATABASE_URL) {
  console.error("shots:main needs DATABASE_URL (a Postgres database; the check makes its own <name>_shots database next to it)");
  process.exit(2);
}
const dbUrl = new URL(process.env.DATABASE_URL);
const shotsDb = `${dbUrl.pathname.slice(1) || "fieldvisits"}_shots`.replace(/[^a-z0-9_]/gi, "_");
const shotsUrl = Object.assign(new URL(dbUrl), { pathname: `/${shotsDb}` }).toString();
// "today 11:00 in Yerevan", chosen once so both sides see the same day and time
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yerevan" }).format(new Date());
const SHOTS_NOW = process.env.SHOTS_NOW || `${ymd}T07:00:00.000Z`;
const env = {
  ...process.env,
  DATABASE_URL: shotsUrl,
  SHOTS_DIR: pictures,
  SHOTS_NOW,
  CLIENT_BUILD: "1",
  NODE_ENV: "test",
  E2E_PORT: process.env.SHOTS_PORT || "3401",
  JWT_SECRET: process.env.JWT_SECRET || "shots-secret-not-used-anywhere-real",
};

async function freshDatabase() {
  const admin = new pg.Client({ connectionString: Object.assign(new URL(dbUrl), { pathname: "/postgres" }).toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${shotsDb} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${shotsDb}`);
  } finally {
    await admin.end();
  }
}

// one side: its own build, a fresh database with its own migrations, the fixed data, then the pictures
async function side(serverDir, update) {
  const t0 = Date.now();
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: serverDir, stdio: "inherit", env });
  // SHOTS_BUILT=1: this code's client/dist is already built (scripts/local-ci.sh builds it once for every browser job running beside this)
  if (!(serverDir === server && process.env.SHOTS_BUILT === "1")) sh("node", ["scripts/build-client.mjs"]);
  await freshDatabase();
  sh("node", ["src/db/migrate.js"]);
  sh("node", ["-e", `import("./test/e2e/shots-seed.mjs").then((m) => m.seedShots(process.env.DATABASE_URL, process.env.SHOTS_NOW))`]);
  sh("npx", ["playwright", "test", "-c", "test/e2e/shots.config.mjs", `--update-snapshots=${update}`]);
  console.log(`   (${Math.round((Date.now() - t0) / 1000)} s)`);
}

let status = 0;
try {
  execFileSync("git", ["worktree", "add", "--detach", copy, ref], { cwd: repo, stdio: "inherit" });
  fs.symlinkSync(path.join(server, "node_modules"), path.join(copy, "server", "node_modules"));
  // the same camera for both: the harness of this code takes the pictures of the old code too
  for (const f of HARNESS) fs.copyFileSync(path.join(server, f), path.join(copy, "server", f));
  console.log(`\n== pictures of ${ref} (today = ${SHOTS_NOW})`);
  await side(path.join(copy, "server"), "all");
  console.log(`\n== this code against them (${fs.readdirSync(pictures).length} pictures)`);
  await side(server, "none");
  console.log("\nshots:main OK - no screen changed");
} catch {
  status = 1;
  console.error(`\nshots:main FAILED - a screen differs from ${ref} (the diff pictures are in server/test-results-shots). A meant change: label the pull request "ui-change".`);
} finally {
  try { execFileSync("git", ["worktree", "remove", "--force", copy], { cwd: repo, stdio: "ignore" }); } catch { /* already gone */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(status);
