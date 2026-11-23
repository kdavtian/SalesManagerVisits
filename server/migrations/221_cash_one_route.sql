-- One route for cash (owner, 2026-11-23): rep -> sales director -> accountant (a rep may hand straight to the accountant). The accountant
-- no longer approves a rep's cash that was never handed over in the app; admin and the CEO keep that right. This switch brings the old
-- behaviour back from App configuration if the office gets stuck. OFF by default (= the new rule).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS accountant_direct_approval BOOLEAN NOT NULL DEFAULT false;
