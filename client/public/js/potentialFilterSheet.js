// Potential Customers filter (owner, 2026-10-24): level, reason, last visit, next follow-up, expected volume, counterfeit flag.
// Sales manager and region are the Customers list's own filters. One bottom sheet with tap-to-toggle chips and a live "Show N" count.
import { t } from "./i18n.js";
import { escapeHtml, activateDialog } from "./util.js";
import { POTENTIAL_LEVELS } from "./potential.js";

const REASONS = ["counterfeit", "own_import", "competitor_loyal", "price_mismatch", "small_volume", "not_interested", "no_decision_maker", "payment_issue", "no_demand_now", "high_potential", "active_interest", "negotiating", "ready_first_order", "other"];
const LAST_VISIT = ["7", "14", "30", "never"];
const FOLLOWUP = ["due", "week", "none"];
const VOLUME = ["50", "200", "500"];
const DAY = 86400000;

export const emptyPotentialFilter = () => ({ levels: new Set(), reasons: new Set(), counterfeit: false, lastVisit: "", followup: "", volume: "" });
export const potentialFilterCount = (f) => f.levels.size + f.reasons.size + (f.counterfeit ? 1 : 0) + (f.lastVisit ? 1 : 0) + (f.followup ? 1 : 0) + (f.volume ? 1 : 0);

// today: "YYYY-MM-DD" (the device's local day).
export function matchesPotentialFilter(c, f, today) {
  if (!potentialFilterCount(f)) return true;
  // Every filter here is about prospects; only the counterfeit flag also reaches customers of other tiers.
  if (c.customer_tier !== "potential" && !(f.counterfeit && c.counterfeit_flag)) return false;
  if (f.counterfeit && !c.counterfeit_flag) return false;
  if (f.levels.size && !f.levels.has(c.potential_level ?? 0)) return false;
  if (f.reasons.size && !(c.potential_reasons ?? []).some((r) => f.reasons.has(r))) return false;
  if (f.lastVisit === "never" && c.last_visit_at) return false;
  if (["7", "14", "30"].includes(f.lastVisit) && c.last_visit_at && Date.now() - new Date(c.last_visit_at).getTime() < Number(f.lastVisit) * DAY) return false;
  const d = c.next_followup_date ? String(c.next_followup_date).slice(0, 10) : null;
  if (f.followup === "none" && d) return false;
  if (f.followup === "due" && !(d && d <= today)) return false;
  if (f.followup === "week" && !(d && d >= today && d <= new Date(new Date(`${today}T00:00:00Z`).getTime() + 7 * DAY).toISOString().slice(0, 10))) return false;
  if (f.volume && !(Number(c.expected_volume_l) >= Number(f.volume))) return false;
  return true;
}

// High first ... no potential last, not assessed after real potential (same order as the server's follow-up priority); soonest follow-up next.
const RANK = { 4: 1, 3: 2, 0: 3, 2: 4, 1: 5 };
export function comparePotentialPriority(a, b) {
  const ra = RANK[a.potential_level ?? 0] ?? 3;
  const rb = RANK[b.potential_level ?? 0] ?? 3;
  if (ra !== rb) return ra - rb;
  const da = a.next_followup_date ? String(a.next_followup_date).slice(0, 10) : "9999-12-31";
  const db = b.next_followup_date ? String(b.next_followup_date).slice(0, 10) : "9999-12-31";
  return da < db ? -1 : da > db ? 1 : 0;
}

