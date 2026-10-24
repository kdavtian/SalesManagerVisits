# Settings structure (1.405.0)

Owner brief (2026-10-24): "rearrange settings and admin part from 0 ... Apple iOS and macOS styles and structure".

## Structure
Two tabs (only people with an admin-type role see the second): **Personal** | **Administration**.

| Tab | Page id | What it holds |
|---|---|---|
| Personal | `p-account` | profile card, phone, change password, sessions, (log out) |
| Personal | `p-appearance` | dark mode, language, efficiency mode, text size |
| Personal | `p-notifications` | push on/off + per-type preferences |
| Personal | `p-data` | sync status, refresh, offline storage, map tile cache |
| Personal | `p-about` | version, check for updates, user guide |
| Administration | `a-team` | Team management, notification defaults, Home quick actions |
| Administration | `a-sales` | plan approvals, edit requests, check-in limit / distance / visit frequency / skip-recent, channel owners, pin review, driver arrival |
| Administration | `a-finance` | reports management, product catalog, company profile, landing-cost settings, retail-from-Excel, financial exports |
| Administration | `a-bonuses` | bonuses on/off + message, challenges, reward claims, points closeout |
| Administration | `a-integrations` | KAD AI (Ask KAD) on/off + monthly cap, KAD OS perks and campaigns |
| Administration | `a-security` | app lock code, calculator disguise, session management, emergency disconnect |
| Administration | `a-system` | system health (Excel sync, AI test), data quality, notification delivery log, client error log |

A category is listed only when the user's role may use something in it (`PAGES[].show` in `client/public/js/views/settings.js`).

## Behaviour
- Phone: Personal is one scrolling list of pages. Administration is a list of categories; a tap opens `#/settings?section=<page id>` (its own route: Back / swipe-back returns to the list). The search box (top) searches every page; a result opens the page and flashes the row.
- Computer (>= 1024 px): sidebar (search, tabs, pages) + the selected page. A row that opens its own screen (Team management, ...) replaces the page with a Back button named after the page. The page you were on is kept across theme/language changes.
- Explanations are never printed under a field: a small "!" on the label toggles them (`hintIcon(textId)` + hidden paragraph).
- Old links keep working: `section=plan-approvals` -> Sales & customers (scrolled to the list), `section=system-health` -> System & health (row opened).

## Counts
`GET /api/settings/admin-counts` (`server/src/adminCounts.js`) returns what is waiting for the signed-in user, per category: `a-sales` (route plans waiting for approval + customer edit requests), `a-bonuses` (reward claims awaiting validation or payout), `a-system` (1 when the Excel sync or file is stale). The Settings list shows them as red counts beside the category and as a total on the Administration tab; they refresh when plans / edit requests change. A role gets only the keys it can act on.

## For developers
- Every page is rendered into the DOM at once and `applyState()` only toggles `hidden`; the handlers below the template find elements by id, so **ids must not change**.
- A new setting goes into the page whose category fits; add its label to the page so the search finds it (rows need `.settings-row-label` / `.settings-form-label`).
- Tests: `server/test/e2e/settings-structure.spec.mjs`; other specs open an admin page with `/#/settings?section=a-...`.

## Sales channel sets the rep (1.407.0)
In Account settings on the customer card, choosing a sales channel selects that channel's owner (Sales channel owners) as the assigned rep; the rep can still be changed by hand before saving.

## Today's planned visits - three states (1.408.0)
The map button and the pin key share one state: Off, Highlight (ring in the planning rep's colour + that rep's stop number on the pin) and Only today (Highlight + the other pins hidden). Per user, default off.
