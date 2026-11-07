#!/usr/bin/env node
// Manage integration tokens from the server shell: Lily's (accounting) and the Claude agents' read-only ops feed (--ops).
//   node scripts/integration-token.mjs create "Lily" [--test]
//   node scripts/integration-token.mjs create "Claude agents" --ops     (scope ops-read: only /api/ops/v1, docs/ops-api.md)
//   node scripts/integration-token.mjs list
//   node scripts/integration-token.mjs revoke <id>
// The plaintext token is printed once by `create` and never stored.
import { pool } from "../src/db/pool.js";
import { createIntegrationToken, listIntegrationTokens, revokeIntegrationToken } from "../src/erp/integrationTokens.js";

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "create" && arg) {
    const scope = process.argv.includes("--ops") ? "ops-read" : "accounting";
    const t = await createIntegrationToken({ name: arg, testMode: process.argv.includes("--test"), scope });
    console.log(`Created ${t.scope} token #${t.id} "${t.name}"${t.test_mode ? " (TEST MODE)" : ""}. Copy it now -- it is not shown again:\n\n${t.token}\n`);
  } else if (cmd === "list") {
    console.table(await listIntegrationTokens());
  } else if (cmd === "revoke" && arg) {
    const r = await revokeIntegrationToken(Number(arg));
    console.log(r ? `Revoked #${r.id} "${r.name}"` : "Not found or already revoked");
  } else {
    console.log('Usage: create "<name>" [--test | --ops] | list | revoke <id>');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
