// Draws the map pin artwork (client/public/icons/markers/*.svg).
//
//   node scripts/make-pin-art.mjs
//
// Design "B" (owner, 2026-10-25): solid pins, white glyph. Customer = green
// teardrop, potential customer = the original red crosshair (restored 2026-10-26; its art is the PNG set icons/markers/potential-*.png, not drawn here), competitor = grey rounded
// square. The rep colour (Colour by rep) is a ring drawn BEHIND the pin: one
// shape-only file per kind (ring-<kind>.svg) that map.js colours with a CSS
// mask, so there is no per-rep artwork. Visit status badges (amber "!" overdue,
// red "!!" never visited, green tick today) are drawn by CSS, not here.
//
// All files share a 48x48 canvas. Teardrop tip at (24, 43.4) = 90.4% of the
// height (PIN_TIP_RATIO in map.js); the round kinds are centred on (24, 24).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "public", "icons", "markers");

const COLORS = { customer: "#1f9d63", competitor: "#4b5563" };

// Body outlines. Teardrop: tip at (24, 43.4), circle of radius 14 centred (24, 20.8); the tip sits 4.6 above the bottom edge so the rep ring is not cut off there.
const BODY = {
  customer: "M24 43.4 C21 36.4 10 31.4 10 20.8 A14 14 0 0 1 38 20.8 C38 31.4 27 36.4 24 43.4 Z",
    competitor: "M15 11 H33 A4 4 0 0 1 37 15 V33 A4 4 0 0 1 33 37 H15 A4 4 0 0 1 11 33 V15 A4 4 0 0 1 15 11 Z",
};
// Centre of the glyph for each body.
const CENTRE = { customer: [24, 20.8], competitor: [24, 24] };
const GLYPH_SCALE = { customer: 0.96, competitor: 0.86 };
// White outline. The potential customer's crosshair (32 px PNG) is a white-filled circle 25.2 px across with a 1.4 px white edge; our
// customers' pin is drawn at 41 px (map.js PIN_SIZE_BY_KIND), where a 1.6-unit outline is 1.4 px and the head's outer edge 25.2 px
// across -- the same diameter and weight (owner, 2026-10-29).
const OUTLINE = { customer: 1.6, competitor: 2.4 };
// The rep colour ring (Colour by rep): how far it shows beyond the white outline, in canvas units -- 4.5 = about 3.8 px on a 41 px pin
// (owner, 2026-10-29: thicker, so whose customer it is reads at a glance). The crosshair's ring matches it (ring("potential")).
const RING_BAND = 4.5;

// 24x24 glyphs, white, centred on (12, 12).
const GLYPHS = {
  // oil drop
  drop: '<path fill="#fff" d="M12 3.2c3.6 4.5 6.2 7.6 6.2 10.8a6.2 6.2 0 0 1-12.4 0c0-3.2 2.6-6.3 6.2-10.8Z"/>',
  // shopping cart
  shop: '<path fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" d="M3.5 5h2.6l1.7 9.2h9.2l1.9-6.6H7"/><circle cx="9.6" cy="18.4" r="1.6" fill="#fff"/><circle cx="16.6" cy="18.4" r="1.6" fill="#fff"/>',
  // wrench
  workshop: '<path fill="#fff" d="M21.6 17.6 13.5 9.5c.8-2.1.3-4.6-1.4-6.3-1.8-1.8-4.4-2.2-6.5-1.3L9 5.3 6.2 8.1 2.8 4.8C1.8 6.9 2.3 9.5 4 11.2c1.7 1.7 4.2 2.2 6.3 1.4l8.1 8.1c.4.4 1 .4 1.4 0l1.8-1.8c.4-.4.4-1 0-1.3Z"/>',
  // ring: "other" category
  other: '<circle cx="12" cy="12" r="5.2" fill="none" stroke="#fff" stroke-width="3"/>',
};

function art(kind, category) {
  const [cx, cy] = CENTRE[kind];
  const s = GLYPH_SCALE[kind];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<path d="${BODY[kind]}" fill="${COLORS[kind]}" stroke="#fff" stroke-width="${OUTLINE[kind]}" stroke-linejoin="round"/>
<g transform="translate(${cx} ${cy}) scale(${s}) translate(-12 -12)">${GLYPHS[category]}</g>
</svg>
`;
}

// Shape-only ring: the body outline stroked wide enough to show ~3 px beyond the pin's white edge. Alpha is all that matters (CSS mask).
function ring(kind) {
  // The crosshair's white circle is 25.2 px across in its 32 px box; its ring is drawn on a box 0.5 px larger on every side (styles.css
  // .pin-tier-potential .pin-colour-ring), so a full-canvas disc shows about 3.9 px beyond the white edge (the ticks are drawn over it).
  if (kind === "potential") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<circle cx="24" cy="24" r="24" fill="#000"/>
</svg>
`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<path d="${BODY[kind]}" fill="#000" stroke="#000" stroke-width="${2 * RING_BAND + OUTLINE[kind]}" stroke-linejoin="round"/>
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const kind of Object.keys(BODY)) {
  for (const category of Object.keys(GLYPHS)) {
    fs.writeFileSync(path.join(OUT, `${kind}-${category}.svg`), art(kind, category));
  }
}
fs.writeFileSync(path.join(OUT, "ring-customer.svg"), ring("customer"));
fs.writeFileSync(path.join(OUT, "ring-potential.svg"), ring("potential"));
console.log("pin artwork written to", OUT);
