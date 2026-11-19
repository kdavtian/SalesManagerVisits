// Check-in > Competitors (owner, 2026-11-19): one row per brand with three outline icon buttons on the right -- bottles on the shelf
// (a golden 1 L bottle), a drum (green, bulk oil) and "not available". Bottles and drum are separate (a shop can sell only one of them,
// or both); "not available" clears them both. Nothing picked = all three faded; picked = full colour, filled, outlined.
// "+ Add new brand": usable at once by this rep, approved by admin / CEO before every rep sees it (server field/competitorBrands.js).
import { api } from "./api.js";
import { t, hasText, getLang } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, showToast, groupDigits, formatDateDMY } from "./util.js";
import { COMPETITORS, brandNameOfKey } from "./brandChips.js";

const BOTTLE = `<svg viewBox="0 0 24 24" class="cs-svg" aria-hidden="true" focusable="false"><path class="cs-fill" d="M10 2.5h4v2.2h-4z"/><path class="cs-fill" d="M9.6 4.7h4.8l.4 1.9c1.6.4 2.4 1.5 2.4 3V20a2 2 0 0 1-2 2H8.8a2 2 0 0 1-2-2V9.6c0-1.5.8-2.6 2.4-3z"/><path class="cs-label" d="M8.6 12.2h6.8v4.6H8.6z"/></svg>`;
const DRUM = `<svg viewBox="0 0 24 24" class="cs-svg" aria-hidden="true" focusable="false"><path class="cs-fill" d="M5 5.5C5 4.1 8.1 3 12 3s7 1.1 7 2.5v13c0 1.4-3.1 2.5-7 2.5s-7-1.1-7-2.5z"/><path class="cs-line" d="M5 5.5C5 6.9 8.1 8 12 8s7-1.1 7-2.5M5 10.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5M5 15.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>`;
const NONE = `<svg viewBox="0 0 24 24" class="cs-svg" aria-hidden="true" focusable="false"><circle class="cs-fill" cx="12" cy="12" r="8.5"/><path class="cs-line" d="M6 18 18 6"/></svg>`;
const BUTTONS = [
  ["bottle", BOTTLE, "cs_bottle"],
  ["drum", DRUM, "cs_drum"],
  ["none", NONE, "cs_none"],
];

const labelOf = (b) => (hasText(`competitor_${b.key}`) ? t(`competitor_${b.key}`) : b.name || brandNameOfKey(b.key));

// the list: the server's (approved + this rep's waiting ones); without signal, the built-in list (and whatever was marked before)
// Cache first (review, 2026-11-19): the sheet opens at once from the last list and reads it again in the background; the first time it
// waits at most 3 s, then opens with the built-in list.
let cached = null;
const builtIn = () => COMPETITORS.map((key) => ({ key, name: "", status: "approved" }));
function refresh() {
  return api.getCompetitorBrands().then((r) => (cached = r.brands));
}
async function loadBrands() {
  if (cached) {
    refresh().catch(() => {});
    return cached;
  }
  try {
    return await Promise.race([refresh(), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 3000))]);
  } catch {
    return builtIn();
  }
}

