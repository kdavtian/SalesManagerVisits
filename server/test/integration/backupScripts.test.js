// deploy/backup.sh + deploy/backup-restore-test.sh, run for real against a throw-away database of their own (never the
// suite's shared one), a local folder as the uploads and a local folder as the off-server target, with a fake Telegram:
// a good night records a backup_runs row and copies off-server; a failed one alerts Telegram, records the failure and
// leaves no half-written file behind; the restore drill restores the newest backup and checks the key tables.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import pg from "pg";

const REPO = path.resolve(process.cwd(), "..");
const BASE_URL = process.env.DATABASE_URL;
const DB = `fv_backup_script_test_${process.pid}`;
const DB_URL = BASE_URL.replace(/\/[^/?]+(\?.*)?$/, `/${DB}`);
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const hasRclone = has("rclone");

// Production dumps and restores with the Postgres container's own tools, so client and server always match. Here the
// machine's pg_dump may be newer than the server (a CI image ships several): its dump then has settings the server rejects
// (SET transaction_timeout). Use the client of the server's own major version when installed, else skip with the reason.
const serverMajor = Math.floor(Number(spawnSync("psql", [BASE_URL, "-tAc", "SHOW server_version_num"], { encoding: "utf8" }).stdout?.trim()) / 10000);
const matchingBin = `/usr/lib/postgresql/${serverMajor}/bin`;
const PG_PATH = fs.existsSync(path.join(matchingBin, "pg_dump")) ? `${matchingBin}:${process.env.PATH}` : process.env.PATH;
function skipReason() {
  if (!fs.existsSync(path.join(REPO, "deploy/backup.sh"))) return "deploy/ is not part of the app image";
  if (!has("pg_dump") || !has("psql")) return "pg_dump/psql not installed";
  if (!serverMajor) return "cannot read the server version";
  const v = spawnSync("pg_dump", ["--version"], { encoding: "utf8", env: { ...process.env, PATH: PG_PATH } }).stdout ?? "";
  const clientMajor = Number(v.match(/(\d+)\./)?.[1]);
  if (clientMajor !== serverMajor) return `pg_dump ${clientMajor} does not match the Postgres ${serverMajor} server (install postgresql-client-${serverMajor})`;
  return null;
}
const SKIP = skipReason();

