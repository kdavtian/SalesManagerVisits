import crypto from "node:crypto";
import { pool } from "../db/pool.js";

// What a token may call (migration 194): each router accepts only its own scope.
//   accounting  Lily, /api/integration/v1 (read orders, write accounting status)
//   ops-read    the Claude scheduled agents, /api/ops/v1 (GET only, pseudonymised: docs/ops-api.md)
export const TOKEN_SCOPES = ["accounting", "ops-read"];
const PREFIX = { accounting: "kad_lily_", "ops-read": "kad_ops_" };

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Plaintext is returned once to the caller and never stored.
export async function createIntegrationToken({ name, testMode = false, createdBy = null, scope = "accounting" }) {
  if (!TOKEN_SCOPES.includes(scope)) throw new Error(`unknown token scope: ${scope}`);
  const token = `${PREFIX[scope]}${crypto.randomBytes(32).toString("hex")}`;
  const { rows } = await pool.query(
    `INSERT INTO integration_tokens (name, token_hash, test_mode, created_by, scope)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, test_mode, scope, created_at`,
    // test mode only means something to Lily's order queue
    [name, hashToken(token), scope === "accounting" && testMode, createdBy, scope]
  );
  return { ...rows[0], token };
}

export async function listIntegrationTokens() {
  const { rows } = await pool.query(
    "SELECT id, name, scope, test_mode, created_at, last_used_at, revoked_at FROM integration_tokens ORDER BY id"
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

/**
 * The bearer token of a request, checked against one scope. Returns { token } (id, name, test_mode, scope) or { status, code, message }:
 * 401 = no / unknown / revoked token, 403 = a valid token of another scope (a Lily token on the ops feed, or the reverse).
 */
export async function checkBearer(req, scope) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  if (!match) return { status: 401, code: "unauthorized", message: "Missing bearer token" };
  const { rows } = await pool.query(
    "SELECT id, name, test_mode, scope FROM integration_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(match[1])]
  );
  if (!rows[0]) return { status: 401, code: "unauthorized", message: "Invalid or revoked token" };
  if (rows[0].scope !== scope) return { status: 403, code: "wrong_scope", message: "This token is not allowed on this API" };
  pool.query("UPDATE integration_tokens SET last_used_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});
  return { token: rows[0] };
}
