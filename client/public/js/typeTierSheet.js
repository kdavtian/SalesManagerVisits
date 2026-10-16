// "Customer type & tier" filter as tap-to-toggle chips (several can be on at once) instead of the nested tree.
// Tiers sit on two fixed rows (gold / silver / bronze, then potential / competitor), types in a two-column grid. Every
// chip shows how many customers it holds RIGHT NOW: the tier numbers follow the chosen types and the type numbers follow
// the chosen tiers (and both follow search, region, status pill... -- everything already filtering the list), so with
// "gold" on the owner sees at once how many of the gold customers are workshops or oil points. The main button shows
// the live "Show N".
import { t } from "./i18n.js";
import { escapeHtml, activateDialog, TIER_OPTIONS, CATEGORY_LIST } from "./util.js";
import { NO_GROUP_KEY } from "./regionTree.js";

const tierOf = (c) => c.customer_tier || "potential";
const typeOf = (c) => c.category || NO_GROUP_KEY;

// rows: the customers the list would show with NO type/tier chip on (every other filter and the status pill applied).
export function openTypeTierSheet({ rows, types, tiers, onApply }) {
  const workingTypes = new Set(types);
  const workingTiers = new Set(tiers);
  const tierById = new Map(TIER_OPTIONS.map((o) => [o.value, o]));
  const tierBtn = (v) => {
    const o = tierById.get(v);
    return `<button type="button" class="tier-btn ${o.cls} ${workingTiers.has(v) ? "tier-btn-active" : ""}" data-tier="${v}" aria-pressed="${workingTiers.has(v)}">
      <span class="ttf-tier-top"><span class="tier-icon">${o.icon}</span><span class="tier-label">${escapeHtml(t(o.labelKey))}</span></span><span class="ttf-count" data-count></span>
    </button>`;
  };
  const typeOptions = CATEGORY_LIST.map((o) => ({ value: o.value, label: t(o.labelKey), icon: o.icon, cls: o.cls }));
  if (rows.some((c) => !c.category) || workingTypes.has(NO_GROUP_KEY)) typeOptions.push({ value: NO_GROUP_KEY, label: t("no_customer_type"), icon: "", cls: "category-none" });

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet type-tier-sheet">
      <h2>${escapeHtml(t("filter_type_tier_title"))}</h2>
      <h3 class="map-tier-filter-title">${escapeHtml(t("customer_tier"))}</h3>
      <div class="ttf-tiers" role="group" aria-label="${escapeHtml(t("customer_tier"))}">
        <div class="ttf-row ttf-row-3">${["gold", "silver", "bronze"].map(tierBtn).join("")}</div>
        <div class="ttf-row ttf-row-2">${["potential", "competitor"].map(tierBtn).join("")}</div>
      </div>
      <h3 class="map-tier-filter-title">${escapeHtml(t("category"))}</h3>
      <div class="ttf-types" role="group" aria-label="${escapeHtml(t("category"))}">
        ${typeOptions
          .map(
            (o) => `<button type="button" class="category-btn ${o.cls} ${workingTypes.has(o.value) ? "category-btn-active" : ""}" data-type="${escapeHtml(o.value)}" aria-pressed="${workingTypes.has(o.value)}">
              ${o.icon ? `<span class="category-icon">${o.icon}</span>` : ""}<span class="category-label">${escapeHtml(o.label)}</span><span class="ttf-count" data-count></span>
            </button>`
          )
          .join("")}
      </div>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" id="ttf-clear">${t("clear")}</button>
        <button type="button" class="btn btn-primary" id="ttf-done"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  const doneBtn = overlay.querySelector("#ttf-done");
  // Repaint every number from the two working sets (a few hundred rows at most per pass: instant).
  const paintCounts = () => {
    const typeCount = new Map();
    const tierCount = new Map();
    let shown = 0;
    for (const c of rows) {
      const type = typeOf(c);
      const tier = tierOf(c);
      const typeOk = !workingTypes.size || workingTypes.has(type);
      const tierOk = !workingTiers.size || workingTiers.has(tier);
      if (tierOk) typeCount.set(type, (typeCount.get(type) || 0) + 1); // type chips follow the chosen tiers
      if (typeOk) tierCount.set(tier, (tierCount.get(tier) || 0) + 1); // tier chips follow the chosen types
      if (typeOk && tierOk) shown++;
    }
    const paintChip = (btn, n, on) => {
      btn.querySelector("[data-count]").textContent = String(n);
      btn.classList.toggle("ttf-empty", n === 0 && !on); // nothing left in it: dimmed, still tappable
    };
    overlay.querySelectorAll("[data-type]").forEach((b) => paintChip(b, typeCount.get(b.dataset.type) || 0, workingTypes.has(b.dataset.type)));
    overlay.querySelectorAll("[data-tier]").forEach((b) => paintChip(b, tierCount.get(b.dataset.tier) || 0, workingTiers.has(b.dataset.tier)));
    doneBtn.textContent = `${t("show_results")} (${shown})`;
  };
  paintCounts();
  const toggle = (set, value, btn, activeCls) => {
    if (set.has(value)) set.delete(value);
    else set.add(value);
    btn.classList.toggle(activeCls, set.has(value));
    btn.setAttribute("aria-pressed", String(set.has(value)));
    paintCounts();
  };
  overlay.querySelectorAll("[data-type]").forEach((btn) => btn.addEventListener("click", () => toggle(workingTypes, btn.dataset.type, btn, "category-btn-active")));
  overlay.querySelectorAll("[data-tier]").forEach((btn) => btn.addEventListener("click", () => toggle(workingTiers, btn.dataset.tier, btn, "tier-btn-active")));
  overlay.querySelector("#ttf-clear").addEventListener("click", () => {
    overlay.remove();
    onApply(new Set(), new Set());
  });
  doneBtn.addEventListener("click", () => {
    overlay.remove();
    onApply(workingTypes, workingTiers);
  });
}
