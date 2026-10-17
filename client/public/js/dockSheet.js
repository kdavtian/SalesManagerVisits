// On a wide desktop window an order or task opens as a PANEL docked to the right edge of the window, next to the list,
// instead of a centred dialog on top of it (owner, 2026-10-18: "details beside the list"). The list stays visible and
// clickable: tapping another row swaps the panel. Below the width limit nothing here applies and the sheet is the usual
// dialog / bottom sheet. The look is in desktop.css (.sheet-docked); this only marks the overlay.
const WIDE = "(min-width: 1400px)";

// key: what is shown ("order:12", "task:7") -- lists use it to highlight their open row.
export function dockSheet(overlay, key) {
  if (!window.matchMedia?.(WIDE).matches) return;
  // one panel at a time: opening the next row replaces the previous one
  document.querySelectorAll(".sheet-overlay.sheet-docked").forEach((o) => o !== overlay && o.remove());
  overlay.classList.add("sheet-docked");
  const bar = document.getElementById("top-bar");
  overlay.style.top = `${Math.max(0, Math.round(bar?.getBoundingClientRect().bottom || 0))}px`;
  document.body.dataset.docked = key;
  window.dispatchEvent(new Event("docked-change"));
  const observer = new MutationObserver(() => {
    if (overlay.isConnected) return;
    observer.disconnect();
    // a newer panel may already have taken over
    if (document.querySelector(".sheet-overlay.sheet-docked")) return;
    delete document.body.dataset.docked;
    window.dispatchEvent(new Event("docked-change"));
  });
  observer.observe(document.body, { childList: true });
}

export const dockedKey = () => document.body.dataset.docked || "";
