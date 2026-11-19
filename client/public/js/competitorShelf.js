// Check-in > Competitors (owner, 2026-11-19): one row per brand with three outline icon buttons on the right -- bottles on the shelf
// (a golden 1 L bottle), a drum (green, bulk oil) and "not available". Bottles and drum are separate (a shop can sell only one of them,
// or both); "not available" clears them both. Nothing picked = all three faded; picked = full colour, filled, outlined.
// "+ Add new brand": usable at once by this rep, approved by admin / CEO before every rep sees it (server field/competitorBrands.js).
import { api } from "./api.js";
import { t, hasText } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, showToast } from "./util.js";
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
export async function openCompetitorSheet({ title, packs, onApply }) {
  const brands = [...(await loadBrands())];
  for (const key of Object.keys(packs)) if (!brands.some((b) => b.key === key)) brands.push({ key, name: "", status: "approved" });
  // a Map: a brand key can be any word, and a plain object answers some words by itself (review, 2026-11-19)
  const draft = new Map(Object.entries(packs).map(([k, v]) => [k, new Set(v)]));

  const rowHtml = (b) => {
    const on = draft.get(b.key) ?? new Set();
    return `<div class="cs-row" data-key="${escapeHtml(b.key)}">
      <span class="cs-name">${escapeHtml(labelOf(b))}${b.status === "pending" ? `<small class="cs-pending">${escapeHtml(t("cs_pending"))}</small>` : ""}</span>
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
  activateDialog(overlay);
  const list = overlay.querySelector(".cs-list");

  // tap: bottle / drum toggle on their own and clear "not available"; "not available" clears both; a second tap clears it
  list.addEventListener("click", (e) => {
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
    overlay.remove();
    onApply?.();
  };
  overlay.addEventListener("click", (e) => e.target === overlay && apply());
  overlay.querySelector('[data-action="close-sheet"]').addEventListener("click", apply);
  overlay.querySelector("#cs-done").addEventListener("click", apply);
}
