// Approved customer icon system. One canonical set of inner category glyphs
// is reused across every map tier and every non-map surface so oil/shop/
// workshop/other never drift visually between pages.

const COLORS = {
  bronze: "#c96d16",
  silver: "#9f9f9f",
  gold: "#e1ac10",
  potential: "#ff1010",
  competitor: "#2f3033",
  blue: "#06439a",
};

function detectCategoryFromSvg(svg) {
  if (!svg?.matches?.("svg.ui-svg")) return null;
  if (svg.querySelector('rect[x="3.5"][y="11.5"]') || svg.classList.contains("kad-oil-point-icon")) return "oil";
  const paths = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "");
  if (paths.some((d) => d.startsWith("M3 4h2l2.2"))) return "shop";
  if (paths.some((d) => d.startsWith("M14.7 6.3"))) return "workshop";
  if (paths.some((d) => d.startsWith("M20 10c0 5.5"))) return "other";
  return null;
}

function categoryGlyph(category, variant = "standard") {
  if (category === "oil") {
    return `<path d="M50 29C44 39 36 49 36 60c0 9 6 16 14 16s14-7 14-16c0-11-8-21-14-31Z" fill="currentColor"/><path d="M43 57c-2 7 0 12 5 15" fill="none" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>`;
  }
  if (category === "shop") {
    return `<path d="M34 38h6l5 25h24l8-18H46" fill="currentColor"/><rect x="46" y="65" width="24" height="5" rx="2.5" fill="currentColor"/><circle cx="50" cy="77" r="5" fill="currentColor"/><circle cx="67" cy="77" r="5" fill="currentColor"/>`;
  }
  if (category === "workshop") {
    return `<path d="M67 34a13 13 0 0 0-16 16L31 70a5 5 0 1 0 7 7l20-20a13 13 0 0 0 16-16l-8 8-7-2-2-7 10-6Z" fill="currentColor"/><circle cx="35" cy="73" r="2.7" fill="#fff"/>`;
  }
  if (variant === "pin") {
    return `<path d="M50 33c-9 0-16 7-16 16 0 12 16 26 16 26s16-14 16-26c0-9-7-16-16-16Zm0 10a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z" fill="currentColor"/>`;
  }
  return `<circle cx="50" cy="53" r="13" fill="currentColor"/><circle cx="50" cy="53" r="6" fill="#fff"/>`;
}

function tierShell(tier) {
  if (tier === "potential") {
    return `<circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" stroke-width="7"/><path d="M50 6v15M50 79v15M6 50h15M79 50h15" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>`;
  }
  if (tier === "competitor") {
    return `<circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width="7"/>`;
  }
  return `<path d="M50 92 22 64C6 48 9 22 28 10a40 40 0 0 1 44 0c19 12 22 38 6 54L50 92Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/>`;
}

function mapSvg(tier, category) {
  const variant = (tier === "potential" || tier === "competitor") && category === "other" ? "pin" : "standard";
  return `<svg class="customer-reference-svg customer-reference-map-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="color:${COLORS[tier] || COLORS.bronze}">${tierShell(tier)}${categoryGlyph(category, variant)}</svg>`;
}

function blueSvg(category) {
  return `<svg class="customer-reference-svg customer-reference-blue-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="color:${COLORS.blue}"><rect x="10" y="10" width="80" height="80" rx="18" fill="none" stroke="currentColor" stroke-width="7"/>${categoryGlyph(category)}</svg>`;
}

function blueAsset(category) {
  const span = document.createElement("span");
  span.className = `customer-blue-asset cat-${category}`;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = blueSvg(category);
  return span;
}

function mapAsset(tier, category) {
  const span = document.createElement("span");
  span.className = `customer-map-asset cat-${category}`;
  span.dataset.customerTier = tier;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = mapSvg(tier, category);
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
  pin.prepend(mapAsset(tier, category));
}

function processCategorySvg(svg) {
  if (!svg?.isConnected || svg.closest("#leaflet-map .pin")) return;
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
  // Added-node processing only: no global rescans, no Leaflet monkey-patching,
  // and no recurring timers, keeping map interaction smooth on mobile.
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
