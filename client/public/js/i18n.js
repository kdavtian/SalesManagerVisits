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
  return dict[key] ?? key;
}
