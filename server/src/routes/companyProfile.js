import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireProductManager } from "../middleware/auth.js";

export const companyProfileRouter = Router();

companyProfileRouter.use(requireAuth);

// Everyone (any logged-in role) can read it -- it's what populates the
// pricelist header, and a sales manager generating their own pricelist
// needs the company's phone/website/address just as much as the CEO does.
companyProfileRouter.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM company_profile WHERE id = 1");
  res.json(rows[0]);
});

companyProfileRouter.patch("/", requireProductManager, async (req, res) => {
  const fields = ["name", "phone", "email", "website", "address", "logo_path"];
  const updates = Object.entries(req.body ?? {}).filter(([key]) => fields.includes(key));
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  const setClauses = updates.map(([key], i) => `${key} = $${i + 1}`);
  const values = updates.map(([, value]) => value);

  const { rows } = await pool.query(
    `UPDATE company_profile SET ${setClauses.join(", ")}, updated_by = $${values.length + 1}, updated_at = now()
     WHERE id = 1 RETURNING *`,
    [...values, req.user.id]
  );
  res.json(rows[0]);
});
