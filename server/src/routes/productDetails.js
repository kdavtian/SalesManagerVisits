// Product detail card (photos, description, approvals, specifications), the
// per-user pricelist PDF, and the pricelist-workbook importer. Mounted on
// /api/products BEFORE productsRouter (whose router-wide manager gate would
// otherwise swallow these); numeric-id guards let anything else fall through.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth, requireProductManager } from "../middleware/auth.js";
import { seesProductCosts, canManageProducts } from "../roles.js";
import { photoUpload, uploadDirPath } from "../upload.js";
import { matchesDeclaredImageType } from "../utils/imageSniff.js";
import { fetchPricedProducts } from "./products.js";
import { buildPricelistPdf, PDF_COLUMN_ORDER, OFFICE_PHONE } from "../pricelistPdf.js";
import { parsePricelistWorkbook, matchGroupsToProducts, parseTechText } from "../pricelistImport.js";

export const productDetailsRouter = Router();
productDetailsRouter.use(requireAuth);

const isId = (v) => /^\d+$/.test(String(v));

function imageUrl(productId, imageId) {
  return `/api/products/${productId}/images/${imageId}`;
}

async function loadImages(productId) {
  const { rows } = await pool.query(
    "SELECT id, kind, is_main, sort_order, created_at FROM product_images WHERE product_id = $1 ORDER BY is_main DESC, sort_order, id",
    [productId]
  );
  return rows.map((r) => ({ ...r, url: imageUrl(productId, r.id) }));
}

async function syncMainImagePath(client, productId) {
  await client.query(
    "UPDATE products SET image_path = (SELECT path FROM product_images WHERE product_id = $1 AND is_main) WHERE id = $1",
    [productId]
  );
}

// ---- read ------------------------------------------------------------------

productDetailsRouter.get("/:id", async (req, res, next) => {
  if (!isId(req.params.id)) return next();
  const [product] = await fetchPricedProducts("WHERE p.id = $1", [Number(req.params.id)], req.user.role);
  if (!product) return res.status(404).json({ error: "Product not found" });
  // Inactive products are only for product managers (same as the catalog list).
  if (!product.active && !canManageProducts(req.user.role)) return res.status(404).json({ error: "Product not found" });
  res.json({ ...product, images: await loadImages(product.id) });
});

