// Writes the result of matching pricelist-workbook groups to products:
// main front photo (only where the product has none, unless overwrite) and
// the commercial sheet's description / approvals / specifications. Shared by
// the manual import route and the one-time seed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pool } from "./db/pool.js";
import { uploadDirPath } from "./upload.js";
import { parseTechText } from "./pricelistImport.js";

export async function applyMatchedGroups(matches, { overwrite = false, userId = null } = {}) {
  const applied = { photos: 0, commercial: 0 };
  for (const [group, list] of matches) {
    const tech = group.commercial ? (group.techParsed ?? parseTechText(group.tech)) : null;
    for (const p of list) {
      if (group.image && (!p.image_path || overwrite)) {
        const ext = /^(jpe?g|png)$/i.test(group.image.ext) ? group.image.ext.toLowerCase().replace("jpeg", "jpg") : "png";
        const filename = `${crypto.randomUUID()}.${ext}`;
        fs.writeFileSync(path.join(uploadDirPath, filename), group.image.buffer);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows: old } = await client.query("DELETE FROM product_images WHERE product_id = $1 AND is_main RETURNING path", [p.id]);
          await client.query("INSERT INTO product_images (product_id, path, kind, is_main, sort_order, created_by) VALUES ($1, $2, 'front', true, 0, $3)", [p.id, filename, userId]);
          await client.query("UPDATE products SET image_path = (SELECT path FROM product_images WHERE product_id = $1 AND is_main) WHERE id = $1", [p.id]);
          await client.query("COMMIT");
          for (const o of old) fs.unlink(path.join(uploadDirPath, o.path), () => {});
          applied.photos++;
        } catch (err) {
          await client.query("ROLLBACK");
          fs.unlink(path.join(uploadDirPath, filename), () => {});
          throw err;
        } finally {
          client.release();
        }
      }
      if (group.commercial && tech) {
        await pool.query(
          `UPDATE products SET is_commercial = true,
             description = CASE WHEN $2 OR description IS NULL OR description = '' THEN $3 ELSE description END,
             approvals = CASE WHEN $2 OR cardinality(approvals) = 0 THEN $4::text[] ELSE approvals END,
             specs = CASE WHEN $2 OR specs = '[]'::jsonb THEN $5::jsonb ELSE specs END,
             updated_at = now()
           WHERE id = $1`,
          [p.id, overwrite, tech.description, tech.approvals, JSON.stringify(tech.specs)]
        );
        applied.commercial++;
      }
    }
  }
  return applied;
}
