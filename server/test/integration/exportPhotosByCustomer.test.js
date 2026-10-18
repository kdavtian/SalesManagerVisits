// server/scripts/export-photos-by-customer.mjs: copies visit photos + delivery signatures into one folder per customer
// with readable names (the files in uploads/ have random names). Runs the real script against the test database.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupAll, createUser, createCustomer, trackOrder, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runScript(uploads, out) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/export-photos-by-customer.mjs", out], {
      cwd: serverDir,
      env: { ...process.env, UPLOAD_DIR: uploads },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const podOrderIds = [];

test.after(async () => {
  await pool.query("DELETE FROM pod_records WHERE order_id = ANY($1)", [podOrderIds]);
  await cleanupAll();
  await pool.end();
});

test("photos and signatures end up in one folder per customer with readable names; missing files are reported", async () => {
  const uploads = mkdtempSync(path.join(tmpdir(), "fv-uploads-"));
  const out = path.join(mkdtempSync(path.join(tmpdir(), "fv-export-")), "result");
  mkdirSync(path.join(uploads, "signatures"));
  writeFileSync(path.join(uploads, "aaa.jpg"), "photo-one");
  writeFileSync(path.join(uploads, "bbb.jpg"), "photo-two");
  writeFileSync(path.join(uploads, "signatures", "sig.png"), "signature");

  const admin = await createUser("admin");
  const rep = await createUser("sales_manager", { name: "Photo Rep" });
  const customer = await createCustomer({ created_by: admin.id, name: 'Exp/ort: "Garage"', erp_customer_id: "10777" });

  const { rows: visit } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp, photo_path)
     VALUES ($1, $2, 40.18, 44.51, 5, true, '2026-10-17 10:45:00+00', 'aaa.jpg') RETURNING id`,
    [customer.id, rep.id]
  );
  trackCheckin(visit[0].id);
  // aaa.jpg is listed twice (old single-photo column + the photos table): it must be copied once.
  await pool.query("INSERT INTO checkin_photos (checkin_id, photo_path) VALUES ($1, 'aaa.jpg'), ($1, 'bbb.jpg'), ($1, 'gone.jpg')", [visit[0].id]);

  const { rows: order } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, order_code, payment_method)
     VALUES ($1, $2, 'delivered', 1000, $3, 'cash') RETURNING id`,
    [customer.id, rep.id, `EXP-${Date.now()}`]
  );
  trackOrder(order[0].id);
  podOrderIds.push(order[0].id);
  await pool.query(
    `INSERT INTO pod_records (order_id, driver_id, driver_name_snapshot, signature_path, order_amount_amd, delivered_at)
     VALUES ($1, $2, 'Photo Rep', 'signatures/sig.png', 1000, '2026-10-17 12:00:00+00')`,
    [order[0].id, rep.id]
  );

  const result = await runScript(uploads, out);
  assert.equal(result.code, 0, result.stderr);

  const folder = path.join(out, "Exp ort Garage [10777]");
  assert.ok(existsSync(folder), `customer folder missing; got ${readdirSync(out)}`);
  const names = readdirSync(folder).sort();
  assert.equal(names.length, 3, names.join(" | "));
  assert.ok(names.some((n) => n.startsWith("2026-10-17 14.45 visit - Photo Rep - ") && n.endsWith(".jpg")), names.join(" | "));
  assert.ok(names.some((n) => n.startsWith("2026-10-17 delivery signature - order EXP-") && n.endsWith(".png")), names.join(" | "));
  const contents = names.map((n) => readFileSync(path.join(folder, n), "utf8")).sort();
  assert.deepEqual(contents, ["photo-one", "photo-two", "signature"]);

  const report = readFileSync(path.join(out, "_report.txt"), "utf8");
  assert.match(report, /Visit photos copied: 2/);
  assert.match(report, /Delivery signatures copied: 1/);
  assert.match(report, /missing on disk: 1/);
  assert.match(report, /gone\.jpg/);
});
