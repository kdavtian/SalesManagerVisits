# Armenian places: spelling autocorrect for region / subregion

Owner, 2026-10-25: "collect all Armenian city, village, region, subregion, hamaynq names to a small db and autocorrect. Allow to edit with free text in the customer card and show edit for review."

- **The list:** `server/src/data/armeniaPlaces.json`: 11 marzes (with Yerevan), the 12 Yerevan districts and about 1,150 cities and villages, each with its Armenian name and other spellings
  (old names, Russian, Latin transliterations). Source: GeoNames (CC BY 4.0) with Wikidata labels, generated once; places an admin approves are added in the table `custom_places`.
  The client has the display-only copy `client/public/js/placesData.js` (English, Armenian, marz; about 37 KB, in the offline cache).
  Communities (hamaynq) that carry the name of their centre are matched through that settlement's name; a separate list of communities was not built.
- **Matching** (`server/src/places.js`): `placeKey()` turns any spelling (Armenian, Russian, Latin) into one phonetic key; an exact key is a clean match, a key one letter off (names of 5+ letters; two for 9+) with exactly one candidate is corrected and logged as "corrected one letter".
  A place is looked for inside the chosen marz first (Yerevan: only the 12 districts). A place typed into the region field fills the marz and the subregion. A place of another marz keeps the chosen marz and is flagged "In another marz".
- **Stored value:** always the English name ("Gyumri", "Shirak"), as before. The app shows Armenian when the UI is Armenian (`placeLabel`, `regionLabelHy`, `subregionLabelHy`) and shows English for a name saved in Armenian letters when the UI is English.
- **Where it runs:** new customer (`POST /api/customers`), edit on the customer card (`PATCH /api/customers/:id`), an approved edit request, the Excel sync's region/subregion fill, and the route-distribution lookup. The response carries `place_notice`; the app says it in one line ("Saved as: Gyumri, Shirak." / "... is not in the list of Armenian places. Saved as typed and sent for review.").
- **Free text stays possible:** an unknown text is saved as typed and queued in `place_reviews` (one open row per customer field; fixing the text closes it). The customer card shows a "to review" mark to management.
- **Review screen:** Settings -> Administration -> System -> "Places (spelling)": per item "Use <suggestion>" (also moves the marz when the place is in another one), "Keep as typed" (adds it to `custom_places`, optional Armenian name) or "Dismiss".
  Same screen: "Fix the spellings already saved" shows what would change in the customers and, with one tap, rewrites the customers, `route_distribution` and the areas of `visit_plan_rules` together (what is still unknown is queued for review).
- **API** (`/api/places`): `GET /search`, `POST /resolve`, `GET /reviews`, `GET /reviews/count`, `POST /reviews/:id/resolve`, `GET /cleanup`, `POST /cleanup/apply`. Review/cleanup roles: admin, CEO, operations director, sales director.
- Tests: `server/test/integration/places.test.js`, `server/test/e2e/places.spec.mjs`.
