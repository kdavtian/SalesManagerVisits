// Armenian places (marzes, Yerevan districts, cities, villages) in a small in-memory gazetteer, used to autocorrect the free text of a
// customer's region / subregion (owner, 2026-10-25). The stored value stays the English name (what the app has always stored, e.g.
// "Yerevan", "Davtashen", "Gyumri"); the app shows the Armenian name when the UI language is Armenian.
// Data: server/src/data/armeniaPlaces.json (GeoNames, CC BY 4.0, plus Wikidata labels); places an admin approves are added from `custom_places`.
import { readFileSync } from "node:fs";
import { pool } from "./db/pool.js";

const DATA = JSON.parse(readFileSync(new URL("./data/armeniaPlaces.json", import.meta.url), "utf8"));

const ARM = {
  ա: "a", բ: "b", գ: "g", դ: "d", ե: "e", զ: "z", է: "e", ը: "e", թ: "t", ժ: "zh", ի: "i", լ: "l", խ: "kh", ծ: "ts", կ: "k", հ: "h", ձ: "dz", ղ: "gh",
  ճ: "ch", մ: "m", յ: "y", ն: "n", շ: "sh", ո: "o", չ: "ch", պ: "p", ջ: "j", ռ: "r", ս: "s", վ: "v", տ: "t", ր: "r", ց: "ts", ւ: "u", փ: "p", ք: "k", օ: "o", ֆ: "f", և: "ev",
};
const CYR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};
// Words that only say what kind of place it is.
const NOISE = /\b(province|marz|region|district|city|village|town|community|oblast|rayon|g|s|gyugh|qaghaq|marzi|hamaynq)\b|մարզ|մարզի|քաղաք|գյուղ|համայնք|վարչական շրջան|область|город|село|район/gi;

// A spelling-independent key: Armenian / Russian / Latin spellings of the same name end up with the same key
// ("Գյումրի", "Gyumri", "Гюмри", "Gumri" -> "gumri"), so a typo-free variant matches exactly.
export function placeKey(text) {
  let s = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(NOISE, " ");
  s = s.replace(/ու/g, "u");
  s = [...s].map((c) => ARM[c] ?? CYR[c] ?? c).join("");
  s = s
    .replace(/[ʻʼ’'`"().,]/g, "")
    .replace(/[^a-z]/g, "")
    .replace(/^ye/, "e")
    .replace(/tch|tsh/g, "ch")
    .replace(/dz|tz/g, "ts")
    .replace(/zh|dj/g, "j")
    .replace(/gh/g, "g")
    .replace(/kh/g, "h")
    .replace(/ph/g, "f")
    .replace(/ou|oo/g, "u")
    .replace(/ee/g, "i")
    .replace(/[wv]/g, "v")
    .replace(/x/g, "h")
    .replace(/q/g, "k")
    .replace(/y/g, "")
    .replace(/(.)\1+/g, "$1");
  return s;
}

function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// entries: { kind: 'region'|'district'|'place', en, hy, region, legacy, custom, keys: [{ key, main }] }
let ENTRIES = [];
let customPlaces = [];

function buildEntries() {
  const list = [];
  const add = (kind, en, hy, region, aliases, extra = {}) => {
    const names = [[en, true], [hy, true], ...(aliases ?? []).map((a) => [a, false])].filter(([n]) => n);
    const keys = [];
    const seen = new Set();
    for (const [n, main] of names) {
      const key = placeKey(n);
      if (key.length < 2 || seen.has(key)) continue;
      seen.add(key);
      keys.push({ key, main });
    }
    list.push({ kind, en, hy: hy || "", region: region || null, keys, ...extra });
  };
  for (const r of DATA.regions) add("region", r.en, r.hy, r.en, r.aliases);
  for (const d of DATA.districts) add("district", d.en, d.hy, "Yerevan", d.aliases);
  for (const p of DATA.places) add("place", p.en, p.hy, p.region, p.aliases, { legacy: !!p.legacy });
  for (const c of customPlaces) add("place", c.name_en, c.name_hy, c.region, [], { custom: true });
  ENTRIES = list;
}
buildEntries();

export async function loadCustomPlaces() {
  try {
    const { rows } = await pool.query("SELECT name_en, name_hy, region FROM custom_places ORDER BY id");
    customPlaces = rows;
    buildEntries();
  } catch (err) {
    // table missing before the migration ran: the built-in list still works
    if (err.code !== "42P01") throw err;
  }
}

export function addCustomPlaceInMemory(place) {
  customPlaces = [...customPlaces, place];
  buildEntries();
}

export function allPlaces() {
  return ENTRIES;
}

function tidy(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // plain Latin all-lower / all-upper text is capitalised word by word; anything else stays as typed
  if (/^[a-z\s'-]+$/.test(s) || (/^[A-Z\s'-]+$/.test(s) && s.length > 3)) return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());
  return s;
}

// Best matches for a typed text. scope: 'region' (marz) | 'sub' (district / city / village, optionally inside a region)
function findMatches(text, { kinds, region }) {
  const key = placeKey(text);
  if (key.length < 2) return { exact: [], near: [] };
  const exact = [];
  const near = [];
  const maxD = key.length >= 9 ? 2 : key.length >= 5 ? 1 : 0;
  for (const e of ENTRIES) {
    if (!kinds.includes(e.kind)) continue;
    if (region && e.region !== region) continue;
    let best = 99;
    let mainHit = false;
    for (const k of e.keys) {
      if (k.key === key) {
        best = 0;
        mainHit = mainHit || k.main;
        break;
      }
      const d = maxD ? distance(key, k.key, maxD) : 99;
      if (d < best) best = d;
    }
    if (best === 0) exact.push({ e, mainHit });
    else if (best <= maxD) near.push({ e, d: best });
  }
  // a name that is an entry's own name beats a name that is only an old/other spelling of another entry
  const mains = exact.filter((x) => x.mainHit);
  return { exact: mains.length ? mains.map((x) => x.e) : exact.map((x) => x.e), near: near.sort((a, b) => a.d - b.d).map((x) => x.e) };
}