// packs: { [brandKey]: ["bottle"] | ["drum"] | ["bottle","drum"] | ["none"] } -- edited in place; onApply() after the sheet closes.
// linePacks: { [brandKey]: { [lineCode]: packs } } and prices: Map "brand|line|volume" -> { brand, line, volume, wholesale, retail }
// (owner, 2026-11-19: tap a brand -> its product lines with the same three icons; tap a line -> wholesale / retail per volume).
export async function openCompetitorSheet({ title, packs, linePacks = Object.create(null), prices = new Map(), onApply }) {
  const brands = [...(await loadBrands())];
  for (const key of Object.keys(packs)) if (!brands.some((b) => b.key === key)) brands.push({ key, name: "", status: "approved" });
  // a Map: a brand key can be any word, and a plain object answers some words by itself (review, 2026-11-19)
  const draft = new Map(Object.entries(packs).map(([k, v]) => [k, new Set(v)]));
  const draftLines = new Map(Object.entries(linePacks).map(([k, lines]) => [k, new Map(Object.entries(lines).map(([c, v]) => [c, new Set(v)]))]));
  const draftPrices = new Map([...prices].map(([k, v]) => [k, { ...v }]));
  const brandFacts = (key) => {
    const lines = [...(draftLines.get(key)?.values() ?? [])].filter((s) => s.size).length;
    const priced = [...draftPrices.values()].filter((r) => r.brand === key).length;
    return [lines ? t("cs_lines_n").replace("{n}", lines) : "", priced ? t("cs_prices_n").replace("{n}", priced) : ""].filter(Boolean).join(" · ");
  };

  const rowHtml = (b) => {
    const on = draft.get(b.key) ?? new Set();
    const facts = brandFacts(b.key);
    return `<div class="cs-row" data-key="${escapeHtml(b.key)}">
      <button type="button" class="cs-name cs-name-btn" data-open-lines aria-label="${escapeHtml(`${labelOf(b)}: ${t("cs_open_lines")}`)}">${escapeHtml(labelOf(b))}${b.status === "pending" ? `<small class="cs-pending">${escapeHtml(t("cs_pending"))}</small>` : ""}${facts ? `<small class="cs-facts">${escapeHtml(facts)}</small>` : ""}</button>
      <span class="cs-btns">${BUTTONS.map(
        ([v, svg, label]) =>
          `<button type="button" class="cs-btn cs-${v}${on.has(v) ? " is-on" : ""}" data-v="${v}" aria-pressed="${on.has(v)}" aria-label="${escapeHtml(`${labelOf(b)}: ${t(label)}`)}" title="${escapeHtml(t(label))}">${svg}</button>`
      ).join("")}</span>
    </div>`;
  };

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet brand-sheet cs-sheet">
      <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
      <h2>${escapeHtml(title)}</h2>
      <div class="cs-legend muted" aria-hidden="true">
        <span>${BOTTLE} ${escapeHtml(t("cs_bottle"))}</span><span>${DRUM} ${escapeHtml(t("cs_drum"))}</span><span>${NONE} ${escapeHtml(t("cs_none"))}</span>
      </div>
      <div class="cs-list">${brands.map(rowHtml).join("")}</div>
      <div class="cs-add">
        <button type="button" class="btn btn-secondary cs-add-open" id="cs-add-open">+ ${escapeHtml(t("cs_add"))}</button>
        <form class="cs-add-form" id="cs-add-form" hidden>
          <input type="text" id="cs-add-name" maxlength="40" autocomplete="off" placeholder="${escapeHtml(t("cs_add_placeholder"))}" aria-label="${escapeHtml(t("cs_add_placeholder"))}" />
          <button type="submit" class="btn btn-primary" id="cs-add-send">${escapeHtml(t("cs_add_send"))}</button>
        </form>
        <p class="form-error" id="cs-add-error" hidden></p>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-primary btn-block" id="cs-done">${t("done")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let onEsc = () => overlay.remove();
  activateDialog(overlay, { onEscape: () => onEsc() });
  const list = overlay.querySelector(".cs-list");

  const paintRow = (key) => {
    const row = list.querySelector(`.cs-row[data-key="${CSS.escape(key)}"]`);
    const b = brands.find((x) => x.key === key);
    if (row && b) row.outerHTML = rowHtml(b);
  };
  // tap: bottle / drum toggle on their own and clear "not available"; "not available" clears both; a second tap clears it
  list.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-lines]");
    if (open) {
      const key = open.closest(".cs-row").dataset.key;
      const b = brands.find((x) => x.key === key);
      openLinesSheet(b, { draftLines, draftPrices }).then(() => {
        // a line with bottles / a drum puts the same on its brand (a brand is present when one of its lines is)
        const lineSets = [...(draftLines.get(key)?.values() ?? [])];
        const on = new Set(lineSets.flatMap((s) => [...s]).filter((v) => v !== "none"));
        if (on.size) {
          const set = draft.get(key) ?? new Set();
          set.delete("none");
          on.forEach((v) => set.add(v));
          draft.set(key, set);
        }
        paintRow(key);
      });
      return;
    }
    const btn = e.target.closest(".cs-btn");
    if (!btn) return;
    const key = btn.closest(".cs-row").dataset.key;
    if (!draft.has(key)) draft.set(key, new Set());
    const set = draft.get(key);
    const v = btn.dataset.v;
    if (set.has(v)) set.delete(v);
    else if (v === "none") {
      set.clear();
      set.add("none");
    } else {
      set.delete("none");
      set.add(v);
    }
    if (!set.size) draft.delete(key);
    btn.closest(".cs-row").querySelectorAll(".cs-btn").forEach((b) => {
      const on = Boolean(draft.get(key)?.has(b.dataset.v));
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  });

  // + Add new brand (needs signal: the server checks the name and asks admin / CEO)
  const form = overlay.querySelector("#cs-add-form");
  const nameInput = overlay.querySelector("#cs-add-name");
  const err = overlay.querySelector("#cs-add-error");
  overlay.querySelector("#cs-add-open").addEventListener("click", (e) => {
    e.currentTarget.hidden = true;
    form.hidden = false;
    nameInput.focus();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    err.hidden = true;
    if (name.length < 2) {
      err.textContent = t("cs_add_short");
      err.hidden = false;
      return;
    }
    const send = overlay.querySelector("#cs-add-send");
    send.disabled = true;
    try {
      const { brand, created } = await api.addCompetitorBrand(name);
      refresh().catch(() => {}); // the next sheet has it
      let row = list.querySelector(`.cs-row[data-key="${CSS.escape(brand.key)}"]`);
      if (!row) {
        brands.push(brand);
        list.insertAdjacentHTML("beforeend", rowHtml(brand));
        row = list.lastElementChild;
      }
      row.scrollIntoView({ block: "nearest" });
      row.classList.add("cs-row-new");
      showToast(t(created ? "cs_add_sent" : "cs_add_exists"));
      nameInput.value = "";
    } catch (e2) {
      err.textContent = e2 instanceof TypeError ? t("cs_add_offline") : e2.message;
      err.hidden = false;
    }
    send.disabled = false;
  });

  // every way out keeps what was marked (as the other brand sheet)
  const apply = () => {
    for (const k of Object.keys(packs)) delete packs[k];
    for (const [k, set] of draft) if (set.size) packs[k] = [...set];
    for (const k of Object.keys(linePacks)) delete linePacks[k];
    for (const [k, lines] of draftLines) {
      const brandNone = draft.get(k)?.has("none");
      // a brand marked "not available" keeps only its lines marked "not available" (never "not available" and present at once)
      const marked = [...lines].filter(([, s]) => s.size && (!brandNone || s.has("none")));
      if (marked.length) linePacks[k] = Object.fromEntries(marked.map(([c, s]) => [c, [...s]]));
    }
    prices.clear();
    for (const [k, v] of draftPrices) prices.set(k, v);
    overlay.remove();
    onApply?.();
  };
  onEsc = apply;
  overlay.addEventListener("click", (e) => e.target === overlay && apply());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", apply);
  overlay.querySelector("#cs-done").addEventListener("click", apply);
}

