import { TEXT_AREAS, firstTextAreas } from "./i18nAreas.js";

const LANG_KEY = "fieldvisits_lang";

// The texts live in i18n/<lang>/<area>.js, one file per area of the app (step 8b), and only the language this device uses is loaded.
// Texts in two parts (docs/architecture-roadmap.md step 11): before the first screen only `common` (shell, login, Home, errors, texts
// several areas use) and the areas the screen being opened needs (i18nAreas.js) are loaded -- for Home in Armenian about 36 KB instead of
// 73 KB compressed (common + orders, the warehouse manager's Home) -- and the other areas follow right after, in the background. index.html's head script (theme-init.js) already starts
// fetching `common` before this module runs. Top-level await: no other module sees `t` before the first part is in.
const dicts = {}; // lang -> the texts of the areas loaded so far
const loaded = {}; // lang -> Set of loaded areas
async function loadAreas(lang, areas) {
  const have = (loaded[lang] ||= new Set());
  await Promise.all(
    areas
      .filter((area) => !have.has(area))
      .map((area) =>
        import(`./i18n/${lang}/${area}.js`).then((m) => {
          dicts[lang] = Object.assign(dicts[lang] ?? {}, ...Object.values(m));
          have.add(area);
        })
      )
  );
}
const allLoaded = (lang) => TEXT_AREAS.every((area) => loaded[lang]?.has(area));
// Which areas this page has loaded so far (the tests check the first part is in before a screen is drawn).
export const loadedTextAreas = (lang = getLang()) => [...(loaded[lang] ?? [])];

// Armenian by default -- the sales team's working language -- until a user
// explicitly picks English via the Settings toggle, which stores "en" here
// and wins from then on.
export function getLang() {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "hy";
}

await loadAreas(getLang(), typeof location === "undefined" ? TEXT_AREAS : firstTextAreas(location.hash));

// The other areas, once the first screen has had its turn. A text needed before they arrive loads them at once (see t below).
let loadingRest = null;
export function loadAllTexts(lang = getLang()) {
  if (allLoaded(lang)) return Promise.resolve();
  loadingRest ||= loadAreas(lang, TEXT_AREAS).finally(() => (loadingRest = null));
  return loadingRest;
}
if (typeof window !== "undefined") {
  const later = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 }) : (fn) => setTimeout(fn, 1200);
  later(() => loadAllTexts().catch(() => {}));
}

// Resolves once the new language's texts are in, so the caller can re-render straight after `await setLang(...)`.
export async function setLang(lang) {
  const next = lang === "hy" ? "hy" : "en";
  await loadAreas(next, TEXT_AREAS);
  localStorage.setItem(LANG_KEY, next);
}

export function t(key) {
  // The language can be changed from another tab or window (localStorage is shared): until this page has loaded it, use what it has.
  const dict = dicts[getLang()] ?? Object.values(dicts)[0];
  if (dict[key] !== undefined) return dict[key];
  if (typeof key === "string" && /^[a-z][a-zA-Z0-9_]*$/.test(key)) needText(key);
  return key;
}

// A text that is not in the loaded texts: first the areas not loaded yet (a sheet of another area opened before the background load
// finished), then -- when every area is in and it is still missing -- a fresh fetch (below). Either way the raw name already on screen is
// replaced in place once the text arrives: no reload, an open sheet stays open.
const missing = new Set();
function needText(key) {
  missing.add(key);
  const lang = getLang();
  if (!allLoaded(lang)) {
    loadAllTexts(lang)
      .then(() => replaceOnScreen(dicts[lang]))
      .catch(() => {});
    return;
  }
  refreshOnMiss(lang);
}

// Still missing with every area loaded (owner, 2026-10-27: the Files sheet showed "add_document", "file_kind_order_blank"): right after an
// update this page still holds the texts it started with, while a screen opened for the first time now comes from the new release with
// its new texts. The area files are fetched once more, past every cache: the joining file for the current list of areas, then each area
// file (a module already loaded is not fetched again by its own address).
let refresh = null;
let refreshes = 0;
let lastRefreshAt = 0;
function refreshOnMiss(lang) {
  // At most 3 tries a session, 30 s apart: a failed (offline) try is retried later, and a text that is missing in the new file too
  // does not fetch it on every call.
  if (refresh || refreshes >= 3 || Date.now() - lastRefreshAt < 30_000) return;
  refreshes += 1;
  lastRefreshAt = Date.now();
  const fresh = `?fresh=${Date.now()}`;
  refresh = import(`./i18n-${lang}.js${fresh}`)
    .then((index) => Promise.all((index.AREAS ?? TEXT_AREAS).map((area) => import(`./i18n/${lang}/${area}.js${fresh}`))))
    .then((areas) => {
      dicts[lang] = Object.assign({ ...dicts[lang] }, ...areas.flatMap((m) => Object.values(m)));
      replaceOnScreen(dicts[lang]);
    })
    .catch(() => {})
    .finally(() => (refresh = null));
}
function replaceOnScreen(dict) {
  // Only names with an underscore ("add_document"): a plain word could be part of a customer's name or a note.
  const keys = [...missing].filter((k) => dict[k] !== undefined && k.includes("_"));
  if (!keys.length || typeof document === "undefined") return;
  // whole names only ("add_document", never a part of a longer word)
  const swap = (text) => keys.reduce((s, k) => (s.includes(k) ? s.replace(new RegExp(`(?<![\\w])${k}(?![\\w])`, "g"), () => dict[k]) : s), text);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const next = swap(n.nodeValue);
    if (next !== n.nodeValue) n.nodeValue = next;
  }
  for (const attr of ["aria-label", "placeholder", "title"]) {
    document.querySelectorAll(`[${attr}]`).forEach((el) => {
      const v = el.getAttribute(attr);
      const next = swap(v);
      if (next !== v) el.setAttribute(attr, next);
    });
  }
  [...missing].filter((k) => dict[k] !== undefined).forEach((k) => missing.delete(k));
}
