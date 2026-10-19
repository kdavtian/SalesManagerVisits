// deploy/send-backup-telegram.sh: the weekly backup's second copy goes to the owner's Telegram group. Runs the real script
// against a local fake Telegram API (no network): token/chat lookup from .env, encryption, the "never send readable
// customer data by accident" refusal, the 50 MB limit and the not-configured case.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The backup script runs on the droplet, not in the app image (the Dockerfile copies only server/ and client/): when the full-checks
// step of deploy.sh runs the suite inside the image there is no deploy/ folder, so these tests run in CI and from a full checkout.
const SCRIPT_MISSING = !existsSync(path.join(repo, "deploy/send-backup-telegram.sh")) && "deploy/ is not part of the app image";

function startFakeTelegram(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200 }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

// A throwaway copy of the repo's deploy/ folder with its own .env, so the script's `cd` to its parent finds our files.
function sandbox({ env = "", passphrase = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fv-backup-"));
  mkdirSync(path.join(dir, "deploy"));
  copyFileSync(path.join(repo, "deploy/send-backup-telegram.sh"), path.join(dir, "deploy/send-backup-telegram.sh"));
  chmodSync(path.join(dir, "deploy/send-backup-telegram.sh"), 0o755);
  writeFileSync(path.join(dir, ".env"), env);
  if (passphrase) writeFileSync(path.join(dir, ".backup-passphrase"), passphrase);
  const file = path.join(dir, "db-test.sql.gz");
  writeFileSync(file, "PLAIN-TEXT-MARKER customers and debts\n".repeat(50));
  return { dir, file };
}

// async on purpose: the fake Telegram server lives in THIS process, so a blocking spawnSync would deadlock it
function run(dir, file, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(dir, "deploy/send-backup-telegram.sh"), file], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// the one multipart part named `name`: { text } for fields, { bytes, filename } for the file
function part(request, name) {
  const boundary = "--" + /boundary=(.+)$/.exec(request.headers["content-type"])[1];
  const body = request.body;
  let from = 0;
  for (;;) {
    const start = body.indexOf(boundary, from);
    if (start < 0) return null;
    const headEnd = body.indexOf("\r\n\r\n", start);
    const next = body.indexOf(boundary, headEnd);
    const head = body.slice(start, headEnd).toString("latin1");
    if (head.includes(`name="${name}"`)) {
      const bytes = body.slice(headEnd + 4, next - 2);
      return { bytes, text: bytes.toString("utf8"), filename: /filename="([^"]+)"/.exec(head)?.[1] };
    }
    from = next;
  }
}

test("openssl format: sends the file ENCRYPTED to the configured group, token never printed, and the passphrase decrypts it", { skip: SCRIPT_MISSING }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=123:SECRET-TOKEN\nTELEGRAM_NOTIFY_CHAT_IDS=-1001, -1002\n", passphrase: "correct horse battery staple\n" });
  const result = await run(dir, file, { TELEGRAM_API_BASE: base, BACKUP_ENCRYPT_FORMAT: "openssl" });
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/bot123:SECRET-TOKEN/sendDocument");
  assert.equal(part(requests[0], "chat_id").text, "-1001"); // the FIRST notify chat
  const doc = part(requests[0], "document");
  assert.match(doc.filename, /\.enc$/);
  assert.ok(!doc.bytes.toString("latin1").includes("PLAIN-TEXT-MARKER"), "the upload must not contain readable data");
  assert.ok(!result.stdout.includes("SECRET-TOKEN") && !result.stderr.includes("SECRET-TOKEN"), "the token must never be printed");
  // decrypt exactly like docs/backup-restore.md says
  const encPath = path.join(dir, "uploaded.enc");
  writeFileSync(encPath, doc.bytes);
  const decrypted = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-in", encPath, "-pass", `file:${path.join(dir, ".backup-passphrase")}`]);
  assert.equal(decrypted.status, 0);
  assert.equal(decrypted.stdout.toString(), readFileSync(file, "utf8"));
});

const HAS_7Z = ["7zz", "7z", "7za"].some((c) => spawnSync("bash", ["-c", `command -v ${c}`]).status === 0);

