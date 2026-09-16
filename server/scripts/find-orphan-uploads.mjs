#!/usr/bin/env node
// Reports files under UPLOAD_DIR that no database row references -- the
// only way this happens today is a hard process crash between multer
// finishing its disk write and the route's DB insert committing (every
// normal failure path already unlinks its own upload, see checkins.js,
// products.js, auth.js, delivery.js). Rare, and each crash leaves at most
// one file, so this is a manual/occasional check, not a cron job: deleting
// on a schedule risks removing a file mid-upload if this script's DB scan
// ever raced a real request, so --delete requires an explicit run.
//
// Usage:
//   node scripts/find-orphan-uploads.mjs            # dry run, lists orphans
//   node scripts/find-orphan-uploads.mjs --delete    # also deletes them
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db/pool.js";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const shouldDelete = process.argv.includes("--delete");

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    // .gitkeep (or any dotfile) is repo/ops bookkeeping, not an upload --
    // never a candidate for "orphaned".
    if (entry.isFile() && !entry.name.startsWith(".")) files.push(entry.name);
  }
  return files;
}

async function referencedFilenames() {
  const referenced = new Set();
  const queries = [
    "SELECT avatar_path AS f FROM users WHERE avatar_path IS NOT NULL",
    "SELECT photo_path AS f FROM checkin_photos",
    "SELECT photo_path AS f FROM checkins WHERE photo_path IS NOT NULL",
    "SELECT image_path AS f FROM products WHERE image_path IS NOT NULL",
  ];
  for (const q of queries) {
    const { rows } = await pool.query(q);
    for (const row of rows) referenced.add(row.f);
  }
  return referenced;
}

async function main() {
  const [topLevelFiles, referenced] = await Promise.all([listFiles(uploadDir), referencedFilenames()]);

  const orphans = topLevelFiles.filter((f) => !referenced.has(f));

  // pod_records.signature_path stores just the filename, relative to
  // uploads/signatures/ (see upload.js's signatureUpload) -- scanned
  // separately since it's a different directory from the top-level one.
  const signatureDir = path.join(uploadDir, "signatures");
  let signatureOrphans = [];
  try {
    const signatureFiles = await listFiles(signatureDir);
    const { rows } = await pool.query("SELECT signature_path AS f FROM pod_records");
    const referencedSignatures = new Set(rows.map((r) => r.f));
    signatureOrphans = signatureFiles.filter((f) => !referencedSignatures.has(f));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (!orphans.length && !signatureOrphans.length) {
    console.log("No orphaned upload files found.");
    await pool.end();
    return;
  }

  console.log(`Found ${orphans.length + signatureOrphans.length} orphaned file(s):`);
  for (const f of orphans) console.log(`  ${path.join(uploadDir, f)}`);
  for (const f of signatureOrphans) console.log(`  ${path.join(signatureDir, f)}`);

  if (shouldDelete) {
    for (const f of orphans) await fs.unlink(path.join(uploadDir, f));
    for (const f of signatureOrphans) await fs.unlink(path.join(signatureDir, f));
    console.log("Deleted.");
  } else {
    console.log("Dry run -- re-run with --delete to actually remove these.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