let tmp, tgServer, tgMessages, admin;
test.before(async () => {
  if (SKIP) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fv-backup-"));
  for (const d of ["uploads/sig", "remote", "backups"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  fs.writeFileSync(path.join(tmp, "uploads/a.jpg"), "photo");
  fs.writeFileSync(path.join(tmp, "uploads/sig/b.png"), "signature");

  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  await db.query(fs.readFileSync(path.join(REPO, "server/migrations/229_backup_runs.sql"), "utf8"));
  // the restore drill's key tables, with rows
  for (const t of ["users", "customers", "products", "orders", "order_items", "checkins", "payments", "schema_migrations"]) {
    await db.query(`CREATE TABLE ${t} (id serial PRIMARY KEY, note text)`);
    await db.query(`INSERT INTO ${t} (note) SELECT 'row ' || g FROM generate_series(1, 30) g`);
  }
  await db.end();

  tgMessages = [];
  tgServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      tgMessages.push({ method: req.url.split("/").pop(), text: new URLSearchParams(body).get("text") ?? body });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => tgServer.listen(0, "127.0.0.1", r));
});

test.after(async () => {
  if (SKIP) return;
  tgServer?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// async on purpose: a synchronous spawn would block this process, and with it the fake Telegram server the script calls
function run(script, env = {}, args = []) {
  const child = spawn(path.join(REPO, "deploy", script), args, {
    env: {
      PATH: PG_PATH,
      HOME: tmp,
      BACKUP_DB_URL: DB_URL,
      BACKUP_UPLOADS_DIR: path.join(tmp, "uploads"),
      BACKUP_DIR: path.join(tmp, "backups"),
      BACKUP_RCLONE_TARGET: hasRclone ? path.join(tmp, "remote") : "",
      BACKUP_REQUIRE_OFFSITE: hasRclone ? "1" : "0",
      BACKUP_TELEGRAM_COPY: "0",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgServer.address().port}`,
      TELEGRAM_BACKUP_BOT_TOKEN: "test-token",
      TELEGRAM_BACKUP_CHAT_ID: "1",
      ...env,
    },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}
const rows = () => execFileSync("psql", [DB_URL, "-tA", "-c", "SELECT ok || '|' || coalesce(offsite, '') || '|' || coalesce(detail, '') FROM backup_runs ORDER BY id"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

test("backup.sh: a good night writes database + uploads, copies off-server and records it", { skip: SKIP ?? false }, async () => {
  const r = await run("backup.sh");
  assert.equal(r.code, 0, r.out);
  const files = fs.readdirSync(path.join(tmp, "backups"));
  assert.ok(files.some((f) => /^db-.*\.sql\.gz$/.test(f)), files.join());
  assert.ok(files.some((f) => /^uploads-.*\.tar\.gz$/.test(f)), files.join());
  assert.ok(files.includes(".last-good-backup"), "the stamp server-check.sh reads");
  if (hasRclone) {
    const remote = fs.readdirSync(path.join(tmp, "remote/daily"));
    assert.equal(remote.length, 2, remote.join());
  }
  assert.deepEqual(rows(), [`true|${hasRclone ? "spaces" : ""}|`]);
  assert.equal(tgMessages.length, 0, "no message on a clean night");
});

test("backup.sh: a failure alerts Telegram, records the failed step and leaves no half-written backup", { skip: SKIP ?? false }, async () => {
  tgMessages.length = 0;
  const before = fs.readdirSync(path.join(tmp, "backups")).length;
  const r = await run("backup.sh", { BACKUP_UPLOADS_DIR: path.join(tmp, "no-such-folder") });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(tgMessages.length, 1, r.out);
  assert.match(tgMessages[0].text, /BACKUP FAILED .*uploads archive/);
  assert.ok(!tgMessages[0].text.includes("test-token"), "the bot token never appears in a message");
  const files = fs.readdirSync(path.join(tmp, "backups"));
  assert.ok(!files.some((f) => f.endsWith(".partial")), files.join());
  assert.equal(files.filter((f) => f.startsWith("uploads-")).length, 1, "only the good night's archive");
  assert.ok(files.length <= before + 1, "at most the (valid) database dump of this run was added");
  assert.equal(rows().at(-1), "false||uploads archive");

  if (hasRclone) {
    tgMessages.length = 0;
    const off = await run("backup.sh", { BACKUP_RCLONE_TARGET: "no-such-remote:" });
    assert.notEqual(off.code, 0, off.out);
    assert.match(tgMessages[0].text, /off-server copy/);
  }
  tgMessages.length = 0;
  const noOff = await run("backup.sh", { BACKUP_RCLONE_TARGET: "", BACKUP_REQUIRE_OFFSITE: "" });
  assert.notEqual(noOff.code, 0, "no off-server copy at all is a failure by default");
  assert.match(tgMessages[0].text, /no off-server copy/);
});

test("backup.sh: a second run while one is running stops quietly -- no false alarm, no failed row", { skip: SKIP ?? false }, async () => {
  const before = rows().length;
  tgMessages.length = 0;
  const holder = spawn("flock", [path.join(tmp, "backups", ".backup.lock"), "sleep", "5"]);
  await new Promise((r) => setTimeout(r, 300));
  const r = await run("backup.sh");
  holder.kill();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /another backup is already running/);
  assert.equal(tgMessages.length, 0, "no red alert for an overlap");
  assert.equal(rows().length, before, "no failed row");
});

test("backup-restore-test.sh: restores the newest backup into a scratch database and checks the key tables", { skip: SKIP ?? false }, async () => {
  tgMessages.length = 0;
  const r = await run("backup-restore-test.sh");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /customers: live 30, restored 30/);
  assert.match(r.out, /2 files in the photos archive/);
  assert.match(tgMessages.at(-1).text, /restore drill OK/);
  const left = execFileSync("psql", [BASE_URL, "-tA", "-c", "SELECT count(*) FROM pg_database WHERE datname = 'fieldvisits_restore_drill'"], { encoding: "utf8" }).trim();
  assert.equal(left, "0", "the scratch database is dropped afterwards");

  if (hasRclone) assert.equal((await run("backup-restore-test.sh", {}, ["--from-remote"])).code, 0);

  // a cut-off photos archive fails the drill (a backup that only looks good)
  const cut = path.join(tmp, "cut");
  fs.mkdirSync(cut);
  const newestDb = fs.readdirSync(path.join(tmp, "backups")).filter((f) => f.startsWith("db-")).sort().at(-1);
  fs.copyFileSync(path.join(tmp, "backups", newestDb), path.join(cut, newestDb));
  const bigDir = path.join(tmp, "big");
  fs.mkdirSync(bigDir);
  fs.writeFileSync(path.join(bigDir, "photo.jpg"), Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 7919) % 251)));
  execFileSync("tar", ["czf", path.join(tmp, "whole.tar.gz"), "-C", bigDir, "."]);
  const whole = fs.readFileSync(path.join(tmp, "whole.tar.gz"));
  fs.writeFileSync(path.join(cut, "uploads-20991231-000000.tar.gz"), whole.subarray(0, Math.floor(whole.length / 2)));
  tgMessages.length = 0;
  const cutRun = await run("backup-restore-test.sh", { BACKUP_DIR: cut });
  assert.notEqual(cutRun.code, 0, cutRun.out);
  assert.match(tgMessages.at(-1).text, /RESTORE DRILL FAILED .*photos archive/);

  // a broken newest backup is reported, not passed
  const bad = path.join(tmp, "bad");
  fs.mkdirSync(bad);
  execFileSync("sh", ["-c", `echo 'garbage;' | gzip > ${bad}/db-29991231-000000.sql.gz`]);
  tgMessages.length = 0;
  const broken = await run("backup-restore-test.sh", { BACKUP_DIR: bad });
  assert.notEqual(broken.code, 0);
  assert.match(tgMessages.at(-1).text, /RESTORE DRILL FAILED/);
});
