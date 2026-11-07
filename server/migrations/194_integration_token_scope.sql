-- What a machine token may call (owner, 2026-11-07): 'accounting' = Lily's /api/integration/v1 (every token issued so far, so they keep
-- working), 'ops-read' = the read-only, pseudonymised /api/ops/v1 feed for the Claude scheduled agents (Reconciler, Monday brief).
-- Each router accepts only its own scope.
ALTER TABLE integration_tokens ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'accounting';
ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_scope_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_scope_check CHECK (scope IN ('accounting', 'ops-read'));
