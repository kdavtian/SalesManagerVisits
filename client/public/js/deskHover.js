// Desktop roadmap step 9: with a mouse, a cut-off text ("…") shows its full text on hover. One passive mouseover listener, no DOM observer
// (an idle screen stays at zero DOM work); the title is written only when the text is really cut and removed when it no longer is.
const fine = typeof matchMedia === "function" ? matchMedia("(hover: hover) and (pointer: fine)") : null;

export function cutOffTitle(start) {
  let el = start instanceof Element ? start : null;
  for (let i = 0; el && i < 3; i++, el = el.parentElement) {
    if (el.hasAttribute("title") && el.dataset.autoTitle !== "1") return null; // the view's own tooltip wins
    if (getComputedStyle(el).textOverflow !== "ellipsis") continue;
    const cut = el.scrollWidth > el.clientWidth + 1;
    const text = el.textContent.trim().replace(/\s+/g, " ");
    if (cut && text) {
      if (el.title !== text) el.title = text;
      el.dataset.autoTitle = "1";
      return el;
    }
    if (el.dataset.autoTitle === "1") {
      el.removeAttribute("title");
      delete el.dataset.autoTitle;
    }
    return null;
  }
  return null;
}

if (fine?.matches && typeof document !== "undefined") {
  document.addEventListener("mouseover", (e) => cutOffTitle(e.target), { passive: true });
}