test("default format: a password-protected .7z that 7-Zip opens with the passphrase (names hidden, wrong password refused)", { skip: SCRIPT_MISSING || (!HAS_7Z && "no 7z program installed") }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_BACKUP_CHAT_ID=-5\n", passphrase: "correct horse battery staple\n" });
  const result = await run(dir, file, { TELEGRAM_API_BASE: base });
  server.close();
  assert.equal(result.status, 0, result.stderr);
  const doc = part(requests[0], "document");
  assert.match(doc.filename, /\.7z$/);
  assert.ok(!doc.bytes.toString("latin1").includes("PLAIN-TEXT-MARKER"));
  const archive = path.join(dir, "got.7z");
  writeFileSync(archive, doc.bytes);
  const sevenZ = ["7zz", "7z", "7za"].find((c) => spawnSync("bash", ["-c", `command -v ${c}`]).status === 0);
  const wrong = spawnSync(sevenZ, ["t", "-pwrong", archive]);
  assert.notEqual(wrong.status, 0);
  const right = spawnSync(sevenZ, ["x", "-pcorrect horse battery staple", `-o${dir}/out`, archive]);
  assert.equal(right.status, 0, right.stdout?.toString());
  assert.equal(readFileSync(path.join(dir, "out", "db-test.sql.gz"), "utf8"), readFileSync(file, "utf8"));
  // the file names are inside the encrypted header: listing without the password does not show them
  const listing = spawnSync(sevenZ, ["l", "-p", archive], { input: "\n", encoding: "utf8" });
  assert.ok(!String(listing.stdout).includes("db-test"));
});

test("TELEGRAM_BACKUP_CHAT_ID wins over the notify chats", { skip: SCRIPT_MISSING }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_NOTIFY_CHAT_IDS=-1\nTELEGRAM_BACKUP_CHAT_ID=-777\n", passphrase: "pw\n" });
  const result = await run(dir, file, { TELEGRAM_API_BASE: base });
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(part(requests[0], "chat_id").text, "-777");
});

test("TELEGRAM_BACKUP_BOT_TOKEN (a dedicated backup bot) wins over the app's notification bot token", { skip: SCRIPT_MISSING }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:notification\nTELEGRAM_BACKUP_BOT_TOKEN=2:backup\nTELEGRAM_BACKUP_CHAT_ID=-5\n", passphrase: "pw\n" });
  const result = await run(dir, file, { TELEGRAM_API_BASE: base });
  server.close();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests[0].url, "/bot2:backup/sendDocument");
});

test("without a passphrase nothing is sent (readable customer data) unless the owner opts out explicitly", { skip: SCRIPT_MISSING }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_NOTIFY_CHAT_IDS=-1\n" });
  const refused = await run(dir, file, { TELEGRAM_API_BASE: base });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /NOT sent: no encryption passphrase/);
  assert.equal(requests.length, 0);
  const optOut = await run(dir, file, { TELEGRAM_API_BASE: base, BACKUP_TELEGRAM_UNENCRYPTED: "1" });
  server.close();
  assert.equal(optOut.status, 0, optOut.stderr);
  assert.equal(requests.length, 1);
  assert.ok(part(requests[0], "document").bytes.toString("latin1").includes("PLAIN-TEXT-MARKER"));
});

test("a Telegram error is a loud failure, not a silent success", { skip: SCRIPT_MISSING }, async () => {
  const { server, base } = await startFakeTelegram(400);
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_NOTIFY_CHAT_IDS=-1\n", passphrase: "pw\n" });
  const result = await run(dir, file, { TELEGRAM_API_BASE: base });
  server.close();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED \(HTTP 400\)/);
});

test("not configured: skipped with an explanation and no error (the backup itself still works)", { skip: SCRIPT_MISSING }, async () => {
  const { dir, file } = sandbox({ env: "" });
  const result = await run(dir, file);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /skipped/);
});

test("a file over Telegram's 50 MB bot limit is refused loudly", { skip: SCRIPT_MISSING }, async () => {
  const { server, requests, base } = await startFakeTelegram();
  const { dir, file } = sandbox({ env: "TELEGRAM_BOT_TOKEN=1:x\nTELEGRAM_NOTIFY_CHAT_IDS=-1\n", passphrase: "pw\n" });
  spawnSync("bash", ["-c", `head -c 52000000 /dev/zero > "${file}"`]);
  const result = await run(dir, file, { TELEGRAM_API_BASE: base });
  server.close();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most 50 MB/);
  assert.equal(requests.length, 0);
});
