// Admin-only management of integration tokens (create once / list / revoke)
// and a view of the audit log of calls made with them.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { createIntegrationToken, listIntegrationTokens, revokeIntegrationToken } from "../integrationTokens.js";

export const integrationAdminRouter = Router();
integrationAdminRouter.use(requireAuth, requireAdmin);

integrationAdminRouter.get("/", async (req, res) => {
  res.json(await listIntegrationTokens());
});

integrationAdminRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  const created = await createIntegrationToken({ name, testMode: Boolean(req.body?.test_mode), createdBy: req.user.id });
  // The plaintext token is only ever returned here, once.
  res.status(201).json(created);
});

integrationAdminRouter.delete("/:id", async (req, res) => {
  const revoked = await revokeIntegrationToken(Number(req.params.id));
  if (!revoked) return res.status(404).json({ error: "Token not found or already revoked" });
  res.json(revoked);
});

integrationAdminRouter.get("/audit", async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const { rows } = await pool.query("SELECT * FROM integration_audit_log ORDER BY id DESC LIMIT $1", [limit]);
  res.json(rows);
});
