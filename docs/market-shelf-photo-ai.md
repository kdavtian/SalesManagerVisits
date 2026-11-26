# Shelf photo -> AI fills the shelf and price form (plan only, not built)

Owner, 2026-11-26: plan "PR12" of the Market module, written down and not built. The rep takes one photo of the shop's oil shelf at
the check-in. A Claude model reads the brands, packs and price tags from it and fills the check-in's shelf chips and competitor price rows.
The rep only confirms or corrects them. Goal: more and better market data (Reports > Market) with less typing.

## Flow (rep, about 10 seconds)
1. Check-in -> Shelf section -> **Photo of the shelf** (camera, one photo; a second only when the shelf does not fit).
2. The photo uploads with the check-in, like visit photos. The server sends it to the model in the background.
   - The check-in never waits for the model.
   - Offline: the photo queues with the check-in.
3. About 5-15 s later the form shows the proposals, marked "from photo":
   - Castrol / Lotos / Royal chips
   - competitor brands present
   - price rows (brand, line, volume, retail when a tag is readable)
4. The rep taps **Confirm** or corrects a chip or a price. Nothing is saved as shelf data without that tap.
   - Confirmed rows are saved exactly as typed rows are today: `brand_status` and `competitor_prices`.
   - Each saved row keeps a `source = 'photo'` mark.
5. If the model is unsure (a blurred tag, an unknown brand), that row is left empty and the rep fills it by hand.

## What the model returns (strict JSON, validated on the server)
- `castrol`: subset of `available | full_range | fake_suspect | imported_suspect`.
  - A photo can only make counterfeit **suspected**: the rep decides.
- `competitors`: brand keys from `competitor_brands`. A brand not in the list goes to "+ Add new brand" as a suggestion and is never
  auto-added.
- `prices`: rows of `{ brand, line_code, volume, retail_amd, confidence }`.
  - Only the shop's shelf (retail) price can be read from a tag; the wholesale price stays a question the rep asks.
- `confidence` per row (0-1). Rows below 0.7 are not proposed.

## Cost per photo (estimate)
Prices are from the app's own price table (`server/src/customers/aiBlankCheck.js` / `askKad/engine.js`). Check them against the current
Anthropic list before building.

The photo is resized to about 1,600 px on the long edge, about 2,500 image tokens. Add about 1,500 prompt tokens (brand list, line codes)
and about 600 output tokens:

| Model | Input $/M | Output $/M | Per photo | 3,300 photos / month* |
|---|---|---|---|---|
| claude-haiku-5-5 | 0.10 | 0.50 | ~$0.0007 | ~$2 |
| claude-sonnet-5-5 | 2 | 10 | ~$0.014 | ~$46 |
| claude-opus-5-5 | 4 | 20 | ~$0.028 | ~$92 |

\* 25 reps x 6 shelf photos a day x 22 working days.

- Recommendation: start with **Sonnet** and measure accuracy (below). Try Haiku on the same photos; switch to it only if it passes.
- A monthly USD cap in Settings, as KAD AI and the blank check have. At the cap, the photo is kept and the form is filled by hand.

## Privacy
- Only the shelf photo is sent: no customer name, phone, TIN or GPS. The request names the shop by nothing.
- The rep is told to photograph the shelf, not people. The server crops nothing, so a face in the frame would be sent.
  - Mitigation: the camera screen shows "shelf only".
  - Photos stay on our server under the same rules as visit photos.
- API key only on the droplet (`ANTHROPIC_API_KEY`, already used by KAD AI and the blank check), never in the app or chat.
- The provider's API data terms apply (no training on API data by default). The owner confirms this before turning it on.

## Accuracy checks (before reps rely on it)
1. **Shadow month.** The model runs on every shelf photo, but the form is still filled by hand.
   - We compare the model's proposal with what the rep typed: brand recall / precision, price exact-match rate, Castrol chip agreement.
   - Shown to admin in Reports > Market data quality.
2. **Go-live bar** (owner decides):
   - brand precision >= 95 % and recall >= 85 %
   - readable price tags matched within 1 % in >= 90 % of rows
   - zero "fake" proposals without the rep's tap
3. **Live.** Every confirmed row keeps `source = 'photo'` and whether the rep changed it. A weekly check flags reps who confirm everything
   unchanged (rubber-stamping) and drifting accuracy.
4. The existing cleaning rules (PR5: per-litre prices, retail < wholesale, 3x off the median) apply to photo rows like any other.

## What it needs (when built)
- One additive migration:
  - `checkin_shelf_photos` (photo path, model, tokens, cost, raw JSON, status)
  - a `source` column on `competitor_prices`
- One background job: read the photo and store the proposal (never blocks the check-in).
- Check-in screen: the photo button, a "from photo" proposal state, Confirm.
- Settings: On / Off (default Off), model, monthly cap.
- Tests: JSON validation, cap, offline queue, shadow comparison maths, e2e of confirm / correct.

## Open questions for the owner
1. Start with Sonnet (about $46 a month at the volume above) or try Haiku first (about $2, likely less accurate)?
2. Shadow month first (recommended), or live from day one for a few reps?
3. Should "fake suspected" from a photo also notify the sales director, or only show to the rep?