const pick = (e) => ({ en: e.en, hy: e.hy, region: e.region, kind: e.kind });

// Resolves a customer's region + subregion text.
// Returns { region, subregion, changed: [{field, from, to, how}], unknown: [{field, typed, suggestions}] }
// how: 'spelling' (a clean match with another spelling / language), 'near' (one letter off, corrected), 'region_from_place' (region filled from the place).
export function resolvePlaces({ region, subregion }) {
  const out = { region: region ?? null, subregion: subregion ?? null, changed: [], unknown: [] };
  const typedRegion = tidy(region);
  const typedSub = tidy(subregion);

  let canonRegion = null;
  if (typedRegion) {
    const m = findMatches(typedRegion, { kinds: ["region"] });
    const hit = m.exact.length === 1 ? m.exact[0] : m.exact.length === 0 && m.near.length === 1 ? m.near[0] : null;
    if (hit) {
      canonRegion = hit.en;
      out.region = hit.en;
      if (hit.en !== String(region).trim()) out.changed.push({ field: "region", from: String(region).trim(), to: hit.en, how: m.exact.length ? "spelling" : "near" });
    } else {
      // a city / village typed into the region field: the region is that place's marz and the place is the subregion
      const asPlace = m.exact.length === 0 ? findMatches(typedRegion, { kinds: ["place"] }) : { exact: [] };
      if (asPlace.exact.length === 1) {
        canonRegion = asPlace.exact[0].region;
        out.region = canonRegion;
        out.changed.push({ field: "region", from: String(region).trim(), to: canonRegion, how: "region_from_place" });
        if (!typedSub) {
          out.subregion = asPlace.exact[0].en;
          out.changed.push({ field: "subregion", from: "", to: asPlace.exact[0].en, how: "region_from_place" });
        }
      } else {
        out.region = typedRegion;
        out.unknown.push({ field: "region", typed: typedRegion, suggestions: m.near.slice(0, 3).map(pick) });
      }
    }
  }

  if (typedSub) {
    const kinds = canonRegion === "Yerevan" ? ["district"] : ["place", "district"];
    let m = findMatches(typedSub, { kinds, region: canonRegion || undefined });
    // nothing inside the chosen region: the place may belong to another region (then the region is wrong, not the place)
    let elsewhere = false;
    if (!m.exact.length && !m.near.length && canonRegion) {
      m = findMatches(typedSub, { kinds: ["place", "district"] });
      elsewhere = m.exact.length === 1;
      if (!elsewhere) m = { exact: [], near: [] };
    }
    const hit = m.exact.length === 1 ? m.exact[0] : m.exact.length === 0 && m.near.length === 1 ? m.near[0] : m.exact.length > 1 ? m.exact[0] : null;
    if (hit && !(elsewhere && canonRegion)) {
      out.subregion = hit.en;
      if (hit.en !== String(subregion).trim()) out.changed.push({ field: "subregion", from: String(subregion).trim(), to: hit.en, how: m.exact.length ? "spelling" : "near" });
      if (!canonRegion && hit.region) {
        out.region = hit.region;
        out.changed.push({ field: "region", from: region ? String(region).trim() : "", to: hit.region, how: "region_from_place" });
      }
    } else if (hit && elsewhere && canonRegion) {
      // keep what the person chose, but flag it: this place is in another marz
      out.subregion = hit.en;
      out.unknown.push({ field: "subregion", typed: typedSub, suggestions: [pick(hit)], reason: "other_region" });
      if (hit.en !== String(subregion).trim()) out.changed.push({ field: "subregion", from: String(subregion).trim(), to: hit.en, how: "spelling" });
    } else {
      out.subregion = typedSub;
      out.unknown.push({ field: "subregion", typed: typedSub, suggestions: m.near.slice(0, 3).map(pick) });
    }
  }
  return out;
}

// Autocomplete: places whose name (or another spelling) starts with / contains the typed text.
export function searchPlaces(q, { region, limit = 12 } = {}) {
  const key = placeKey(q);
  const raw = String(q ?? "").trim().toLowerCase();
  if (key.length < 1 && !raw) return [];
  const scored = [];
  for (const e of ENTRIES) {
    if (e.kind === "region" || e.legacy) continue;
    if (region && e.region !== region) continue;
    let score = 99;
    for (const k of e.keys) {
      if (k.key === key) score = Math.min(score, k.main ? 0 : 2);
      else if (key && k.key.startsWith(key)) score = Math.min(score, k.main ? 1 : 3);
      else if (key && k.main && k.key.includes(key)) score = Math.min(score, 4);
    }
    if (raw && (e.en.toLowerCase().startsWith(raw) || e.hy.toLowerCase().startsWith(raw))) score = Math.min(score, 0.5);
    if (score < 99) scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.en.localeCompare(b.e.en));
  const good = scored.filter((x) => x.score < 3);
  return (good.length ? good : scored).slice(0, limit).map((x) => pick(x.e));
}