// ---- a brand's product lines (the Potential lines, grouped) ----------------------------------------------------------------------------
const GROUP_ORDER = ["pcmo", "hdeo", "transmission", "ev", "coolant", "brake", "grease", "other"];
let linesCache = null;
async function loadLines() {
  if (!linesCache) linesCache = (await api.getPotentialLines()).lines;
  return linesCache;
}
const lineName = (l) => (getLang() === "hy" ? l.name_hy : l.name_en);
// under its group heading an engine-oil line is just its grade ("5W-30"): the group already says "passenger car engine oil"
const shortLineName = (l) => {
  const m = /^(pcmo|hdeo)_(\d{1,2})w(\d{1,3})$/.exec(l.code ?? "");
  return m ? `${m[2]}W-${m[3]}` : lineName(l);
};
const lastCache = new Map(); // brand -> latest prices by anyone (GET /competitor-brands/:key/prices)
async function loadLast(brand) {
  if (!lastCache.has(brand)) lastCache.set(brand, api.getCompetitorPrices(brand).then((r) => r.prices).catch(() => ({})));
  // the sheet opens after at most 2 s (weak signal): the hints are a help, not a reason to wait
  return Promise.race([lastCache.get(brand), new Promise((ok) => setTimeout(() => ok({}), 2000))]);
}

