# Castrol Global presentations

## KAD OS deck (current, November 2026)

An executive deck for Castrol Global that presents **KAD OS**, KAD Motors' distributor operating system, and proposes KAD as Castrol's showcase digital distributor.

| File | What it is |
|---|---|
| `KAD_OS_Castrol_Global.pptx` | 16:9, 14 slides + 3 appendix slides (architecture, security & data ownership, integration API). Speaker notes on every slide (~60 s each); slides 1 and 14 also carry the five tough questions with answers. Font: Arial only. |
| `KAD_OS_Castrol_Global.pdf` | PDF export of the deck, for e-mail. |
| `KAD_OS_OnePager.pdf` | One-page A4 leave-behind, ending with the proposal. |
| `kados/screenshots/*.png` | Framed iPhone screens used in the deck: `checkin`, `order`, `orders`, `assistant`, `map`, `customer`, `dashboard`, `vaghinak` (AI deputy director, management view), `vaghinak_rep` (a rep's must-answer question), `shelf_audit` (Castrol column of the shelf audit). |
| `kados/screenshots/raw/*.png` | Unframed 390x844 @3x originals. |
| `kados/source/` | Everything to rebuild: `shoot.mjs` (screens + automatic rejection), `assistant.html` / `assets.mjs` (Executive Assistant evening report, demo values), `frames.py`, `build_kados.py`, `onepager.html` / `onepager.mjs`. |
| `assets/kad-logo.png` | Official KAD logo (supplied by the owner, 2026-11-02). |
| `assets/castrol-logo.png` | Castrol logo file already used by the company's price lists (`server/assets/logos/castrol.png`), copied unchanged. Replace it with Castrol's official high-resolution file when available. |

### Branding
- Name "KAD OS"; lockup = "KAD OS" with "powered by Castrol" directly under it (text only, never mixed into a logo file). Tagline: "The operating system for a modern Castrol distributor."
- Logos are only the files in `assets/`, unmodified, on white backgrounds with clear space (there is no official reversed version, so no logo sits on a dark background). Castrol logo appears on slide 1, slide 14 and the one-pager only; every content slide carries the small KAD OS lockup in the footer.
- Palette sampled from the official Castrol logo file: green `#009343`, red `#F00023`; text `#141B24`.
- "powered by Castrol" is framed in the notes of slides 1 and 14 (and on the one-pager) as a PROPOSED co-brand, subject to Castrol's approval.

### Claims check (every capability claimed -> where it exists in the code)

| Claim (slide) | Status | Proof in the repo |
|---|---|---|
| GPS-verified check-in, refused beyond the allowance (300 m default) (6, 7) | Live | `server/src/field/routes/checkins.js`, `server/migrations/111_checkin_allowance.sql`, `client/public/js/views/checkin.js` |
| Photo with the visit (6, 7) | Live | `checkins.photo_path` in `server/src/field/routes/checkins.js` |
| Shelf audit: Castrol present, full range, fake product, competitor brands (7, 12) | Live | `checkins.brand_status`; `GET /api/customers/brand-summary` in `server/src/customers/routes/customers.js`; `client/public/js/brandChips.js` |
| Customer map / CRM (5, 7) | Live | `client/public/js/views/map.js`, `client/public/js/views/customerDetail.js` |
| Routes (module "Customers & Map") (5) | Live | `server/src/orders/routePlanner.js` |
| Central tier pricing, reps never type a price (8) | Live | `server/src/products/tierPricing.js` (gold individual prices: management only) |
| Discounts: up to 3 % automatic, more needs approval, below cost needs the CEO (8) | Live | `server/src/orders/discountPolicy.js` |
| Credit limits; over the limit the order waits for approval (8) | Live | `server/src/orders/creditLimit.js` |
| Debt aged per invoice; overdue becomes a collection task (8) | Live | `server/src/money/debtAge.js`, `server/src/money/debtCollectionTasks.js` |
| Targets and bonuses (5, 8) | Live | `server/src/bonus/`, `server/src/reports/routes/teamPerformance.js`, `client/public/js/views/teamPerformance.js` |
| Live dashboards, litres by product line, rep scorecards, debt ageing (5, 9) | Live | `server/src/reports/routes/dashboard.js`, `server/src/reports/routes/salesPerformance.js`, `server/src/reports/volumeReport.js`, `server/src/reports/scorecard.js` |
| Manager sees new orders live and approves (6) | Live | `server/src/orders/routes/orders.js`, `client/public/js/views/orders.js` |
| KAD OS Executive Assistant: daily, weekly, monthly management reports with risks (6, 9) | Live | repo `kdavtian/castrol_ceo_report`, `automation/ceo_agent.py` (`build_period_briefing`, anomaly checks), `work/build_ceo_report.py` |
| AI deputy director: watches the field day, assigns, chases, escalates (11) | Live (rule engine) | `server/src/team/vaghinak/` (`engine.js`, `evaluate.js`, `chasers.js`, `cluster.js`, `digest.js`) |
| Must-answer questions for reps (11) | Live | `MANDATORY_ROLES` in `server/src/team/vaghinak/engine.js`; blocking sheet in `client/public/js/vaghinak.js` |
| AI analyst, anonymised (11, A2) | Live | `server/src/team/askKad/` |
| Self-closing tasks (11) | Live | `server/src/team/taskAutoComplete.js`, `server/src/money/debtCollectionTasks.js` |
| Integration API for accounting, hashed tokens, test tokens (5, A3) | Live | `server/src/erp/routes/integration.js`, `server/src/erp/integrationTokens.js` |
| Daily accounting data feed, matched by ID (A3) | Live | `server/src/erp/routes/erpSync.js` |
| Customer ordering through partner endpoints (A3) | Pilot | `server/src/orders/routes/partner.js` (one customer) |
| Works offline, no duplicates (13, A2) | Live | `client/public/js/offlineQueue.js` (idempotent `client_ref`) |
| Fast on low-end phones: speed budgets on a slow phone (13) | Live | `server/test/e2e/speed-budget.spec.mjs` |
| Mobile web app from a link, no app store (5, 13) | Live | `client/public/manifest.app.json`, `client/public/sw.js` |
| 8 roles, enforced on the server (A2) | Live | `client/public/js/shared/roles.js`, `server/test/architecture.test.js` |
| HTTPS; signed sessions, CSRF, rate limits, lockout (A2) | Live | `deploy/nginx.conf`, `server/src/system/routes/auth.js`, `server/src/app.js` (helmet) |
| Audit trail (A2) | Live | `server/migrations/071_immutable_audit_logs.sql`, `070_order_status_history.sql`, `045_customer_level_audit.sql` |
| **Delivery & Driver** (5) | **Launching next** | partial pieces exist (`server/src/orders/routes/delivery.js`, `client/public/js/views/deliveryRoute.js`) but the module is not presented as live |
| **Warehouse** (5) | **Launching next** | partial pieces exist (`server/src/orders/routes/warehouse.js`, `client/public/js/views/warehousePack.js`, `client/public/js/views/stockCount.js`) but the module is not presented as live |
| **Expert AI agents for sales, finance, stock** (11) | **Next** | not built |
| **Brand-owner (Castrol) reports via the API** (A1, A3) | **Proposed** | not built |

### Where every number comes from
| Number | Source |
|---|---|
| 300 m check-in allowance | default in `server/migrations/111_checkin_allowance.sql` (management can change it) |
| 3 % automatic discount | `AUTO_APPROVE_PCT` in `server/src/orders/discountPolicy.js` |
| 8 roles | `ROLES` in `client/public/js/shared/roles.js` |
| ~1,200 automated tests | count of `test(` / `it(` in `server/test` (1,205 on 2026-10-30) |
| Live since August 2026 | git history (first production deploy 2026-08-24/25) |
| 9 live modules, 2 launching next | the module map above |
| 70 % (stage 1) | owner's market-plan target |
| Values in screens and in the Executive Assistant report | made-up demo data (local demo database; USD values in the report mock) |
| **Slides 2 and 10, one-pager results row** | **PENDING: verified numbers from the live system** (visits per month before/after, active customers before/after, Castrol shelf presence, orders and collections trend, with the exchange rate) |

### How to regenerate
1. A throwaway demo database with the app's demo seed, made deck-ready (never production):
   ```bash
   pg_ctlcluster 16 main start
   psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE fv_kados"
   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fv_kados JWT_SECRET=deck-local-secret-xxxxxxxx NODE_ENV=test
   (cd server && npm run migrate && DEMO_MODE=1 DEMO_PASSWORD=pick-any-demo-password node scripts/demo-site.mjs seed)
   node docs/castrol-global/source/anonymize-demo.mjs
   psql "$DATABASE_URL" -c "update products set unit = trim(trailing '.' from trim(trailing '0' from size_l::text)) || 'L'"
   psql "$DATABASE_URL" -f docs/castrol-global/source/vaghinak-demo.sql
   (cd server && PORT=3201 E2E_RATE_LIMIT_BYPASS_TOKEN=deck node src/index.js &)
   ```
2. Screens, mock, frames, deck, PDFs:
   ```bash
   cd docs/castrol-global/kados/source
   DECK_BYPASS=deck DECK_PASSWORD=pick-any-demo-password node shoot.mjs   # rejects Armenian text, keys, banned words, empty screens
   node assets.mjs && python3 frames.py
   python3 build_kados.py && node onepager.mjs
   cd ../.. && soffice --headless --convert-to pdf --outdir . KAD_OS_Castrol_Global.pptx
   ```
3. QA: render the PDF to PNGs (`pdftoppm -r 80 -png KAD_OS_Castrol_Global.pdf s`), look at every page, and search all slide text, notes and both PDFs for the banned words listed in the owner's brief (must be zero).

## Earlier deck: KAD Platform (October 2026)

An English deck and leave-behind that present the KAD Motors platform (Field Visits PWA + Castrol CEO Telegram bot / ERP sync) to Castrol Global executives as a scalable "Castrol Distributor Sales Platform".

## Files

| File | What it is |
|---|---|
| `KAD_Platform_Castrol_Global.pptx` | The deck: 16:9, 21 slides + 1 appendix slide (architecture & security), speaker notes on every slide. Font Arial (same look in PowerPoint and LibreOffice). |
| `KAD_Platform_OnePager.pdf` | One-page A4 leave-behind: the ten distributor problems and what the platform does about each, the data → decision → action loop, the proposal. |
| `screenshots/*.png` | Framed iPhone images used in the deck and the one-pager: `checkin`, `map`, `customer`, `order`, `debt`, `dashboard`, `team`, `vaghinak` (management view), `vaghinak_rep` (a rep's must-answer question), `tasks`, `reports`, `bot` (CEO-bot mock), `shelf_audit` (Castrol-only crop). |
| `screenshots/raw/*.png` | The unframed screenshots (390x844 @3x) the frames are made from. |
| `source/` | Everything needed to rebuild the above (scripts, icons, the bot mock page, the one-pager page, the Vaghinak demo messages). |

**Logo spots:** slide 1, slide 21 and the one-pager top right have a dashed box marked "CASTROL LOGO". Replace it with the official Castrol asset; the deck never draws or imitates the Castrol logo.

## Deck outline

1 Title · 2 At a glance · 3 Built by our whole team · 4 Data → decision → action · 5 Ten real problems · 6-7 Problem → solution · 8 The platform (app, Vaghinak, bot) · 9 How it works · 10 Field execution · 11 Commercial control · 12 Vaghinak: what he controls · 13 Vaghinak closes the loop · 14 AI and automatic calculations · 15 Financial and management reports · 16 Management visibility · 17 Twelve unique features · 18 A month at a glance (illustrative) · 19 3-stage market plan · 20 Roadmap · 21 Why it matters + proposal · A1 Architecture and security.

## No real data (owner's rule, 2026-10-30)

- **No real company figures anywhere**: no sales, litres, customers, debt, plan or collection numbers of KAD Motors. Slide 18 and the bot mock use **illustrative values in USD**, labelled as such; they only show what the platform measures.
- Every app screen uses **made-up demo data** from the app's demo seed (`server/scripts/demo-site.mjs`). `source/anonymize-demo.mjs` gives the shops English names, the reps neutral names (Rep A/B/C), fake phones and a Castrol-only catalogue. The app screens keep the app's own currency (AMD) on demo amounts.
- Vaghinak's messages are written in Armenian by the app; `source/vaghinak-demo.sql` puts English demo messages and English automatic-task titles into the demo database for the screenshots (marked "demo, translated" on the slide).
- Map tiles are drawn locally by `source/tiles.mjs` (neutral made-up streets).
- Facts that are kept are product facts, not business data: the 300 m check-in limit and 3% discount rule (app defaults), 8 roles, ~1,200 automated tests, 750+ improvements since August 2026 (git history).

## How to regenerate

From the repo root, in a dev environment with Postgres 16 and `server/node_modules` installed (`cd server && npm install`):

```bash
# 1. a throwaway demo database (never production)
pg_ctlcluster 16 main start
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE fv_deck"
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fv_deck JWT_SECRET=deck-local-secret-xxxxxxxx NODE_ENV=test
(cd server && npm run migrate && DEMO_MODE=1 DEMO_PASSWORD=pick-any-demo-password node scripts/demo-site.mjs seed)
node docs/castrol-global/source/anonymize-demo.mjs        # SHIFT_HOURS=0 if the machine clock is already Yerevan time
psql "$DATABASE_URL" -f docs/castrol-global/source/vaghinak-demo.sql

# 2. run the app on port 3201
(cd server && PORT=3201 node src/index.js &)

# 3. screenshots, icons + bot mock, frames, deck, one-pager
cd docs/castrol-global/source
DECK_PASSWORD=pick-any-demo-password node shoot.mjs      # or: node shoot.mjs map  (one screen)
node assets.mjs
python3 frames.py
python3 build_deck.py
node onepager.mjs
```

Needs Python 3 with `python-pptx` and `Pillow`, and Playwright's Chromium (pre-installed in the cloud sessions).

**QA render** (look at every slide before sharing):

```bash
soffice --headless --convert-to pdf --outdir /tmp/deck docs/castrol-global/KAD_Platform_Castrol_Global.pptx
pdftoppm -r 80 -png /tmp/deck/KAD_Platform_Castrol_Global.pdf /tmp/deck/s
```

Text edits: slide text and speaker notes live in `source/build_deck.py` (one block per slide); the one-pager text is in `source/onepager.html`; the bot mock is `source/bot.html`.
