// Sheets and the Back button / gestures (owner, 2026-11-04: "Back always does what the thumb expects"), with the shared KAD kit (js/kit/):
//   1. Back (Android button, browser Back, a back swipe) closes the sheet on top first and stays on the page (kit/sheetBack.js). The
//      next Back goes back through the pages as before.
//   2. On a phone a bottom sheet can be pulled down to close it (kit/sheetSwipe.js); the left-edge swipe some sheets have stays.
//   3. Every sheet has a grab bar (phone) and an X in its top-right corner (below).
// Every sheet of the app is a `.sheet-overlay` appended to <body> and closed by removing it (the same way Esc closes the top one), so
// nothing has to be wired per sheet. Not taking part: a panel docked beside a desktop list (it is part of the page there, Back goes back a
// page as before) and the full-screen viewers (photo lightbox, user guide), which have their own gestures.
import { installSheetBack } from "./kit/sheetBack.js";
import { enableSwipeDown } from "./kit/sheetSwipe.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";

const SELECTOR = ".sheet-overlay";
const notASheet = (overlay) => overlay.classList.contains("sheet-docked") || overlay.classList.contains("pd-lightbox") || overlay.classList.contains("guide-overlay");
// a sheet that must be answered first (the lockdown screen, a forced question) says so with data-locked
const isLocked = (overlay) => overlay.dataset.locked === "1";
// Every way of closing a sheet that is not its own buttons (the X, a pull down, Back) goes through here: the sheet gets a "sheet-dismiss"
// event first, so one that has to tidy up (a file link, a timer, a list to reload) listens for it and closes itself its own way
// (event.preventDefault()); any other sheet is simply removed.
export function dismissSheet(overlay) {
  if (!overlay?.isConnected) return;
  const ev = new CustomEvent("sheet-dismiss", { cancelable: true });
  if (overlay.dispatchEvent(ev)) overlay.remove();
}
const closeSheet = dismissSheet;

// 3. Every sheet has the same top (owner, 2026-11-14: "like KAD OS: X button, slide down to close"): a grab bar on a phone and an X in the
// top-right corner. A sheet that already draws its own X keeps it; a sheet that must be answered first gets none. The X comes back when
// the sheet redraws itself (many sheets replace their whole content after loading).
const OWN_CLOSE = ".sheet-close-x, [data-sheet-x]"; // plus any button labelled "Close" (below)
function ensureSheetTop(overlay) {
  if (!overlay.isConnected || notASheet(overlay) || isLocked(overlay)) return;
  const panel = overlay.querySelector(":scope > .sheet");
  if (!panel) return;
  const label = t("close");
  const hasClose = panel.querySelector(OWN_CLOSE) || [...panel.querySelectorAll("button[aria-label]")].some((b) => b.getAttribute("aria-label") === label);
  if (!panel.querySelector(":scope > .sheet-grab")) {
    const grab = document.createElement("div");
    grab.className = "sheet-grab sheet-grab-auto";
    grab.setAttribute("aria-hidden", "true");
    panel.prepend(grab);
  }
  if (hasClose) return;
  const x = document.createElement("button");
  x.type = "button";
  x.className = "icon-btn sheet-close-x";
  x.dataset.sheetX = "1";
  x.setAttribute("aria-label", label);
  x.innerHTML = icons.close;
  x.addEventListener("click", () => dismissSheet(overlay));
  // a sheet laid out as a flex column / grid would put the X on a row of its own: there it is pinned to the corner instead
  if (/flex|grid/.test(getComputedStyle(panel).display)) {
    x.classList.add("sheet-close-x-pin");
    panel.classList.add("sheet-pinned-x");
  }
  panel.querySelector(":scope > .sheet-grab").after(x);
}
function addSheetTop(overlay) {
  if (notASheet(overlay)) return;
  ensureSheetTop(overlay);
  // after the first frame too: a sheet can turn into a docked desktop panel (or get data-locked) right after it is put on the page
  requestAnimationFrame(() => ensureSheetTop(overlay));
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      ensureSheetTop(overlay);
    });
  }).observe(overlay, { childList: true, subtree: true });
}
const OWN_GESTURE = ".leaflet-container, canvas, .signature-pad, .zoom-stage, input[type=range], [data-own-gesture]";

function addSwipe(overlay) {
  if (notASheet(overlay)) return;
  // after the first frame: the sheet's content and class (docked or not) are in place by then
  requestAnimationFrame(() => {
    if (!overlay.isConnected || notASheet(overlay)) return;
    const panel = overlay.querySelector(":scope > .sheet");
    if (!panel) return;
    // only a sheet that sits on the bottom edge is pulled down (a centred dialog is not a bottom sheet)
    const rect = panel.getBoundingClientRect();
    if (rect.bottom < window.innerHeight - 4) return;
    // a drag on a map, a signature or a photo inside the sheet is that thing's own gesture, never a pull on the sheet
    panel.addEventListener(
      "touchstart",
      (e) => e.target.closest?.(OWN_GESTURE)?.classList.add("no-swipe"),
      { capture: true, passive: true }
    );
    enableSwipeDown(panel, { onClose: () => overlay.isConnected && closeSheet(overlay), isLocked: () => isLocked(overlay) });
  });
}

const isStep = () => history.state && typeof history.state === "object" && history.state.kadSheet !== undefined;
const sheetOpen = () => Boolean(document.querySelector(`body > ${SELECTOR}:not(.sheet-docked)`));

// A safety net for afterSheetStep() below: a page opened some other way (a plain link, an address typed) in the moment between a sheet
// closing and its history step going back would be undone by that step back. Seen here: the screen goes back to the page the sheet was
// on although a newer page had been opened; the newer page is put back (history.forward()) before anything is drawn.
let closedStep = null; // { href, at, overtaken }
function guardClosedStep(e) {
  if (!closedStep || performance.now() - closedStep.at > 1000) {
    closedStep = null;
    return;
  }
  if (!closedStep.overtaken) {
    if (!isStep() && location.href !== closedStep.href) closedStep.overtaken = location.href;
    else if (!isStep()) closedStep = null; // the step went back as it should
    return;
  }
  if (isStep() && location.href === closedStep.href && !sheetOpen()) {
    closedStep = null;
    e.stopImmediatePropagation(); // the router does not draw the page that was left
    history.forward();
  }
}

export function installSheetNavigation() {
  installSheetBack({ selector: SELECTOR, close: closeSheet, isLocked, skip: notASheet });
  window.addEventListener("hashchange", guardClosedStep, true); // before the router's own hashchange listener (app.js)
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1 || !n.matches(SELECTOR)) return;
        addSheetTop(n);
        addSwipe(n);
      });
      // a sheet closed while its step is on top: the kit gives the step back a moment later
      r.removedNodes.forEach((n) => {
        if (n.nodeType === 1 && n.matches(SELECTOR) && !notASheet(n) && isStep()) closedStep = { href: location.href, at: performance.now(), overtaken: null };
      });
    }
  }).observe(document.body, { childList: true });
}

// A sheet closed by its own button just gave its history step back (history.back(), which the browser does a moment later). A page opened
// right after that would be pushed BEFORE that step back happens, and the step back would then undo it. So a navigation made while a closed
// sheet's step is still on top waits for it (at most ~0.4 s; normally one frame).
export function afterSheetStep(go) {
  const pending = () => isStep() && !sheetOpen();
  if (!pending()) {
    go();
    return;
  }
  let tries = 0;
  const wait = () => {
    if (!pending() || ++tries > 25) go();
    else setTimeout(wait, 16);
  };
  setTimeout(wait, 0);
}
