# KAD kit (shared navigation parts)

The files in `client/public/js/kit/` are the navigation parts both KAD apps share (Field Visits and KAD OS, `kdavtian/kad-gmm`), copied
byte for byte. What each file does, the rules for changing them and the CSS each app adds: `client/public/js/kit/README.md`.

In this app:
- `js/sheetNav.js` installs `kit/sheetBack.js` (Back closes the top sheet; every `.sheet-overlay` on `<body>` takes part except a docked
  desktop panel, the photo lightbox and the user guide) and `kit/sheetSwipe.js` (pull a bottom sheet down). `afterSheetStep()` makes
  `navigate()` wait for a closed sheet's history step before it opens the next screen.
- `js/screenMotion.js` uses `kit/transition.js` (a tab's kept pages, `shell/tabs.js`) and a CSS fade on a new screen (`shell/routes.js`).
- `shell/routes.js` asks `kit/navType.js` whether a screen change was Back/Forward (Navigation API), falling back to the 0.8 s flag.
- `app.js` installs `kit/navTiming.js`; batches go to `POST /api/perf/nav` (`server/src/system/navTimings.js`), the slowest screens show
  in Settings > Usage report.
- `searchSources.js` ranks screens and actions with `kit/palette.js` and the app's Armenian/Latin key (`shared/searchKey.js`).

A kit change is made in both repos in the same task: copy the file, bump `KIT_VERSION`, run `node scripts/check-kit.mjs --write` in both.
