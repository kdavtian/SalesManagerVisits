#!/usr/bin/env node
// Copies every visit photo and delivery signature into one folder PER CUSTOMER, with readable file names, so the owner can
// browse / archive them on a computer (the files in uploads/ have random names; only the database knows who they belong to).
// Read-only for the app: it copies, never moves or deletes anything, and writes only into the output folder.
//
// Usage (on the droplet, from /opt/field-visits):
//   docker compose exec -T app node scripts/export-photos-by-customer.mjs /tmp/photos-by-customer
//   docker compose cp app:/tmp/photos-by-customer ./photos-by-customer
//
// Result:
//   <out>/<Customer name> [ERP id]/2026-10-17 14.45 visit - <rep> - 1.jpg
//   <out>/<Customer name> [ERP id]/2026-10-17 delivery signature - order <code>.png
//   <out>/_report.txt   (counts, and files the database mentions that are missing on disk)
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/db/pool.js";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const outDir = path.resolve(process.argv[2] || "./photos-by-customer");

// A name safe on macOS/Windows/Linux file systems; Armenian letters are fine, path separators and control characters are not.
const safe = (text) =>
  String(text ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "unnamed";

const stamp = (date, withTime = true) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}${withTime ? ` ${parts.hour}.${parts.minute}` : ""}`;
};

const folderOf = (row) => `${safe(row.customer_name)} [${safe(row.erp_customer_id || `#${row.customer_id}`)}]`;

const counts = { visitPhotos: 0, signatures: 0, missing: [] };
const used = new Set();

async function copyInto(row, sourcePath, baseName, when) {
  const ext = path.extname(sourcePath) || ".jpg";
  const dir = path.join(outDir, folderOf(row));
  let target = path.join(dir, `${baseName}${ext}`);
  for (let n = 2; used.has(target); n++) target = path.join(dir, `${baseName} (${n})${ext}`);
  used.add(target);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(sourcePath, target);
    // keep the capture time on the copy, so a file manager can sort it by when it was taken
    if (when) await fs.utimes(target, new Date(when), new Date(when));
    return { ok: true, target };
  } catch (err) {
    if (err.code === "ENOENT") {
      counts.missing.push(path.relative(uploadDir, sourcePath));
      return { ok: false };
    }
    throw err;
  }
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  // Visit photos: the new table plus the old single photo on the check-in itself (the migration copied those, the Set de-duplicates).
  const { rows: visitRows } = await pool.query(`
    SELECT p.photo_path, c.id AS checkin_id, c."timestamp", u.name AS rep_name, cu.id AS customer_id, cu.name AS customer_name, cu.erp_customer_id
    FROM (
      SELECT checkin_id, photo_path FROM checkin_photos
      UNION
      SELECT id AS checkin_id, photo_path FROM checkins WHERE photo_path IS NOT NULL
    ) p
    JOIN checkins c ON c.id = p.checkin_id
    JOIN users u ON u.id = c.user_id
    JOIN customers cu ON cu.id = c.customer_id
    ORDER BY cu.name, c."timestamp", p.photo_path`);
  const perVisit = new Map();
  for (const row of visitRows) {
    const n = (perVisit.get(row.checkin_id) ?? 0) + 1;
    perVisit.set(row.checkin_id, n);
    const result = await copyInto(row, path.join(uploadDir, row.photo_path), `${stamp(row.timestamp)} visit - ${safe(row.rep_name)} - ${n}`, row.timestamp);
    if (result.ok) counts.visitPhotos += 1;
  }

  // Delivery signatures: signature_path already starts with "signatures/" (relative to the uploads folder).
  const { rows: signatureRows } = await pool.query(`
    SELECT s.signature_path, s.delivered_at, o.order_code, cu.id AS customer_id, cu.name AS customer_name, cu.erp_customer_id
    FROM pod_records s
    JOIN orders o ON o.id = s.order_id
    JOIN customers cu ON cu.id = o.customer_id
    ORDER BY cu.name, s.delivered_at`);
  for (const row of signatureRows) {
    const result = await copyInto(row, path.join(uploadDir, row.signature_path), `${stamp(row.delivered_at, false)} delivery signature - order ${safe(row.order_code || "")}`, row.delivered_at);
    if (result.ok) counts.signatures += 1;
  }

  const customers = new Set(used.size ? [...used].map((t) => path.basename(path.dirname(t))) : []);
  const report = [
    `Visit photos copied: ${counts.visitPhotos}`,
    `Delivery signatures copied: ${counts.signatures}`,
    `Customer folders: ${customers.size}`,
    `Files the database lists but that are missing on disk: ${counts.missing.length}`,
    ...counts.missing.map((f) => `  - ${f}`),
  ].join("\n");
  await fs.writeFile(path.join(outDir, "_report.txt"), report + "\n");
  console.log(report);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
