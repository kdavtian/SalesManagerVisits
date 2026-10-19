// Copies product photos managed in KAD (product_images) to Platform (the public
// website), so photos are uploaded once, here. Two calls to Platform's
// kad-sync-images function: a manifest (which photos exist) answered with the
// ones Platform still needs, then one upload per missing photo. Best-effort:
// never throws into a caller's request, never blocks the ERP sync.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pool } from "./db/pool.js";
import { uploadDirPath } from "./upload.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

// Full URL of Platform's kad-sync-images function; defaults to a sibling of PLATFORM_SYNC_URL.
export function platformImagesUrl(env = process.env) {
  if (env.PLATFORM_IMAGES_URL) return env.PLATFORM_IMAGES_URL;
  const base = env.PLATFORM_SYNC_URL;
  if (!base) return null;
  return base.replace(/kad-sync\/?$/, "kad-sync-images");
}

const shaCache = new Map(); // file -> { mtimeMs, size, sha }

async function fileSha256(file, stat) {
  const cached = shaCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha;
  const sha = crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex");
  shaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, sha });
  return sha;
}

// rows: product_images joined with products.erp_product_id. Returns the manifest
// entries plus a lookup of local files for the uploads.
export async function buildManifest(rows, dir = uploadDirPath) {
  const images = [];
  const files = new Map();
  for (const r of rows) {
    const ext = path.extname(r.path || "").toLowerCase();
    if (!MIME_BY_EXT[ext]) continue;
    const file = path.join(dir, r.path);
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      continue; // file missing on disk
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) continue;
    const sha256 = await fileSha256(file, stat);
    images.push({
      kad_image_id: r.id,
      erp_product_id: r.erp_product_id,
      sha256,
      is_main: !!r.is_main,
      sort_order: r.sort_order ?? 0,
      kind: r.kind,
    });
    files.set(r.id, { file, mime: MIME_BY_EXT[ext], sha256, entry: images[images.length - 1] });
  }
  return { images, files };
}

export async function syncProductImagesToPlatform(fetchImpl = fetch) {
  const key = process.env.PLATFORM_SYNC_KEY;
  const url = platformImagesUrl();
  if (!url || !key) return { skipped: true };

  const { rows } = await pool.query(
    `SELECT pi.id, pi.path, pi.kind, pi.is_main, pi.sort_order, p.erp_product_id
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id
     WHERE p.erp_product_id IS NOT NULL AND p.erp_product_id <> ''
     ORDER BY pi.product_id, pi.is_main DESC, pi.sort_order, pi.id`
  );
  const { images, files } = await buildManifest(rows);

  const manifestRes = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Key": key, "X-Action": "manifest" },
    body: JSON.stringify({ images }),
  });
  if (!manifestRes.ok) throw new Error(`Platform image manifest failed: ${manifestRes.status} ${await manifestRes.text()}`);
  const { need = [], removed = 0 } = await manifestRes.json();

  let uploaded = 0;
  for (const id of need) {
    const item = files.get(id);
    if (!item) continue;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": item.mime,
        "X-Sync-Key": key,
        "X-Action": "upload",
        "X-Erp-Product-Id": item.entry.erp_product_id,
        "X-Sha256": item.sha256,
        "X-Kad-Image-Id": String(id),
        "X-Is-Main": String(item.entry.is_main),
        "X-Sort-Order": String(item.entry.sort_order),
        "X-Kind": item.entry.kind || "other",
      },
      body: await fs.promises.readFile(item.file),
    });
    if (!res.ok) throw new Error(`Platform image upload failed (image ${id}): ${res.status} ${await res.text()}`);
    uploaded += 1;
  }
  return { manifest: images.length, uploaded, removed };
}

// Fire-and-forget with coalescing: calls made while a sync runs trigger exactly one more run.
let running = false;
let again = false;
export function queueProductImageSync() {
  if (process.env.NODE_ENV === "test") return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  syncProductImagesToPlatform()
    .catch((err) => console.error("Platform image sync failed:", err.message))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        queueProductImageSync();
      }
    });
}
