import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const routeDistributionRouter = Router();

routeDistributionRouter.use(requireAuth);

// Admin-only management list, newest first.
routeDistributionRouter.get("/", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rd.*, u.name AS assigned_manager_name
       FROM route_distribution rd
       LEFT JOIN users u ON u.id = rd.assigned_manager_id
      ORDER BY rd.region, rd.subregion NULLS FIRST`
  );
  res.json(rows);
});

// Any authed user (the new-customer form calls this to suggest a channel and
// manager for a detected region/subregion) -- read-only lookup, no admin
// gate needed since it exposes only the resolved mapping, not the full list.
routeDistributionRouter.get("/lookup", async (req, res) => {
  const { region, subregion } = req.query;
  if (!region) return res.json(null);

  // Exact region+subregion match wins; a region-only row (subregion NULL)
  // is the fallback default for the rest of that region. The priority
  // column plus ORDER BY (rather than relying on UNION ALL row order,
  // which Postgres does not guarantee) makes sure the exact match is
  // picked first when both exist.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT rd.*, u.name AS assigned_manager_name, 0 AS priority
         FROM route_distribution rd
         LEFT JOIN users u ON u.id = rd.assigned_manager_id
        WHERE rd.region = $1 AND rd.subregion = $2
        UNION ALL
       SELECT rd.*, u.name AS assigned_manager_name, 1 AS priority
         FROM route_distribution rd
         LEFT JOIN users u ON u.id = rd.assigned_manager_id
        WHERE rd.region = $1 AND rd.subregion IS NULL
     ) matches
     ORDER BY priority
     LIMIT 1`,
    [region, subregion || null]
  );
  res.json(rows[0] || null);
});

routeDistributionRouter.post("/", requireAdmin, async (req, res) => {
  const { region, subregion, sales_channel, assigned_manager_id } = req.body ?? {};
  if (!region || !sales_channel) {
    return res.status(400).json({ error: "region and sales_channel are required" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO route_distribution (region, subregion, sales_channel, assigned_manager_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [region, subregion || null, sales_channel, assigned_manager_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A mapping for this region/subregion already exists" });
    }
    throw err;
  }
});

routeDistributionRouter.patch("/:id", requireAdmin, async (req, res) => {
  const fields = ["region", "subregion", "sales_channel", "assigned_manager_id"];
  const updates = Object.entries(req.body ?? {}).filter(([key]) => fields.includes(key));
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([, value]) => value);

  try {
    const { rows } = await pool.query(
      `UPDATE route_distribution SET ${setClauses.join(", ")}, updated_at = now()
       WHERE id = $${values.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A mapping for this region/subregion already exists" });
    }
    throw err;
  }
});

routeDistributionRouter.delete("/:id", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM route_distribution WHERE id = $1", [req.params.id]);
  res.status(204).end();
});
