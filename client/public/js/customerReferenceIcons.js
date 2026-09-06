// Exact approved customer/category artwork adapter.
// This file never draws/reconstructs icons. It only identifies the existing
// semantic category/tier and swaps the legacy glyph for the approved raster asset.

function detectCategoryFromSvg(svg) {
  if (!svg?.matches?.("svg.ui-svg")) return null;
  if (svg.querySelector('rect[x="3.5"][y="11.5"]') || svg.classList.contains("kad-oil-point-icon")) return "oil";
  const paths = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "");
  if (paths.some((d) => d.startsWith("M3 4h2l2.2"))) return "shop";
  if (paths.some((d) => d.startsWith("M14.7 6.3"))) return "workshop";
  if (paths.some((d) => d.startsWith("M20 10c0 5.5"))) return "other";
  return null;
}

function assetSpan(kind, category, tier = "") {
  const span = document.createElement("span");
  span.className = `${kind} cat-${category}`;
  if (tier) span.dataset.customerTier = tier;
  span.setAttribute("aria-hidden", "true");
  return span;
}

function tierFromPin(pin) {
  for (const tier of ["bronze", "silver", "gold", "potential", "competitor"]) {
    if (pin.classList.contains(`pin-tier-${tier}`)) return tier;
  }
  return null;
}

function processMapPin(pin) {
  if (!pin || pin.dataset.referenceArtworkReady === "1") return;
  const tier = tierFromPin(pin);
  if (!tier) return;
  const glyphSvg = pin.querySelector("svg.ui-svg");
  const category = detectCategoryFromSvg(glyphSvg) || "other";

  pin.dataset.referenceArtworkReady = "1";
  pin.classList.add("customer-reference-marker");
  pin.querySelector(".pin-glyph, .pin-glyph-flat")?.remove();
  pin.prepend(assetSpan("customer-map-asset", category, tier));
}

function processCategorySvg(svg) {
  if (!svg?.isConnected || svg.closest("#leaflet-map .pin")) return;
  const category = detectCategoryFromSvg(svg);
  if (!category) return;
  svg.replaceWith(assetSpan("customer-blue-asset", category));
}

function scan(root) {
  if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.matches?.("#leaflet-map .pin")) processMapPin(root);
  root.querySelectorAll?.("#leaflet-map .pin").forEach(processMapPin);
  if (root.matches?.("svg.ui-svg")) processCategorySvg(root);
  root.querySelectorAll?.("svg.ui-svg").forEach(processCategorySvg);
}

function boot() {
  scan(document.documentElement);
  // Added-node processing only. No whole-document rescans, recurring timers,
  // fetch interception, or Leaflet monkey-patching.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
