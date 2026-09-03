// Replaces the legacy Oil Change Point glyph with the approved single-color
// oil-can + drop design everywhere it is rendered (selectors, customer detail,
// map markers, filters). This is intentionally presentation-only: category
// values, business logic and API payloads stay untouched.

const OIL_POINT_ICON = `<svg class="ui-svg kad-oil-point-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M6.1 10.25h7.35l1.9 1.65 4.55-2.55 1.15 1.55-5.3 4.65v1.85a1.8 1.8 0 0 1-1.8 1.8H6.3a1.8 1.8 0 0 1-1.8-1.8v-5.35a1.8 1.8 0 0 1 1.6-1.8Z"/>
  <path d="M5 11.3 3.2 10.1a1.65 1.65 0 0 0-2.45 1.45v2.55c0 .8.55 1.5 1.33 1.68L4.5 16.3"/>
  <path d="M10.2 10.25V7.8h3.25v2.45M9.75 6.35h4.2v1.45h-4.2z"/>
  <path d="M20.75 13.15c1.18 1.45 1.18 2.7 0 3.75-1.18-1.05-1.18-2.3 0-3.75Z"/>
</svg>`;

function isLegacyOilPointIcon(svg) {
  return Boolean(
    svg?.matches?.("svg.ui-svg") &&
      svg.querySelector('rect[x="3.5"][y="11.5"][width="9.5"][height="6.7"]') &&
      svg.querySelector('rect[x="9.2"][y="6"][width="4.2"]')
  );
}

function replaceIcon(svg) {
  if (!isLegacyOilPointIcon(svg)) return;
  const template = document.createElement("template");
  template.innerHTML = OIL_POINT_ICON.trim();
  svg.replaceWith(template.content.firstElementChild);
}

function scan(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.matches?.("svg.ui-svg")) replaceIcon(root);
  root.querySelectorAll?.("svg.ui-svg").forEach(replaceIcon);
}

function boot() {
  scan(document.documentElement);

  // Observe only newly-added subtrees and inspect those nodes; there is no
  // repeated whole-document scan, so Leaflet marker churn remains cheap.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
