# UI release QA checklist

Run this checklist after deploying to staging and before promoting a UI release to production.

## Automated gate

From the repository or the running app container:

```bash
cd server && npm run verify:ui
docker compose exec -T app npm run verify:ui
```

`deploy/deploy.sh` runs the container command automatically and stops if a critical UI invariant fails.
After the container starts, it also runs `npm run verify:deployment` to wait for API health and confirm the HTML, CSS, and JavaScript entry assets are being served.

## Required device matrix

- iPhone Safari and installed PWA: 375×667, 390×844, and 430×932.
- Android Chrome and installed PWA: one current Pixel or Samsung-sized viewport.
- Compact portrait: 320 px width.
- Landscape: phone at 568×320 and 844×390; tablet at 1024×768 in both orientations.
- Repeat the core flow in English and Armenian, light and dark mode.
- Repeat one portrait flow at 200% browser zoom or the largest practical OS text size.

## Critical navigation and layout

- Open every bottom-nav destination; the active item is visually clear and announced as current.
- On Map, pan and zoom continuously for 60 seconds, open and close a customer card, then switch tabs. The menu must remain visible and tappable throughout.
- Rotate portrait → landscape → portrait on Dashboard, Map, Customers, Activity, and Settings. No blocker, clipping, overlap, or unreachable action is allowed.
- Confirm the compact landscape side rail does not cover map controls or content.
- Confirm the iOS home indicator and device notch do not cover navigation, headings, dialogs, or primary actions.
- At 320 px and with long Armenian labels, text must wrap without horizontal scrolling.

## Core field workflow

- Dashboard: progress, next visit, and recent activity show loading, success, empty, and API-error states correctly.
- Map: use each filter and confirm its visual/announced selected state matches the pins.
- Add customer: enter add mode, drop and move a pin, reverse-geocode, complete required fields, and submit.
- Submit an empty/invalid customer form; focus moves to the first error and corrected fields clear their errors.
- Check in with location allowed, denied, timed out, and outside the permitted radius; retry works without reloading.
- Capture/upload a photo, submit a visit, and confirm the result appears in Activity and customer history.
- Go offline before submission, confirm the queued state, reconnect, sync, and verify there is no duplicate visit.

## Keyboard and assistive technology

- Navigate the full app using Tab/Shift+Tab; focus is always visible and never trapped behind an overlay.
- Open each dialog, move through its controls, close with Escape, and confirm focus returns to the trigger.
- Use the ERP combobox with Up/Down, Enter, and Escape; the active option and selection are announced.
- Use Left/Right arrows on Activity tabs and confirm focus and selection move together.
- With VoiceOver or TalkBack, verify page headings, navigation labels, map filters, buttons, field errors, loading messages, and dialog titles.
- With reduced motion enabled, verify transitions are minimal and nothing depends on animation to communicate state.

## Release sign-off

- No critical-flow failure, invisible navigation, blocked landscape view, inaccessible dialog, or data-loss/duplicate-sync issue remains.
- Record device/OS/browser, language/theme, build commit, tester, date, and any accepted non-blocking issue.
- If a critical item fails, do not release; attach a screenshot/video and exact reproduction steps to the issue.