function openLinesSheet(brand, { draftLines, draftPrices }) {
  return new Promise(async (resolve) => {
    let lines;
    try {
      lines = await loadLines();
    } catch {
      showToast(t("cs_lines_offline"));
      resolve();
      return;
    }
    if (!draftLines.has(brand.key)) draftLines.set(brand.key, new Map());
    const marks = draftLines.get(brand.key);
    const priced = (code) => [...draftPrices.values()].filter((r) => r.brand === brand.key && r.line === code).length;
    const rowHtml = (l) => {
      const on = marks.get(l.code) ?? new Set();
      const n = priced(l.code);
      return `<div class="cs-row" data-line="${escapeHtml(l.code)}">
        <button type="button" class="cs-name cs-name-btn" data-open-prices>${escapeHtml(shortLineName(l))}<small class="cs-facts">${n ? escapeHtml(t("cs_prices_n").replace("{n}", n)) : escapeHtml(t("cs_add_prices"))}</small></button>
        <span class="cs-btns">${BUTTONS.map(
          ([v, svg, label]) =>
            `<button type="button" class="cs-btn cs-${v}${on.has(v) ? " is-on" : ""}" data-v="${v}" aria-pressed="${on.has(v)}" aria-label="${escapeHtml(`${lineName(l)}: ${t(label)}`)}" title="${escapeHtml(t(label))}">${svg}</button>`
        ).join("")}</span>
      </div>`;
    };
    const groups = GROUP_ORDER.map((g) => [g, lines.filter((l) => (GROUP_ORDER.includes(l.group_key) ? l.group_key : "other") === g)]).filter(([, ls]) => ls.length);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet brand-sheet cs-sheet">
        <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
        <h2>${escapeHtml(labelOf(brand))}</h2>
        <div class="cs-legend muted" aria-hidden="true"><span>${BOTTLE} ${escapeHtml(t("cs_bottle"))}</span><span>${DRUM} ${escapeHtml(t("cs_drum"))}</span><span>${NONE} ${escapeHtml(t("cs_none"))}</span></div>
        <div class="cs-list">${groups.map(([g, ls]) => `<h3 class="cs-group">${escapeHtml(t(`vp_group_${g}`))}</h3>${ls.map(rowHtml).join("")}`).join("")}</div>
        <div class="sheet-actions"><button type="button" class="btn btn-primary btn-block" data-done>${t("done")}</button></div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay, { onEscape: () => close() });
    const list = overlay.querySelector(".cs-list");
    let pricesOpening = false; // a second tap while the last prices load opens no second sheet
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".cs-row");
      if (!row) return;
      const code = row.dataset.line;
      if (e.target.closest("[data-open-prices]")) {
        if (pricesOpening) return;
        pricesOpening = true;
        const l = lines.find((x) => x.code === code);
        openPriceSheet(brand, l, draftPrices).then(() => {
          pricesOpening = false;
          row.outerHTML = rowHtml(l);
        });
        return;
      }
      const btn = e.target.closest(".cs-btn");
      if (!btn) return;
      if (!marks.has(code)) marks.set(code, new Set());
      const set = marks.get(code);
      const v = btn.dataset.v;
      if (set.has(v)) set.delete(v);
      else if (v === "none") {
        set.clear();
        set.add("none");
      } else {
        set.delete("none");
        set.add(v);
      }
      if (!set.size) marks.delete(code);
      row.querySelectorAll(".cs-btn").forEach((b) => {
        const on = Boolean(marks.get(code)?.has(b.dataset.v));
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    });
    const close = () => {
      overlay.remove();
      resolve();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", close);
    overlay.querySelector("[data-done]").addEventListener("click", close);
  });
}

// ---- prices of one line: wholesale / retail per volume ------------------------------------------------------------------------------
const VOLUMES = [1, 4, 5, 60, 208];
const fmtVol = (v) => String(Math.round(v * 1000) / 1000).replace(".", ",");

