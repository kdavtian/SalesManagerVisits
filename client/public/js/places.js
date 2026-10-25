// Armenian places on the client (owner, 2026-10-25): shows a stored place name in the language of the app, suggests names while typing, and says in one
// line what the server did with the typed text. The spelling autocorrect itself is on the server (server/src/places.js).
import { PLACE_DATA, PLACE_REGIONS } from "./placesData.js";
import { getLang, t } from "./i18n.js";

const ARMENIAN = /[Ա-֏]/;
let byEn = null;
let byHy = null;

function index() {
  if (byEn) return;
  byEn = new Map();
  byHy = new Map();
  for (const [en, hy] of PLACE_DATA) {
    const k = en.toLowerCase();
    if (hy && !byEn.has(k)) byEn.set(k, hy);
    if (hy && !byHy.has(hy.toLowerCase())) byHy.set(hy.toLowerCase(), en);
  }
}

export function hasArmenianScript(text) {
  return ARMENIAN.test(String(text ?? ""));
}

// A stored place name (English) in the app's language; a name typed in Armenian script shows in English when the app is in English.
export function placeLabel(value) {
  if (!value) return value;
  index();
  if (getLang() === "hy") return byEn.get(String(value).toLowerCase()) || value;
  return hasArmenianScript(value) ? byHy.get(String(value).toLowerCase()) || value : value;
}

// Suggestions while typing: [{ value (what goes into the field), label (the other language) }]
export function placeSuggestions(query, region) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const regionIdx = region ? PLACE_REGIONS.indexOf(region) : -1;
  const hy = getLang() === "hy";
  const starts = [];
  const contains = [];
  for (const [en, nameHy, r] of PLACE_DATA) {
    if (regionIdx >= 0 && r !== regionIdx) continue;
    const a = en.toLowerCase();
    const b = (nameHy || "").toLowerCase();
    const item = { value: hy && nameHy ? nameHy : en, label: hy ? en : nameHy };
    if (a.startsWith(q) || b.startsWith(q)) starts.push(item);
    else if (a.includes(q) || b.includes(q)) contains.push(item);
    if (starts.length >= 12) break;
  }
  return [...starts, ...contains].slice(0, 12);
}

// A text field with the places as suggestions (native <datalist>: works on iPhone and Android and needs no extra layer).
export function wirePlaceInput(input, getRegion) {
  if (!input || input.tagName !== "INPUT" || input.dataset.placesWired) return;
  input.dataset.placesWired = "1";
  const list = document.createElement("datalist");
  list.id = `${input.id || "place"}-list`;
  input.setAttribute("list", list.id);
  input.setAttribute("autocomplete", "off");
  input.after(list);
  const fill = () => {
    const html = placeSuggestions(input.value, getRegion?.())
      .map((s) => `<option value="${s.value.replace(/"/g, "&quot;")}"${s.label ? ` label="${s.label.replace(/"/g, "&quot;")}"` : ""}></option>`)
      .join("");
    if (list.innerHTML !== html) list.innerHTML = html;
  };
  input.addEventListener("input", fill);
  input.addEventListener("focus", fill);
}

// One line for the toast after a save: what was corrected, and what could not be placed.
export function placeNoticeText(notice) {
  if (!notice) return "";
  const lines = [];
  const fixed = (notice.changed ?? []).filter((c) => c.how === "spelling" || c.how === "near");
  const subFix = fixed.find((c) => c.field === "subregion");
  const regionFix = fixed.find((c) => c.field === "region");
  if (subFix || regionFix) {
    const parts = [subFix ? placeLabel(subFix.to) : null, regionFix ? placeLabel(regionFix.to) : null].filter(Boolean);
    lines.push(t("place_saved_as").replace("{value}", parts.join(", ")));
  }
  for (const u of notice.unknown ?? []) {
    const hit = u.suggestions?.[0];
    lines.push(
      u.reason === "other_region" && hit
        ? t("place_other_region").replace("{typed}", u.typed).replace("{region}", placeLabel(hit.region))
        : t("place_not_in_list").replace("{typed}", u.typed)
    );
  }
  return lines.join(" ");
}
