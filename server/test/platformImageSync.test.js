import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test"; // pool is lazy; no connection is made here
const { buildManifest, platformImagesUrl } = await import("../src/platformImageSync.js");

test("images URL is derived from the products sync URL", () => {
  assert.equal(
    platformImagesUrl({ PLATFORM_SYNC_URL: "https://x.supabase.co/functions/v1/kad-sync" }),
    "https://x.supabase.co/functions/v1/kad-sync-images"
  );
  assert.equal(platformImagesUrl({ PLATFORM_IMAGES_URL: "https://y/z", PLATFORM_SYNC_URL: "https://x/kad-sync" }), "https://y/z");
  assert.equal(platformImagesUrl({}), null);
});

test("manifest hashes files and skips missing, oversized and unsupported ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimg-"));
  const bytes = Buffer.from("fake-jpeg-bytes");
  fs.writeFileSync(path.join(dir, "a.jpg"), bytes);
  fs.writeFileSync(path.join(dir, "b.gif"), bytes);
  fs.writeFileSync(path.join(dir, "empty.png"), "");
  const rows = [
    { id: 1, path: "a.jpg", kind: "front", is_main: true, sort_order: 0, erp_product_id: "P1" },
    { id: 2, path: "missing.jpg", kind: "other", is_main: false, sort_order: 1, erp_product_id: "P1" },
    { id: 3, path: "b.gif", kind: "other", is_main: false, sort_order: 2, erp_product_id: "P1" },
    { id: 4, path: "empty.png", kind: "other", is_main: false, sort_order: 3, erp_product_id: "P1" },
  ];
  const { images, files } = await buildManifest(rows, dir);
  assert.equal(images.length, 1);
  assert.equal(images[0].sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(images[0].erp_product_id, "P1");
  assert.equal(images[0].is_main, true);
  assert.equal(files.get(1).mime, "image/jpeg");
});