// rows: the customers the list would show with no potential filter on (every other filter applied).
export function openPotentialFilterSheet({ rows, filter, today, onApply }) {
  const f = { ...filter, levels: new Set(filter.levels), reasons: new Set(filter.reasons) };
  const chip = (attrs, on, inner) => `<button type="button" class="pl-reason-chip pl-filter-chip ${on ? "pl-reason-on" : ""}" ${attrs} aria-pressed="${on}">${inner}</button>`;
  const single = (key, values, labelOf) =>
    [["", t("pf_any")], ...values.map((v) => [v, labelOf(v)])].map(([v, label]) => chip(`data-single="${key}" data-value="${v}"`, f[key === "last_visit" ? "lastVisit" : key] === v, escapeHtml(label))).join("");
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet pf-sheet">
      <h2>${escapeHtml(t("pf_title"))}</h2>
      <div class="pl-section-title">${escapeHtml(t("pl_level_label"))}</div>
      <div class="pl-reasons" id="pf-levels">${[4, 3, 2, 1, 0].map((l) => chip(`data-level="${l}"`, f.levels.has(l), `<i class="pl-dot pl-${l}"></i>${escapeHtml(t(`pl_level_${l}`))} <span class="ttf-count" data-count="${l}"></span>`)).join("")}</div>
      <div class="pl-section-title">${escapeHtml(t("pl_reason"))}</div>
      <div class="pl-reasons" id="pf-reasons">${REASONS.map((r) => chip(`data-reason="${r}"`, f.reasons.has(r), escapeHtml(t(`pl_reason_${r}`)))).join("")}</div>
      <div class="pl-section-title">${escapeHtml(t("pf_counterfeit"))}</div>
      <div class="pl-reasons">${chip('data-counterfeit="1"', f.counterfeit, `⚠️ ${escapeHtml(t("pf_counterfeit_on"))}`)}</div>
      <div class="pl-section-title">${escapeHtml(t("last_visit"))}</div>
      <div class="pl-reasons">${single("last_visit", LAST_VISIT, (v) => (v === "never" ? t("never_visited") : t("pf_no_visit_days").replace("{n}", v)))}</div>
      <div class="pl-section-title">${escapeHtml(t("pl_followup"))}</div>
      <div class="pl-reasons">${single("followup", FOLLOWUP, (v) => t(`pf_followup_${v}`))}</div>
      <div class="pl-section-title">${escapeHtml(t("pf_volume"))}</div>
      <div class="pl-reasons">${single("volume", VOLUME, (v) => t("pf_volume_min").replace("{n}", v))}</div>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" id="pf-clear">${escapeHtml(t("clear"))}</button>
        <button type="button" class="btn btn-primary" id="pf-done"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const doneBtn = overlay.querySelector("#pf-done");

  const paint = () => {
    overlay.querySelectorAll("[data-level]").forEach((b) => {
      const on = f.levels.has(Number(b.dataset.level));
      b.classList.toggle("pl-reason-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    overlay.querySelectorAll("[data-reason]").forEach((b) => {
      const on = f.reasons.has(b.dataset.reason);
      b.classList.toggle("pl-reason-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    const cf = overlay.querySelector("[data-counterfeit]");
    cf.classList.toggle("pl-reason-on", f.counterfeit);
    cf.setAttribute("aria-pressed", String(f.counterfeit));
    overlay.querySelectorAll("[data-single]").forEach((b) => {
      const on = f[b.dataset.single === "last_visit" ? "lastVisit" : b.dataset.single] === b.dataset.value;
      b.classList.toggle("pl-reason-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    // each level chip: how many prospects it holds with the OTHER chips applied
    for (const l of [4, 3, 2, 1, 0]) {
      const without = { ...f, levels: new Set() };
      overlay.querySelector(`[data-count="${l}"]`).textContent = rows.filter((c) => matchesPotentialFilter(c, { ...without, levels: new Set([l]) }, today)).length;
    }
    const n = rows.filter((c) => matchesPotentialFilter(c, f, today)).length;
    doneBtn.textContent = t("pf_show").replace("{n}", n);
  };
  paint();

  overlay.addEventListener("click", (e) => {
    const b = e.target.closest("button[aria-pressed]");
    if (!b || !overlay.contains(b)) return;
    if (b.dataset.level !== undefined) {
      const l = Number(b.dataset.level);
      f.levels.has(l) ? f.levels.delete(l) : f.levels.add(l);
    } else if (b.dataset.reason) {
      f.reasons.has(b.dataset.reason) ? f.reasons.delete(b.dataset.reason) : f.reasons.add(b.dataset.reason);
    } else if (b.dataset.counterfeit) {
      f.counterfeit = !f.counterfeit;
    } else if (b.dataset.single) {
      f[b.dataset.single === "last_visit" ? "lastVisit" : b.dataset.single] = b.dataset.value;
    }
    paint();
  });
  overlay.querySelector("#pf-clear").addEventListener("click", () => {
    Object.assign(f, emptyPotentialFilter());
    paint();
  });
  doneBtn.addEventListener("click", () => {
    overlay.remove();
    onApply(f);
  });
}

export { POTENTIAL_LEVELS };
