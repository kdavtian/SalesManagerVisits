import crypto from "node:crypto";
import { pool } from "./db/pool.js";

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Plaintext is returned once to the caller and never stored.
export async function createIntegrationToken({ name, testMode = false, createdBy = null }) {
  const token = `kad_lily_${crypto.randomBytes(32).toString("hex")}`;
  const { rows } = await pool.query(
    `INSERT INTO integration_tokens (name, token_hash, test_mode, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, name, test_mode, created_at`,
    [name, hashToken(token), testMode, createdBy]
  );
  return { ...rows[0], token };
}

export async function listIntegrationTokens() {
  const { rows } = await pool.query(
    "SELECT id, name, test_mode, created_at, last_used_at, revoked_at FROM integration_tokens ORDER BY id"
  );
  return rows;
}

export async function revokeIntegrationToken(id) {
  const { rows } = await pool.query(
    "UPDATE integration_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, name, revoked_at",
    [id]
  );
  return rows[0] ?? null;
}
