#!/usr/bin/env node
// Manage integration tokens (Lily) from the server shell.
//   node scripts/integration-token.mjs create "Lily" [--test]
//   node scripts/integration-token.mjs list
//   node scripts/integration-token.mjs revoke <id>
// The plaintext token is printed once by `create` and never stored.
import { pool } from "../src/db/pool.js";
import { createIntegrationToken, listIntegrationTokens, revokeIntegrationToken } from "../src/integrationTokens.js";

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "create" && arg) {
    const t = await createIntegrationToken({ name: arg, testMode: process.argv.includes("--test") });
    console.log(`Created token #${t.id} "${t.name}"${t.test_mode ? " (TEST MODE)" : ""}. Copy it now -- it is not shown again:\n\n${t.token}\n`);
  } else if (cmd === "list") {
    console.table(await listIntegrationTokens());
  } else if (cmd === "revoke" && arg) {
    const r = await revokeIntegrationToken(Number(arg));
    console.log(r ? `Revoked #${r.id} "${r.name}"` : "Not found or already revoked");
  } else {
    console.log('Usage: create "<name>" [--test] | list | revoke <id>');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
