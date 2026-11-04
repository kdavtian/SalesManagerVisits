// KAD kit - the brain of "one search for everything" (owner, 2026-11-04): rank screens, actions and records for what was typed, and keep
// the recently opened ones. The look (bottom sheet on a phone, Ctrl K / "/" box on a computer) is the app's own; this file has no DOM.
//
//   rankItems(query, items, { text, normalize, limit })  -> the best items first
//     items     - [{ kind: "screen" | "action" | "record", id, label, hint?, keywords? , ... }]
//     text      - (item) => string[] to match (default: label, hint, keywords)
//     normalize - (string) => string, e.g. the app's Armenian/Latin key (default: lower case, accents off, spaces squeezed)
//   recentList(storageKey, { max }) -> { all(), add(item), clear() }   (localStorage, per device; never private data, only id/label/hash)
// Scoring: whole text starts with the query > a word starts with it > it is inside > the letters come in order (initials, "nwsl" -> "New sale").
// IDENTICAL in KAD OS and Field Visits (js/kit/).
export function defaultNormalize(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreText(q, t) {
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s\-_/.,()]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length && q.length >= 2 ? 15 : 0;
}

export function rankItems(query, items, { text, normalize = defaultNormalize, limit = 20 } = {}) {
  const q = normalize(query);
  const fields = text || ((it) => [it.label, it.hint, ...(it.keywords || [])]);
  if (!q) return items.slice(0, limit);
  const kindBonus = { action: 3, screen: 2, record: 0 };
  return items
    .map((it, i) => {
      const best = Math.max(0, ...fields(it).filter(Boolean).map((s) => scoreText(q, normalize(s))));
      return { it, i, s: best ? best + (kindBonus[it.kind] ?? 0) : 0 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.it);
}

export function recentList(storageKey, { max = 8 } = {}) {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (v) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      /* storage blocked: the list lasts until the page closes */
    }
  };
  return {
    all: read,
    add(item) {
      if (!item?.id) return;
      const keep = { kind: item.kind, id: item.id, label: item.label, hint: item.hint, hash: item.hash };
      write([keep, ...read().filter((x) => !(x.id === keep.id && x.kind === keep.kind))].slice(0, max));
    },
    clear: () => write([]),
  };
}