function openPriceSheet(brand, line, draftPrices) {
  return new Promise(async (resolve) => {
    const unit = line.unit === "kg" ? t("vp_kg") : t("vp_l");
    const own = [...draftPrices.values()].filter((r) => r.brand === brand.key && r.line === line.code);
    const volumes = [...new Set([...VOLUMES, ...own.map((r) => r.volume)])].sort((a, b) => a - b);
    const last = (await loadLast(brand.key))[line.code] ?? {};
    const valueOf = (vol, k) => {
      const r = draftPrices.get(`${brand.key}|${line.code}|${vol}`);
      return r && r[k] != null ? groupDigits(r[k]) : "";
    };
    const hint = (vol) => {
      const l = last[vol];
      if (!l) return "";
      const parts = [l.wholesale != null ? groupDigits(l.wholesale) : "–", l.retail != null ? groupDigits(l.retail) : "–"].join(" / ");
      return `<small class="cs-last">${escapeHtml(t("cs_last").replace("{p}", parts).replace("{d}", formatDateDMY(l.at)))}</small>`;
    };
    const rowHtml = (vol) => `
      <div class="cs-price" data-vol="${vol}">
        <span class="cs-vol">${escapeHtml(`${fmtVol(vol)} ${unit}`)}${hint(vol)}</span>
        <input type="text" inputmode="numeric" class="cs-amd" data-k="wholesale" value="${valueOf(vol, "wholesale")}" aria-label="${escapeHtml(`${fmtVol(vol)} ${unit}: ${t("cs_wholesale")}`)}" />
        <input type="text" inputmode="numeric" class="cs-amd" data-k="retail" value="${valueOf(vol, "retail")}" aria-label="${escapeHtml(`${fmtVol(vol)} ${unit}: ${t("cs_retail")}`)}" />
      </div>`;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet cs-sheet cs-price-sheet">
        <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
        <h2>${escapeHtml(labelOf(brand))}<small class="cs-sub">${escapeHtml(lineName(line))}</small></h2>
        <div class="cs-price-head muted"><span>${escapeHtml(t("cs_volume"))}</span><span>${escapeHtml(t("cs_wholesale"))}, ${escapeHtml(t("amd"))}</span><span>${escapeHtml(t("cs_retail"))}, ${escapeHtml(t("amd"))}</span></div>
        <div class="cs-list cs-prices">${volumes.map(rowHtml).join("")}</div>
        <form class="cs-add-form cs-vol-form">
          <input type="text" inputmode="decimal" class="cs-vol-input" maxlength="8" placeholder="${escapeHtml(t("cs_custom_volume").replace("{u}", unit))}" aria-label="${escapeHtml(t("cs_custom_volume").replace("{u}", unit))}" />
          <button type="submit" class="btn btn-secondary">+ ${escapeHtml(t("cs_add_volume"))}</button>
        </form>
        <p class="muted cs-note">${escapeHtml(t("cs_price_note"))}</p>
        <div class="sheet-actions"><button type="button" class="btn btn-primary btn-block" data-done>${t("done")}</button></div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay, { onEscape: () => close() });
    const list = overlay.querySelector(".cs-prices");
    // whole AMD with thousands separators as typed
    list.addEventListener("input", (e) => {
      const el = e.target.closest(".cs-amd");
      if (!el) return;
      const digits = el.value.replace(/\D/g, "").slice(0, 9);
      el.value = digits ? groupDigits(Number(digits)) : "";
    });
    overlay.querySelector(".cs-vol-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = overlay.querySelector(".cs-vol-input");
      const vol = Math.round(Number(String(input.value).replace(",", ".")) * 1000) / 1000;
      if (!(vol > 0 && vol <= 10000)) {
        showToast(t("cs_bad_volume"));
        return;
      }
      input.value = "";
      if (list.querySelector(`[data-vol="${vol}"]`)) return;
      const after = [...list.querySelectorAll(".cs-price")].find((r) => Number(r.dataset.vol) > vol);
      if (after) after.insertAdjacentHTML("beforebegin", rowHtml(vol));
      else list.insertAdjacentHTML("beforeend", rowHtml(vol));
      list.querySelector(`[data-vol="${vol}"] .cs-amd`)?.focus();
    });
    // every way out keeps what was typed
    const close = () => {
      list.querySelectorAll(".cs-price").forEach((r) => {
        const vol = Number(r.dataset.vol);
        const num = (k) => {
          const d = r.querySelector(`[data-k="${k}"]`).value.replace(/\D/g, "");
          return d ? Number(d) : null;
        };
        const key = `${brand.key}|${line.code}|${vol}`;
        const wholesale = num("wholesale");
        const retail = num("retail");
        if (wholesale == null && retail == null) draftPrices.delete(key);
        else draftPrices.set(key, { brand: brand.key, line: line.code, volume: vol, wholesale, retail });
      });
      overlay.remove();
      resolve();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", close);
    overlay.querySelector("[data-done]").addEventListener("click", close);
  });
}
