const LANG_KEY = "fieldvisits_lang";

// The texts live in two files, one per language (i18n-en.js, i18n-hy.js), and only the language this device uses is downloaded and parsed
// (together about 440 KB of source: the second one was dead weight on every first launch). index.html's head script (theme-init.js) already
// asks the browser to start fetching the right file before this module even runs, so the import below is normally ready at once.
// Top-level await: no other module sees `t` before the active language is in.
const dicts = {};
const loadDict = async (lang) => {
  if (!dicts[lang]) dicts[lang] = (await (lang === "hy" ? import("./i18n-hy.js") : import("./i18n-en.js"))).default;
};

// Armenian by default -- the sales team's working language -- until a user
// explicitly picks English via the Settings toggle, which stores "en" here
// and wins from then on.
export function getLang() {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "hy";
}

await loadDict(getLang());

// Resolves once the new language's texts are in, so the caller can re-render straight after `await setLang(...)`.
export async function setLang(lang) {
  const next = lang === "hy" ? "hy" : "en";
  await loadDict(next);
  localStorage.setItem(LANG_KEY, next);
}

export function t(key) {
  // The language can be changed from another tab or window (localStorage is shared): until this page has loaded it, use what it has.
  const dict = dicts[getLang()] ?? Object.values(dicts)[0];
  if (dict[key] !== undefined) return dict[key];
  if (typeof key === "string" && /^[a-z][a-z0-9_]*$/.test(key)) refreshOnMiss(key);
  return key;
}

// A text the loaded language file does not have yet (owner, 2026-10-27: the Files sheet showed "add_document", "file_kind_order_blank").
// It happens right after an update: this page still holds the language file it started with, while a screen opened for the first time now
// comes from the new release with its new texts. The current file is fetched once more, past every cache, and the raw names already on
// screen are replaced in place -- no reload, an open sheet stays open.
const missing = new Set();
let refresh = null;
let refreshes = 0;
let lastRefreshAt = 0;
function refreshOnMiss(key) {
  missing.add(key);
  // At most 3 tries a session, 30 s apart: a failed (offline) try is retried later, and a text that is missing in the new file too
  // does not fetch it on every call.
  if (refresh || refreshes >= 3 || Date.now() - lastRefreshAt < 30_000) return;
  refreshes += 1;
  lastRefreshAt = Date.now();
  const lang = getLang();
  refresh = import(`./i18n-${lang}.js?fresh=${Date.now()}`)
    .then((m) => {
      dicts[lang] = { ...dicts[lang], ...m.default };
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
