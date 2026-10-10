// "Products at the shop" chips: what check-ins recorded about the brands on
// a customer's shelf (brand_status: castrol / lotos / royal / competitors),
// shown as chips on the customer card and used by the Customers search and
// filter. Data comes from GET /api/customers/brand-summary:
//   current -- per brand group, the values of the latest visit that recorded
//              that group (a visit that skips a group leaves it unchanged);
//   ever    -- every value any visit recorded + the latest date it was seen.
import { t } from "./i18n.js";
import { escapeHtml, formatDayMonth } from "./util.js";

export const BRAND_GROUP_ORDER = ["castrol", "lotos", "royal", "competitors"];

const COMPETITORS = ["mobil", "motul", "shell", "liquimoly", "bardahl", "aral", "oscar", "zic", "russian_oil"];

// tone -> existing badge class. `alias` holds extra English words a user may
// type (the label itself is always searchable in the current UI language).
const CHIP_DEFS = [
  { group: "castrol", value: "fake", tone: "danger", alias: "fake counterfeit castrol" },
  { group: "castrol", value: "imported_us", tone: "warning", alias: "usa us america american imported castrol" },
  { group: "castrol", value: "imported_dubai", tone: "warning", alias: "dubai uae imported castrol" },
  { group: "castrol", value: "imported_ru", tone: "warning", alias: "russia russian ru imported castrol" },
  { group: "castrol", value: "imported_other", tone: "warning", alias: "imported other castrol" },
  { group: "castrol", value: "available", tone: "success", alias: "castrol available" },
  { group: "castrol", value: "full_range", tone: "success", alias: "castrol full range" },
  { group: "castrol", value: "unavailable", tone: "neutral", alias: "no castrol not available" },
  { group: "lotos", value: "available", tone: "info", alias: "lotos available" },
  { group: "lotos", value: "full_range", tone: "info", alias: "lotos full range" },
  { group: "lotos", value: "unavailable", tone: "neutral", alias: "no lotos not available" },
  { group: "royal", value: "available", tone: "info", alias: "royal available" },
  { group: "royal", value: "full_range", tone: "info", alias: "royal full range" },
  { group: "royal", value: "unavailable", tone: "neutral", alias: "no royal not available" },
  ...COMPETITORS.map((value) => ({ group: "competitors", value, tone: "neutral", alias: `competitor ${value.replace("_", " ")}` })),
];

const DEF_BY_ID = new Map(CHIP_DEFS.map((d) => [chipId(d), d]));

export function chipId(def) {
  return `${def.group}:${def.value}`;
}

export function chipLabel(def) {
  return def.group === "competitors" ? t(`competitor_${def.value}`) : t(`chip_${def.group}_${def.value}`);
}

function fold(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// The chips for a customer's CURRENT state, ordered by group then by the
// CHIP_DEFS order (fake/imported first so a red flag is never hidden).
export function currentChips(current) {
  const chips = [];
  for (const group of BRAND_GROUP_ORDER) {
    const values = current?.[group]?.values;
    if (!Array.isArray(values)) continue;
    const defs = values.map((v) => DEF_BY_ID.get(`${group}:${v}`)).filter(Boolean);
    defs.sort((a, b) => CHIP_DEFS.indexOf(a) - CHIP_DEFS.indexOf(b));
    chips.push(...defs);
  }
  return chips;
}

export function chipHtml(def, suffix = "") {
  return `<span class="badge badge-${def.tone} product-chip">${escapeHtml(chipLabel(def))}${suffix ? ` · ${escapeHtml(suffix)}` : ""}</span>`;
}

// Index the API rows by customer id.
export function indexBrandSummary(rows) {
  return new Map((rows ?? []).map((r) => [r.customer_id, r]));
}

// Everything a customer ever had recorded, as searchable text: the chip's
// label in the current UI language plus its English aliases.
const searchTextCache = new WeakMap();
export function brandSearchText(summary) {
  if (!summary) return "";
  const cached = searchTextCache.get(summary);
  if (cached) return cached;
  const text = fold(
    (summary.ever ?? [])
      .map((e) => DEF_BY_ID.get(`${e.group}:${e.value}`))
      .filter(Boolean)
      .map((d) => `${chipLabel(d)} ${d.alias}`)
      .join(" ")
  );
  searchTextCache.set(summary, text);
  return text;
}

// The "ever" entries that explain why a customer matched: either selected in
// the filter sheet, or whose label/aliases contain a word of the query.
export function matchedEverEntries(summary, { selectedIds, query }) {
  if (!summary) return [];
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const out = [];
  for (const e of summary.ever ?? []) {
    const def = DEF_BY_ID.get(`${e.group}:${e.value}`);
    if (!def) continue;
    const bySelection = selectedIds?.size && selectedIds.has(chipId(def));
    const text = fold(`${chipLabel(def)} ${def.alias}`);
    const byQuery = words.length > 0 && words.some((w) => text.includes(w));
    if (bySelection || byQuery) out.push({ def, last_at: e.last_at });
  }
  out.sort((a, b) => CHIP_DEFS.indexOf(a.def) - CHIP_DEFS.indexOf(b.def));
  return out;
}

// Does this customer have ANY of the selected chips recorded in ANY visit?
export function matchesSelectedChips(summary, selectedIds) {
  if (!selectedIds.size) return true;
  return (summary?.ever ?? []).some((e) => selectedIds.has(`${e.group}:${e.value}`));
}

// Tri-state tree for openTriStateTreeSheet: brand group -> recorded value,
// counted over the customers currently loaded (only values someone has
// actually recorded are offered).
export function buildBrandChipTree(summaryByCustomer, customerIds) {
  const counts = new Map();
  const perGroup = new Map();
  for (const id of customerIds) {
    const summary = summaryByCustomer.get(id);
    if (!summary) continue;
    const seenGroups = new Set();
    for (const e of summary.ever ?? []) {
      const key = `${e.group}:${e.value}`;
      if (!DEF_BY_ID.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      seenGroups.add(e.group);
    }
    for (const g of seenGroups) perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
  }
  return BRAND_GROUP_ORDER.map((group, i) => {
    const leaves = CHIP_DEFS.filter((d) => d.group === group && counts.get(chipId(d)))
      .map((d) => ({ id: chipId(d), name: `${chipLabel(d)} (${counts.get(chipId(d))})` }));
    return {
      key: `b${i}`,
      name: t(`brand_group_${group}`),
      allIds: leaves.map((l) => l.id),
      customerCount: perGroup.get(group) ?? 0,
      leaves,
      children: null,
    };
  }).filter((node) => node.leaves.length);
}

// "3 Oct" -- short, locale-aware date for the "why it matched" line.
export function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDayMonth(d);
}
