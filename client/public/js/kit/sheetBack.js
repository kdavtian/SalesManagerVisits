// KAD kit - Back closes the sheet on top first (owner, 2026-11-04: "Back always does what the thumb expects").
// The Android Back button, the browser's Back, a back swipe or Alt+Left close the open sheet and stay on the page; the next Back goes back
// as before. Works for every sheet of the app without wiring each one: a sheet overlay appearing on document.body is noticed (MutationObserver)
// and gets one history step of its own, with the same address (no hashchange, the router never runs for it).
//
//   installSheetBack({ selector, close, isLocked })
//     selector  - what a sheet overlay is (direct child of <body>), e.g. ".sheet-overlay"
//     close     - (overlay) => void: close it the app's own way (animation, cleanup, focus back). Called for a Back press.
//     isLocked  - (overlay) => bool: a sheet that must be answered first (Back keeps it open). Optional.
//     skip      - (overlay) => bool: a sheet that never takes a history step (a toast-like panel, a docked desktop panel). Optional.
//
// Cases handled:
//   - closed by its own button / background tap / Esc: its history step is taken back quietly (history.back(), ignored here);
//   - the app navigates from inside the sheet (a row opens a page): the step stays behind the new page ("left behind"); arriving on it later
//     is skipped (one quiet extra step), unless the app puts a sheet back on that step itself (a parked sheet coming back adopts it);
//   - sheet over sheet: one step each, Back closes the top one;
//   - a reload while a step was on top: that entry becomes a normal one.
// IDENTICAL in KAD OS and Field Visits (js/kit/). Change it in one repo, copy it to the other, bump kit/version.js and the lock (kit/README.md).
import { lastNavigation } from "./navType.js";

const MARK = "kadSheet";
let seq = 0;
let ignorePops = 0;
const open = []; // [{ overlay, id }], oldest first
const leftBehind = new Set(); // ids of steps whose sheet went away while another page was on top
const closingByBack = new WeakSet();

const markOf = (state) => (state && typeof state === "object" ? state[MARK] : undefined);

export function installSheetBack({ selector, close, isLocked = () => false, skip = () => false }) {
  if (installSheetBack.done) return;
  installSheetBack.done = true;
  // a reload on a sheet's step: no sheet is open any more, so it is a normal entry again
  if (markOf(history.state) !== undefined) history.replaceState(history.state.prev ?? null, "");

  const take = (overlay) => {
    if (open.some((o) => o.overlay === overlay) || skip(overlay)) return;
    const here = markOf(history.state);
    // a sheet put back on the step it had (the app parks a sheet while a page from inside it is open, and restores it on Back)
    if (here !== undefined && leftBehind.has(here) && !open.some((o) => o.id === here)) {
      leftBehind.delete(here);
      open.push({ overlay, id: here, href: location.href });
      return;
    }
    const id = ++seq;
    history.pushState({ [MARK]: id, prev: history.state ?? null }, "", location.href);
    open.push({ overlay, id, href: location.href });
  };

  const release = (overlay) => {
    const i = open.findIndex((o) => o.overlay === overlay);
    if (i < 0) return;
    const [{ id }] = open.splice(i, 1);
    if (closingByBack.has(overlay)) return; // Back already took the step
    if (markOf(history.state) === id) {
      ignorePops += 1;
      history.back();
    } else leftBehind.add(id);
  };

  new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((n) => n.nodeType === 1 && n.matches?.(selector) && release(n));
      r.addedNodes.forEach((n) => n.nodeType === 1 && n.matches?.(selector) && n.isConnected && take(n));
    }
  }).observe(document.body, { childList: true });
  document.querySelectorAll(`body > ${selector}`).forEach(take);

  // Registered before the app's own listeners (install the kit first): it runs first and stops the event when it was only a sheet's step.
  window.addEventListener(
    "popstate",
    (e) => {
      if (ignorePops > 0) {
        ignorePops -= 1;
        e.stopImmediatePropagation();
        return;
      }
      const here = markOf(e.state);
      const top = open[open.length - 1];
      // A new address (location.hash = ..., a link) fires popstate too: only a Back/Forward step closes a sheet. The Navigation API says
      // which it was; without it, a step back from a sheet's step lands on the same address it was opened on.
      const nav = lastNavigation();
      const traverse = nav ? nav.type === "traverse" : top && location.href === top.href;
      if (top && traverse && here !== top.id) {
        // Back from the top sheet's step: that sheet closes, the page stays (same address: the app's router must not run for it)
        if (isLocked(top.overlay)) {
          history.pushState({ [MARK]: top.id, prev: e.state ?? null }, "", location.href);
        } else {
          open.pop();
          closingByBack.add(top.overlay);
          try {
            close(top.overlay);
          } catch (err) {
            console.error(err);
            top.overlay.remove();
          }
        }
        e.stopImmediatePropagation();
      }
      if (here !== undefined && leftBehind.has(here)) {
        // a step whose sheet is gone: step over it, once the app had its chance to put the sheet back (a parked sheet adopts it)
        const forward = lastNavigation()?.back === false;
        setTimeout(() => {
          if (markOf(history.state) !== here || open.some((o) => o.id === here)) return;
          leftBehind.delete(here);
          ignorePops += 1;
          if (forward) history.forward();
          else history.back();
        }, 350);
      }
    },
    true
  );
}

/** How many sheets hold a history step now (for tests). */
export const sheetSteps = () => open.length;
