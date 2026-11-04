// Checks that the shared KAD kit (client/public/js/kit/) is exactly what kit.lock.json records (kit/README.md). The kit is identical in
// Field Visits and KAD OS: a kit file that changed without the lock means someone edited it here only. After a deliberate change (copied to
// the other repo too, KIT_VERSION bumped): `node scripts/check-kit.mjs --write`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kitDir = join(root, "client", "public", "js", "kit");
const lockPath = join(kitDir, "kit.lock.json");
const files = readdirSync(kitDir).filter((f) => f !== "kit.lock.json").sort();
const hashes = Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(join(kitDir, f))).digest("hex")]));
const version = (readFileSync(join(kitDir, "version.js"), "utf8").match(/KIT_VERSION = "([^"]+)"/) || [])[1];

if (process.argv.includes("--write")) {
  writeFileSync(lockPath, `${JSON.stringify({ version, files: hashes }, null, 2)}\n`);
  console.log(`kit.lock.json written (kit ${version}, ${files.length} files)`);
  process.exit(0);
}
let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch {
  console.error("kit.lock.json missing: run node scripts/check-kit.mjs --write");
  process.exit(1);
}
const problems = [];
if (lock.version !== version) problems.push(`KIT_VERSION ${version} but the lock says ${lock.version}`);
for (const f of new Set([...Object.keys(lock.files), ...files])) {
  if (!hashes[f]) problems.push(`${f}: in the lock, missing in kit/`);
  else if (!lock.files[f]) problems.push(`${f}: new kit file, not in the lock`);
  else if (lock.files[f] !== hashes[f]) problems.push(`${f}: changed without updating the lock (copy it to the other KAD app, bump KIT_VERSION, --write)`);
}
if (problems.length) {
  console.error(`KAD kit check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`KAD kit ${version}: ${files.length} files match the lock`);
