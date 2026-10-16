// "Customer type & tier" filter as two groups of tap-to-toggle chips (several can be on at once) instead of the nested
// tree: Type chips (oil point / shop / workshop / other / no type) and Tier chips (gold ... competitor), each with how many
// customers it holds, and a live "Show N" on the main button so the effect is visible before closing the sheet.
import { t } from "./i18n.js";
import { escapeHtml, activateDialog, TIER_OPTIONS, CATEGORY_LIST } from "./util.js";
import { NO_GROUP_KEY } from "./regionTree.js";

const TIER_ORDER = ["gold", "silver", "bronze", "potential", "competitor"];

// customers: everything the chips count; countMatching(typeSet, tierSet) -> how many rows the list would show.
export function openTypeTierSheet({ customers, types, tiers, countMatching, onApply }) {
  const workingTypes = new Set(types);
  const workingTiers = new Set(tiers);
  const typeCount = new Map();
  const tierCount = new Map();
  for (const c of customers) {
    const type = c.category || NO_GROUP_KEY;
    typeCount.set(type, (typeCount.get(type) || 0) + 1);
    const tier = c.customer_tier || "potential";
    tierCount.set(tier, (tierCount.get(tier) || 0) + 1);
  }
  const typeOptions = CATEGORY_LIST.map((o) => ({ value: o.value, label: t(o.labelKey), icon: o.icon, cls: o.cls }));
  if (typeCount.has(NO_GROUP_KEY)) typeOptions.push({ value: NO_GROUP_KEY, label: t("no_customer_type"), icon: "", cls: "category-none" });
  const tierOptions = TIER_ORDER.map((v) => TIER_OPTIONS.find((o) => o.value === v)).filter(Boolean);

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet type-tier-sheet">
      <h2>${escapeHtml(t("filter_type_tier_title"))}</h2>
      <h3 class="map-tier-filter-title">${escapeHtml(t("category"))}</h3>
      <div class="ttf-chips" id="ttf-types" role="group" aria-label="${escapeHtml(t("category"))}">
        ${typeOptions
          .map(
            (o) => `<button type="button" class="category-btn ${o.cls} ${workingTypes.has(o.value) ? "category-btn-active" : ""}" data-type="${escapeHtml(o.value)}" aria-pressed="${workingTypes.has(o.value)}">
              ${o.icon ? `<span class="category-icon">${o.icon}</span>` : ""}<span class="category-label">${escapeHtml(o.label)}</span><span class="ttf-count">${typeCount.get(o.value) || 0}</span>
            </button>`
          )
          .join("")}
      </div>
      <h3 class="map-tier-filter-title">${escapeHtml(t("customer_tier"))}</h3>
      <div class="ttf-chips" id="ttf-tiers" role="group" aria-label="${escapeHtml(t("customer_tier"))}">
        ${tierOptions
          .map(
            (o) => `<button type="button" class="tier-btn ${o.cls} ${workingTiers.has(o.value) ? "tier-btn-active" : ""}" data-tier="${o.value}" aria-pressed="${workingTiers.has(o.value)}">
              <span class="tier-icon">${o.icon}</span><span class="tier-label">${escapeHtml(t(o.labelKey))}</span><span class="ttf-count">${tierCount.get(o.value) || 0}</span>
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
  const paintDone = () => {
    doneBtn.textContent = `${t("show_results")} (${countMatching(workingTypes, workingTiers)})`;
  };
  paintDone();
  const toggle = (set, value, btn, activeCls) => {
    if (set.has(value)) set.delete(value);
    else set.add(value);
    btn.classList.toggle(activeCls, set.has(value));
    btn.setAttribute("aria-pressed", String(set.has(value)));
    paintDone();
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
