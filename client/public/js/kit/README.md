# KAD kit (`client/public/js/kit/`)

The navigation parts both KAD apps share (owner, 2026-11-04: "one KAD navigation model"). The files are **identical** in
`kdavtian/SalesManagerVisits` (Field Visits) and `kdavtian/kad-gmm` (KAD OS), and in every new KAD app (KADDev
`references/kad-app-standard.md`). No imports of app code, no build step, plain ES modules.

| File | What it does |
|---|---|
| `sheetBack.js` | Back (Android button, browser Back, back swipe) closes the sheet on top first, then pages go back as before |
| `sheetSwipe.js` | Pull a bottom sheet down to close it (phone width), springs back when let go early |
| `transition.js` | 140 ms fade between screens with the View Transitions API; none on Back/Forward, reduced motion or power saving |
| `navType.js` | Navigation API: was the change Back/Forward or a tap (null when the browser cannot tell) |
| `navTiming.js` | Tap-to-screen time per route and slow interactions (Event Timing), sent in batches through the app |
| `palette.js` | Ranking for "one search for everything" (screens, actions, records) and the recently opened list |
| `version.js` | `KIT_VERSION` |

## Rules
1. Change a kit file in one repo -> copy it to the other repo in the same task, bump `KIT_VERSION` in both, run
   `node scripts/check-kit.mjs --write` in both (updates `kit.lock.json`). CI runs `node scripts/check-kit.mjs` and fails when a kit file
   changed without the lock: a kit change is always deliberate.
2. App-specific code (which selector a sheet has, how it closes, where timings are sent) stays in the app and calls the kit.
3. Install order: `installSheetBack` before the app's own `popstate` listener (it must run first).
4. CSS each app adds for `transition.js`:
   ```css
   ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 140ms; animation-timing-function: ease-out; }
   @media (prefers-reduced-motion: reduce) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; } }
   ```
5. New kit files go into the app's `sw.js` APP_SHELL like any other client file.