productDetailsRouter.get("/:id/images/:imageId", async (req, res, next) => {
  if (!isId(req.params.id) || !isId(req.params.imageId)) return next();
  const { rows } = await pool.query("SELECT path FROM product_images WHERE id = $1 AND product_id = $2", [req.params.imageId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Image not found" });
  res.sendFile(path.join(uploadDirPath, rows[0].path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Image not found" });
  });
});

// ---- photo management (product managers) ---------------------------------

productDetailsRouter.post(
  "/:id/images",
  requireProductManager,
  (req, res, next) => {
    if (!isId(req.params.id)) return next("route");
    photoUpload.single("image")(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "image file is required" });
    const cleanup = () => fs.unlink(path.join(uploadDirPath, req.file.filename), () => {});
    if (!matchesDeclaredImageType(req.file.path, req.file.mimetype)) {
      cleanup();
      return res.status(400).json({ error: "The uploaded file is not a valid image" });
    }
    const productId = Number(req.params.id);
    const { rows: exists } = await pool.query("SELECT id FROM products WHERE id = $1", [productId]);
    if (!exists[0]) {
      cleanup();
      return res.status(404).json({ error: "Product not found" });
    }
    const kind = ["front", "back", "other"].includes(req.body?.kind) ? req.body.kind : "other";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: countRows } = await client.query("SELECT count(*)::int AS n, coalesce(max(sort_order), 0) AS max_order FROM product_images WHERE product_id = $1", [productId]);
      const first = countRows[0].n === 0;
      const { rows } = await client.query(
        `INSERT INTO product_images (product_id, path, kind, is_main, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [productId, req.file.filename, first && kind === "other" ? "front" : kind, first, countRows[0].max_order + 1, req.user.id]
      );
      await syncMainImagePath(client, productId);
      await client.query("COMMIT");
      res.status(201).json({ id: rows[0].id, images: await loadImages(productId) });
    } catch (err) {
      await client.query("ROLLBACK");
      cleanup();
      throw err;
    } finally {
      client.release();
    }
  }
);

productDetailsRouter.patch("/:id/images/:imageId", requireProductManager, async (req, res, next) => {
  if (!isId(req.params.id) || !isId(req.params.imageId)) return next();
  const productId = Number(req.params.id);
  const imageId = Number(req.params.imageId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT id FROM product_images WHERE id = $1 AND product_id = $2 FOR UPDATE", [imageId, productId]);
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Image not found" });
    }
    if (["front", "back", "other"].includes(req.body?.kind)) {
      await client.query("UPDATE product_images SET kind = $1 WHERE id = $2", [req.body.kind, imageId]);
    }
    if (req.body?.is_main === true) {
      await client.query("UPDATE product_images SET is_main = false WHERE product_id = $1 AND id <> $2", [productId, imageId]);
      await client.query("UPDATE product_images SET is_main = true WHERE id = $1", [imageId]);
    }
    await syncMainImagePath(client, productId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json({ images: await loadImages(productId) });
});

productDetailsRouter.delete("/:id/images/:imageId", requireProductManager, async (req, res, next) => {
  if (!isId(req.params.id) || !isId(req.params.imageId)) return next();
  const productId = Number(req.params.id);
  const client = await pool.connect();
  let removedPath = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING path, is_main", [req.params.imageId, productId]);
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Image not found" });
    }
    removedPath = rows[0].path;
    if (rows[0].is_main) {
      // The next photo (front first) becomes the main one.
      await client.query(
        `UPDATE product_images SET is_main = true
         WHERE id = (SELECT id FROM product_images WHERE product_id = $1 ORDER BY (kind = 'front') DESC, sort_order, id LIMIT 1)`,
        [productId]
      );
    }
    await syncMainImagePath(client, productId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (removedPath) fs.unlink(path.join(uploadDirPath, removedPath), () => {});
  res.json({ images: await loadImages(productId) });
});

// ---- pricelist PDF ---------------------------------------------------------

// Management may print gold; nobody gets cost columns in a PDF.
function allowedPdfColumns(role) {
  return seesProductCosts(role) ? PDF_COLUMN_ORDER : PDF_COLUMN_ORDER.filter((c) => c !== "gold");
}

productDetailsRouter.post("/pricelist.pdf", async (req, res) => {
  const body = req.body ?? {};
  const allowed = allowedPdfColumns(req.user.role);
  const columns = (Array.isArray(body.columns) ? body.columns : ["silver", "retail"]).filter((c) => allowed.includes(c));
  if (!columns.length) return res.status(400).json({ error: "Choose at least one price column" });
  const validUntil = /^\d{4}-\d{2}-\d{2}$/.test(String(body.valid_until ?? "")) ? body.valid_until : null;
  if (!validUntil) return res.status(400).json({ error: "valid_until (YYYY-MM-DD) is required" });

  let where = "WHERE p.active";
  const params = [];
  if (Array.isArray(body.brands) && body.brands.length) {
    params.push(body.brands.map(String));
    where += ` AND p.brand = ANY($${params.length})`;
  }
  const products = (await fetchPricedProducts(where, params, req.user.role)).filter((p) =>
    // A product with none of the chosen price tiers set has nothing to print.
    columns.some((c) => (c === "retail" ? p.effective_retail_amd : p[`${c}_price_amd`]))
  );

  const isRep = req.user.role === "sales_manager" || req.user.role === "sales_director";
  const { rows: profileRows } = await pool.query("SELECT email FROM company_profile WHERE id = 1");
  const doc = buildPricelistPdf({
    products,
    columns,
    validUntil,
    includePhotos: body.include_photos !== false,
    includeCommercial: body.include_commercial !== false,
    contact: {
      mode: isRep ? "rep" : "office",
      name: req.user.name,
      phone: req.user.phone || null,
      email: profileRows[0]?.email || req.user.email,
      officePhone: OFFICE_PHONE,
    },
    uploadDir: uploadDirPath,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="kad-pricelist-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ---- import from the pricelist workbook ------------------------------------

const workbookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

productDetailsRouter.post(
  "/import-pricelist",
  requireProductManager,
  (req, res, next) => workbookUpload.single("file")(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next())),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "xlsx file is required" });
    const apply = String(req.body?.apply) === "1";
    const overwrite = String(req.body?.overwrite) === "1";
    let groups;
    try {
      groups = await parsePricelistWorkbook(req.file.buffer);
    } catch {
      return res.status(400).json({ error: "Could not read this file as an .xlsx workbook" });
    }
    const { rows: products } = await pool.query("SELECT id, name, brand, unit, description, is_commercial, image_path FROM products WHERE active");
    const { matches, unmatchedProducts } = matchGroupsToProducts(groups, products);

    const report = {
      groups: groups.length,
      groups_with_photo: groups.filter((g) => g.image).length,
      matched_groups: matches.size,
      unmatched_groups: groups.filter((g) => !matches.has(g)).map((g) => `${g.sheet}: ${g.name}`),
      matched_products: [...matches.values()].reduce((n, list) => n + list.length, 0),
      unmatched_products: unmatchedProducts.length,
      applied: { photos: 0, commercial: 0 },
    };

    if (apply) {
      for (const [group, list] of matches) {
        const tech = group.commercial ? parseTechText(group.tech) : null;
        for (const p of list) {
          if (group.image && (!p.image_path || overwrite)) {
            const ext = /^(jpe?g|png)$/i.test(group.image.ext) ? group.image.ext.toLowerCase().replace("jpeg", "jpg") : "png";
            const filename = `${crypto.randomUUID()}.${ext}`;
            fs.writeFileSync(path.join(uploadDirPath, filename), group.image.buffer);
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const { rows: old } = await client.query("DELETE FROM product_images WHERE product_id = $1 AND is_main RETURNING path", [p.id]);
              await client.query("INSERT INTO product_images (product_id, path, kind, is_main, sort_order, created_by) VALUES ($1, $2, 'front', true, 0, $3)", [p.id, filename, req.user.id]);
              await syncMainImagePath(client, p.id);
              await client.query("COMMIT");
              for (const o of old) fs.unlink(path.join(uploadDirPath, o.path), () => {});
              report.applied.photos++;
            } catch (err) {
              await client.query("ROLLBACK");
              fs.unlink(path.join(uploadDirPath, filename), () => {});
              throw err;
            } finally {
              client.release();
            }
          }
          if (group.commercial) {
            await pool.query(
              `UPDATE products SET is_commercial = true,
                 description = CASE WHEN $2 OR description IS NULL OR description = '' THEN $3 ELSE description END,
                 approvals = CASE WHEN $2 OR cardinality(approvals) = 0 THEN $4::text[] ELSE approvals END,
                 specs = CASE WHEN $2 OR specs = '[]'::jsonb THEN $5::jsonb ELSE specs END,
                 updated_at = now()
               WHERE id = $1`,
              [p.id, overwrite, tech.description, tech.approvals, JSON.stringify(tech.specs)]
            );
            report.applied.commercial++;
          }
        }
      }
    }
    res.json(report);
  }
);

