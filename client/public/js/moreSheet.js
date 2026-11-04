// The "More" sheet behind the top bar's menu button (owner, 2026-11-04: "the menu button opens the same sectioned menu in both KAD apps").
// Every screen this person may open, in the desktop sidebar's groups (screenCatalog.js), each row with a pin toggle, and Settings at the
// bottom (with the same number the menu button carries: plans and change requests waiting for this person). Any screen is two taps away.
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml, activateDialog } from "./util.js";
import { GROUP_LABEL, groupOrder, pinnableIds, screenItems } from "./screenCatalog.js";
import { bindPinButtons, pinButtonHtml } from "./pins.js";
import { adminReviewCount } from "./badges.js";

let openOverlay = null;

export function openMoreSheet({ navigate, settings }) {
  if (openOverlay?.isConnected) return openOverlay;
  const items = screenItems(settings);
  const pinnable = new Set(pinnableIds(settings));
  const current = (location.hash || "#/dashboard").split("?")[0];
  const rows = (list) =>
    list
      .map(
        (it) => `<div class="more-row">
          <button type="button" class="more-link${current === it.hash.split("?")[0] ? " is-current" : ""}" data-hash="${escapeHtml(it.hash)}" ${current === it.hash.split("?")[0] ? 'aria-current="page"' : ""}>
            <span class="more-link-icon ${it.colorClass ? `quick-action-icon ${it.colorClass}` : ""}">${it.icon}</span>
            <span class="more-link-label">${escapeHtml(it.label)}</span>
          </button>${pinnable.has(it.id) ? pinButtonHtml(it.id) : ""}
        </div>`
      )
      .join("");
  const groups = groupOrder().map((key) => ({ key, list: items.filter((it) => it.group === key) })).filter((g) => g.list.length);
  const review = adminReviewCount();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay more-overlay";
  overlay.innerHTML = `
    <div class="sheet more-sheet" role="dialog" aria-label="${escapeHtml(t("nav_more"))}">
      <div class="sheet-grab" aria-hidden="true"></div>
      <div class="sheet-header more-sheet-head">
        <h2>${escapeHtml(t("nav_more"))}</h2>
        <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${escapeHtml(t("close"))}">${icons.close}</button>
      </div>
      <nav class="more-sections" aria-label="${escapeHtml(t("nav_more"))}">
        ${groups.map((g) => `<section class="more-section"><h3 class="more-section-title">${escapeHtml(t(GROUP_LABEL[g.key]))}</h3>${rows(g.list)}</section>`).join("")}
        <section class="more-section more-section-settings">
          <div class="more-row">
            <button type="button" class="more-link${current === "#/settings" ? " is-current" : ""}" data-hash="#/settings">
              <span class="more-link-icon">${icons.settings}<span class="nav-badge count-badge" data-badge="admin-review" ${review > 0 ? "" : "hidden"}>${review > 99 ? "99+" : review}</span></span>
              <span class="more-link-label">${escapeHtml(t("nav_settings"))}</span>
            </button>
          </div>
        </section>
      </nav>
    </div>`;
  document.body.appendChild(overlay);
  openOverlay = overlay;
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) return close();
    if (e.target.closest?.('[data-action="close"]')) return close();
    const link = e.target.closest?.("[data-hash]");
    if (link) {
      close();
      navigate(link.dataset.hash);
    }
  });
  bindPinButtons(overlay.querySelector(".more-sections"));
  return overlay;
}
