# Castrol Global presentation (KAD Motors platform)

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
