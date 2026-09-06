// Applies the approved customer-category artwork everywhere without changing
// customer/category/tier data or Leaflet business logic. The source artwork
// lives in customer-reference-icons.css as transparent 2x2 sprites.

function detectCategoryFromSvg(svg) {
  if (!svg?.matches?.("svg.ui-svg")) return null;
  if (svg.querySelector('rect[x="3.5"][y="11.5"]') || svg.classList.contains("kad-oil-point-icon")) return "oil";
  const paths = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "");
  if (paths.some((d) => d.startsWith("M3 4h2l2.2"))) return "shop";
  if (paths.some((d) => d.startsWith("M14.7 6.3"))) return "workshop";
  if (paths.some((d) => d.startsWith("M20 10c0 5.5"))) return "other";
  return null;
}

function blueAsset(category) {
  const span = document.createElement("span");
  span.className = `customer-blue-asset cat-${category}`;
  span.setAttribute("aria-hidden", "true");
  return span;
}

function mapAsset(tier, category) {
  const span = document.createElement("span");
  span.className = `customer-map-asset cat-${category}`;
  span.dataset.customerTier = tier;
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
  const check = pin.querySelector(".pin-check");

  pin.dataset.referenceArtworkReady = "1";
  pin.classList.add("customer-reference-marker");
  pin.querySelector(".pin-glyph, .pin-glyph-flat")?.remove();
  pin.prepend(mapAsset(tier, category));
  // pin-check stays untouched so visited-today remains visible and functional.
  if (check && check.parentElement !== pin) pin.appendChild(check);
}

function processCategorySvg(svg) {
  if (!svg?.isConnected) return;
  // Map markers are handled as a complete approved marker, not as a blue glyph.
  if (svg.closest("#leaflet-map .pin")) return;
  const category = detectCategoryFromSvg(svg);
  if (!category) return;
  svg.replaceWith(blueAsset(category));
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
  // Process only newly-added subtrees. No full-document rescans and no Leaflet
  // monkey-patching, avoiding the freeze pattern seen in earlier map changes.
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
