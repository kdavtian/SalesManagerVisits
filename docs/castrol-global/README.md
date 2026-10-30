# Castrol Global presentation (KAD Motors platform)

An English deck and leave-behind that present the KAD Motors platform (Field Visits PWA + Castrol CEO Telegram bot / ERP sync) to Castrol Global executives as a scalable "Castrol Distributor Sales Platform".

## Files

| File | What it is |
|---|---|
| `KAD_Platform_Castrol_Global.pptx` | The deck: 16:9, 12 slides + 2 appendix slides (architecture & security; sources), speaker notes on every slide. Font Arial (looks the same in PowerPoint and LibreOffice). |
| `KAD_Platform_OnePager.pdf` | One-page A4 leave-behind that summarises the deck. |
| `screenshots/*.png` | The framed iPhone images used in the deck and the one-pager (`checkin`, `map`, `customer`, `order`, `debt`, `dashboard`, `team`, `bot`) and the Castrol-only crop of the shelf audit (`shelf_audit`). |
| `screenshots/raw/*.png` | The unframed screenshots (390x844 @3x) the frames are made from. |
| `build/` | Everything needed to rebuild the above (scripts, icons, the bot mock page, the one-pager page). |

**Logo spots:** slide 1, slide 12 and the one-pager top right have a dashed box marked "CASTROL LOGO". Replace it with the official Castrol asset; the deck never draws or imitates the Castrol logo.

## Data rules (how the deck stays clean)

- Every app screen and the CEO-bot report use **made-up demo data** from the app's own demo seed (`server/scripts/demo-site.mjs`), then `build/anonymize-demo.mjs` gives the shops English names, the reps neutral names (Rep A/B/C), fake phones (`+374 00 000 0xx`) and a Castrol-only catalogue. Nothing comes from production.
- Map tiles are drawn locally by `build/tiles.mjs` (neutral made-up streets), so no real map or address data is used.
- Business numbers are **aggregates** only (no customer, rep, price or debt detail).

## Where every number comes from

| Number on the slides | Meaning | Source |
|---|---|---|
| +27% | litres sold 1 Jan - 8 Oct 2026 (72.7k L) vs full year 2025 (57.4k L) | ERP workbook ORDERS sheet (v2.1.0 for 2026, v2.0.7 for 2025), internal stock rows (customer 10000) excluded. Recorded in the `Castrol-file` skill snapshots of 2026-10-12 and 2026-10-03 |
| 96% | Castrol litres vs 2026 plan to date (37,664 of 39,200 L) | Plan_2026 sheet, total block (snapshot 2026-10-12) |
| 90% | 2026 collections / 2026 sales | Cashflow "Oil order" receipts / ORDERS (snapshot 2026-10-12) |
| 78% / 103% / 93% | collections / sales for Q1, Q2, Q3 2026 | sums of the monthly sales and collection totals in snapshot 2026-10-12 (Q1 56.1/71.8, Q2 81.4/79.2, Q3 89.7/96.4, M AMD) |
| 230, 159 | customers who ordered in 2026 / in the last 90 days | ORDERS sheet (snapshot 2026-10-12) |
| 415, 10 of 11 | customer accounts / regions with customers (Yerevan + 9 of 10 provinces; none in Vayots Dzor) | Customers sheet (snapshot 2026-10-12) |
| 38.8k L | Castrol litres sold 1 Jan - 8 Oct 2026 | ORDERS sheet, brand Castrol (snapshot 2026-10-12) |
| live since Aug 2026; 750+ improvements; ~1,200 tests; 8 roles | platform facts | git history of this repo (first deploy 2026-08-24/25; 754 commits on `main` by 2026-10-30), `server/test` (`test(`/`it(` count), `client/public/js/shared/roles.js` |
| 300 m check-in limit; discounts above 3% need approval | app rules | App configuration default (`checkin_radius_meters`), `server/src/orders/discountPolicy.js` |
| Bot report and screen numbers | demo data | the demo database (e.g. bot "6 orders / 268 L / 1,636,640 AMD" = demo orders of 29 Oct) |

The Plan_2026 actual (37.7k L) uses the plan sheet's own cut-off and scope, so it differs slightly from the 38.8k L counted from ORDERS.
Field metrics from the live app (visits per month, Castrol presence %, coverage per region) are NOT in this version: they live only in the production database.

## How to regenerate

From the repo root, in a dev environment with Postgres 16 and `server/node_modules` installed (`cd server && npm install`):

```bash
# 1. a throwaway demo database (never production)
pg_ctlcluster 16 main start
psql postgres://postgres:postgres@localhost:5432/postgres -c "CREATE DATABASE fv_deck"
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/fv_deck JWT_SECRET=deck-local-secret-xxxxxxxx NODE_ENV=test
(cd server && npm run migrate && DEMO_MODE=1 DEMO_PASSWORD=pick-any-demo-password node scripts/demo-site.mjs seed)
node docs/castrol-global/build/anonymize-demo.mjs        # SHIFT_HOURS=0 if the machine clock is already Yerevan time

# 2. run the app on port 3201
(cd server && PORT=3201 node src/index.js &)

# 3. screenshots, icons + bot mock, frames, deck, one-pager
cd docs/castrol-global/build
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

Text edits: slide text and speaker notes live in `build/build_deck.py` (one block per slide); the one-pager text is in `build/onepager.html`; the bot mock is `build/bot.html`.
