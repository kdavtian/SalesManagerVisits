import { firstTextAreas } from "./i18nAreas.js";

// Styles per area (docs/architecture-roadmap.md step 8c). css/app.css holds what the shell, login, Home and every shared part need; the
// rules only some screens use live in css/areas/<area>.css (split by server/scripts/split-css.mjs). A screen loads its areas -- the
// same lists as its texts, i18nAreas.js -- before it is drawn (shell/routes.js); the others follow in the background after the first
// screen. The <link>s always stand in this order right after css/app.css, whatever order they load in, so the cascade never depends on
// which screen was opened first.
export const STYLE_AREAS = ["customers", "orders", "field", "money", "products", "reports", "team"];

const requested = new Map(); // area -> promise, settled once the stylesheet has loaded (or failed)
const loaded = new Set();

function loadArea(area) {
  if (requested.has(area)) return requested.get(area);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/css/areas/${area}.css`;
  link.dataset.styleArea = area;
  // a failed download (offline without a stored copy) must not hold the screen back: it is drawn with the shared styles
  const done = new Promise((resolve) => {
    const finish = () => {
      loaded.add(area);
      resolve();
    };
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
  });
  // keep the fixed order: before the first area link that comes later in STYLE_AREAS, else after the last one (or after css/app.css)
  const rank = STYLE_AREAS.indexOf(area);
  const areaLinks = [...document.querySelectorAll("link[data-style-area]")];
  const next = areaLinks.find((l) => STYLE_AREAS.indexOf(l.dataset.styleArea) > rank);
  const anchor = areaLinks.at(-1) ?? document.querySelector('link[href$="css/app.css"]');
  if (next) next.before(link);
  else if (anchor) anchor.after(link);
  else document.head.append(link);
  requested.set(area, done);
  return done;
}

const areasFor = (hash) => firstTextAreas(hash).filter((area) => STYLE_AREAS.includes(area));

// Every style area the screen at `hash` needs has arrived (an address not listed in i18nAreas.js needs all of them).
export const stylesReadyFor = (hash) => areasFor(hash).every((area) => loaded.has(area));

export function loadStylesFor(hash) {
  return Promise.all(areasFor(hash).map(loadArea));
}

export function loadAllStyles() {
  return Promise.all(STYLE_AREAS.map(loadArea));
}

// The other areas, once the first screen has had its turn (a sheet of another area opened later finds its styles in place).
if (typeof window !== "undefined") {
  const later = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 }) : (fn) => setTimeout(fn, 1200);
  later(() => loadAllStyles());
}
