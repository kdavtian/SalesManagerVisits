# 08 — Resources & AI layer (Phase 8) — excel-off-single-erp
## People
| who | role in the program | time |
|---|---|---|
| Owner (admin) | decides each switch, reviews on phone, runs deploy blocks | ~2 h/week [ESTIMATE] |
| Accountant / financial director | cleansing, shadow checks, sign-off, period close | 2 h/week + 1 h/day during each shadow [ESTIMATE] |
| Sales director, warehouse lead, drivers | new screens; physical count day | training 1 h each per module [ESTIMATE] |
| Tax / legal adviser (external) | answers T0.6 | 4–8 h [ESTIMATE — no reference class] |
## Tools (with alternatives)
- Existing stack (Node/Postgres/PWA, droplet) — no new licences. Alternative rejected: Odoo core (06, option C).
- Backups: encrypted pg_dump nightly → second location; alternative: managed Postgres with point-in-time recovery (DigitalOcean managed DB) [ESTIMATE cost; not fetched].
## Budget
Software licences 0; adviser fee [ESTIMATE — owner to confirm]; extra droplet storage / backup target small [ESTIMATE].
## Data / documents
Latest workbook; accountant's list of who types what; accounting program name + import format; supplier invoices sample (for P4 design).
## AI layer
- **Reconciler** (agent): daily per-module diff + streak; refuses destructive syncs.
- **Tax Insider** (agent): prepares tax questions/checklists; accountant decides.
- **KAD Builder** (Claude + KADDev + kad-edit): builds every step.
- **Vaghinak** (exists): extend with "unposted document" and "period not closed" nudges.
- **Lily** (exists): extend with receipts, credit notes, purchases feeds.
- **CEO bot** (exists): re-source from app API.
