// Search that works in both scripts (owner, 2026-10-29: "jrvej = ջրվեժ; արտակ = artak; kastrol = կաստրոլ = castrol = qastrol").
// Every text and every query is turned into one sound key: Armenian letters are written in Latin, and the Latin spellings that sound
// the same fold together (c/q/k -> k, zh/j -> j, ye -> e, ou -> u ...). A word of 5 letters or more also finds a text with one letter
// typed wrong, missing or extra. The same file runs in the browser and on the server (server/src/shared/searchKey.js re-exports it).
//
// Kinds of match, best first: 3 the typed text as it is, 2 the same sound in the other script, 1 one letter off. 0: no match.

const ARMENIAN = {
  ա: "a", բ: "b", գ: "g", դ: "d", ե: "e", զ: "z", է: "e", ը: "e", թ: "t", ժ: "j", ի: "i", լ: "l", խ: "x", ծ: "ts", կ: "k",
  հ: "h", ձ: "dz", ղ: "g", ճ: "ch", մ: "m", յ: "y", ն: "n", շ: "sh", ո: "o", չ: "ch", պ: "p", ջ: "j", ռ: "r", ս: "s", վ: "v",
  տ: "t", ր: "r", ց: "ts", ւ: "v", փ: "p", ք: "k", և: "ev", օ: "o", ֆ: "f",
};

// Latin spellings of one sound -> one letter. Order matters: longer spellings first.
const LATIN_FOLDS = [
  [/ու/g, "u"], // before the letter-by-letter pass
];
const LATIN_AFTER = [
  [/sh/g, "§"], // the sh sound, kept apart from s
  [/ch/g, "¢"],
  [/zh/g, "j"],
  [/dj/g, "j"],
  [/kh/g, "x"],
  [/gh/g, "g"],
  [/ck/g, "k"],
  [/ph/g, "f"],
  [/w/g, "v"],
  [/ou|oo/g, "u"],
  [/(^|[^a-z§¢])ye/g, "$1e"], // Yerevan = Երևան
  [/c(?![eiy])/g, "k"], // castrol = kastrol; c before e/i/y stays "c" (the ts sound)
  [/tz|ts/g, "c"], // after the line above: ծ / ց / ts / tz are one sound
  [/q/g, "k"],
  [/y(?=[^aeiou]|$)/g, "i"], // a vowel y
  [/(.)\1+/g, "$1"], // doubled letters
];

export function foldText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const keyCache = new Map();
export function soundKey(value) {
  const folded = foldText(value);
  const hit = keyCache.get(folded);
  if (hit !== undefined) return hit;
  let s = folded;
  for (const [re, to] of LATIN_FOLDS) s = s.replace(re, to);
  s = s.replace(/[Ա-և]/g, (ch) => ARMENIAN[ch] ?? ch);
  for (const [re, to] of LATIN_AFTER) s = s.replace(re, to);
  if (keyCache.size > 20000) keyCache.clear();
  keyCache.set(folded, s);
  return s;
}

// At most one letter different (changed, missing or extra) between a and b.
function withinOne(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// The query word, one letter off, as the start of a word of the text (a search finds "Castrol Point" from "kastro").
function typoIn(word, textWords) {
  for (const w of textWords) {
    for (const len of [word.length - 1, word.length, word.length + 1]) {
      if (len > 0 && len <= w.length && withinOne(word, w.slice(0, len))) return true;
    }
  }
  return false;
}

export const TYPO_MIN_LETTERS = 5;

// A searchable text prepared once (keep it with the row): the plain folded text, its sound key and the key's words.
export function prepareSearchText(value) {
  const plain = foldText(value);
  const key = soundKey(plain);
  return { plain, key, words: key.split(/[^a-z0-9§¢]+/).filter(Boolean) };
}

// How well `query` matches a prepared text: every word of the query must match; the result is the weakest word's kind.
export function matchKind(prepared, query) {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 3;
  let kind = 3;
  for (const w of words) {
    if (prepared.plain.includes(w)) continue;
    const k = soundKey(w);
    if (k && prepared.key.includes(k)) {
      kind = Math.min(kind, 2);
      continue;
    }
    if (k.length >= TYPO_MIN_LETTERS && typoIn(k, prepared.words)) {
      kind = 1;
      continue;
    }
    return 0;
  }
  return kind;
}

// One text against a query (a search box over a short list): true when it matches in any of the three ways.
export const textMatches = (text, query) => matchKind(prepareSearchText(text), query) > 0;
