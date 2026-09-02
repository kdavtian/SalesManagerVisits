import { getLang, t } from "./i18n.js";

export function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const EARTH_RADIUS_METERS = 6371000;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Customer relationship tier -- distinct from category (what kind of
// business). potential/competitor have no ERP Customer ID; bronze/silver/
// gold are real accounts, each priced from a different Castrol PriceList
// column (see server products.silver_price_amd / gold_price_amd).
// A small embossed-coin glyph -- a ring with the tier's rank number in the
// middle -- shared by bronze/silver/gold and colored per tier via CSS
// currentColor (see .tier-bronze/.tier-silver/.tier-gold), same as the
// other tier icons below.
function coinIcon(n) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">${n}</text></svg>`;
}

const TIER_ICON = {
  // Bullseye/target -- an unconverted lead, still "in the sights".
  potential: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>`,
  bronze: coinIcon(3),
  silver: coinIcon(2),
  gold: coinIcon(1),
  // Binoculars -- watching a competitor's account, not our own.
  competitor: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10h4"/><path d="M19 7V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3"/><path d="M20 21a2 2 0 0 0 2-2v-3.85c0-1.39-2-2.96-2-4.83V8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v11a2 2 0 0 0 2 2z"/><path d="M22 16H2"/><path d="M4 21a2 2 0 0 1-2-2v-3.85c0-1.39 2-2.96 2-4.83V8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2z"/><path d="M9 7V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v3"/></svg>`,
};

export const TIER_OPTIONS = [
  { value: "potential", labelKey: "tier_potential", icon: TIER_ICON.potential, cls: "tier-potential" },
  { value: "bronze", labelKey: "tier_bronze", icon: TIER_ICON.bronze, cls: "tier-bronze" },
  { value: "silver", labelKey: "tier_silver", icon: TIER_ICON.silver, cls: "tier-silver" },
  { value: "gold", labelKey: "tier_gold", icon: TIER_ICON.gold, cls: "tier-gold" },
  { value: "competitor", labelKey: "tier_competitor", icon: TIER_ICON.competitor, cls: "tier-competitor" },
];

// Customer category -- what kind of business this is, distinct from tier.
// Selected via icon buttons (see categorySelectorHtml) rather than a
// dropdown, same pattern as the tier selector above. Values are the raw
// Armenian labels stored on the customer record -- used directly as both
// the stored value and the display text, matching how this field always
// worked (no separate translation layer for these fixed business terms).
const CATEGORY_ICON = {
  // A fuel pump -- stands in for "oil changing point" (garage forecourt).
  oilPoint: `<svg class="ui-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.002a2 2 0 0 0-.59-1.42L18 5"/><path d="M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16"/><path d="M2 21h13"/><path d="M3 9h11"/></svg>`,
  shop: `<svg class="ui-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 8H6"/></svg>`,
  // A wrench -- the auto workshop/service point.
  workshop: `<svg class="ui-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1c.32-.32.86-.22.98.22a6 6 0 0 1-8.26 7.06l-7.9 7.9a1 1 0 0 1-3-3l7.9-7.9a6 6 0 0 1 7.06-8.26c.44.12.54.66.22.98z"/></svg>`,
  other: `<svg class="ui-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5.5-8 11-8 11S4 15.5 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
};

// Armenia's 11 administrative regions (10 marzes + Yerevan, which is a
// separate city with marz-equivalent status). Subregion is a fixed list of
// Yerevan's 12 districts when region is Yerevan; for every other region,
// there's no exhaustive city list maintained here, so subregion stays free
// text (whatever city the customer is in).
export const REGION_LIST = [
  "Yerevan",
  "Aragatsotn",
  "Ararat",
  "Armavir",
  "Gegharkunik",
  "Kotayk",
  "Lori",
  "Shirak",
  "Syunik",
  "Tavush",
  "Vayots Dzor",
];

export const YEREVAN_DISTRICTS = [
  "Ajapnyak",
  "Arabkir",
  "Avan",
  "Davtashen",
  "Erebuni",
  "Kanaker-Zeytun",
  "Kentron",
  "Malatia-Sebastia",
  "Nor Nork",
  "Nork-Marash",
  "Nubarashen",
  "Shengavit",
];

// Best-effort match of a geocoder's free-text region/subregion guess
// against the fixed lists above -- accent/case-insensitive substring match
// in either direction, since OSM data can spell things a little differently
// ("Kanaker-Zeytun" vs "Kanaker Zeytun"). Returns "" (unmatched, left for
// the rep to pick) rather than guessing wrong.
function fuzzyMatch(guess, list) {
  if (!guess) return "";
  const norm = (s) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]/g, "");
  const g = norm(guess);
  if (!g) return "";
  return list.find((v) => {
    const n = norm(v);
    return n === g || n.includes(g) || g.includes(n);
  }) ?? "";
}

export function matchRegion(guess) {
  return fuzzyMatch(guess, REGION_LIST);
}

export function matchSubregion(guess, region) {
  if (region === "Yerevan") return fuzzyMatch(guess, YEREVAN_DISTRICTS);
  // Outside Yerevan there's no fixed list -- just pass the geocoder's own
  // guess through as the starting text (e.g. the city name), still editable.
  return guess || "";
}

// The fixed set of assigned sales channels, matching the Customers sheet in
// the Castrol file: the named-account channels (KF, CAS) plus the region-
// scoped OEM/CVO/PCO trade channels and each sales manager's own territory
// channel (SM B2B/YVN/Davtashen/Shirak).
export const SALES_CHANNELS = ["KF", "CAS", "OEM", "CVO", "PCO", "SM B2B", "SM YVN", "SM Davtashen", "SM Shirak"];

export const CATEGORY_LIST = [
  { value: "Յուղման կետ", labelKey: "category_oil_point", icon: CATEGORY_ICON.oilPoint, cls: "category-oil-point" },
  { value: "Խանութ", labelKey: "category_shop", icon: CATEGORY_ICON.shop, cls: "category-shop" },
  { value: "Ավտոսերվիս", labelKey: "category_workshop", icon: CATEGORY_ICON.workshop, cls: "category-workshop" },
  { value: "Այլ", labelKey: "category_other", icon: CATEGORY_ICON.other, cls: "category-other" },
];

// Kept for anything that still needs the raw list of values (e.g. filters
// over existing data written before the category set changed).
export const CATEGORY_OPTIONS = CATEGORY_LIST.map((c) => c.value);

// The stored value is always the raw Armenian text (matches the ERP/Castrol
// data and every customer record written before this translation layer
// existed) -- this only controls what's *displayed*, so a customer marked
// "Յուղման կետ" reads as "Oil change point" when English is selected and
// "Յուղման կետ" when Armenian is, without touching the underlying data.
export function categoryLabel(value) {
  const opt = CATEGORY_LIST.find((c) => c.value === value);
  return opt ? t(opt.labelKey) : value;
}

export function categorySelectorHtml(selected = "", inputName = "category") {
  return `
    <div class="category-selector" role="radiogroup" aria-label="${t("category")}">
      ${CATEGORY_LIST.map(
        (opt) => `
        <button type="button" class="category-btn ${opt.cls} ${opt.value === selected ? "category-btn-active" : ""}" data-category="${escapeHtml(opt.value)}" role="radio" aria-checked="${opt.value === selected}">
          <span class="category-icon">${opt.icon}</span>
          <span class="category-label">${escapeHtml(t(opt.labelKey))}</span>
        </button>`
      ).join("")}
      <input type="hidden" name="${inputName}" value="${escapeHtml(selected)}" />
    </div>
  `;
}

// Wires up click behavior for a categorySelectorHtml() block already in the
// DOM -- pass the element containing it (not the .category-selector itself).
export function activateCategorySelector(container, onChange) {
  const wrap = container.querySelector(".category-selector");
  if (!wrap) return;
  const hiddenInput = wrap.querySelector("input[type=hidden]");
  wrap.querySelectorAll(".category-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".category-btn").forEach((b) => {
        b.classList.remove("category-btn-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("category-btn-active");
      btn.setAttribute("aria-checked", "true");
      hiddenInput.value = btn.dataset.category;
      onChange?.(btn.dataset.category);
    });
  });
}

// Maps a stored category value to its icon glyph -- for showing a small
// category icon wherever a customer's category is displayed read-only
// (detail page, map pins). Falls back to the generic "other" glyph for any
// value that isn't one of the four current buttons (e.g. legacy data).
export function categoryIcon(value) {
  return CATEGORY_LIST.find((c) => c.value === value)?.icon ?? CATEGORY_ICON.other;
}

export function tierSelectorHtml(selected = "potential", inputName = "customer_tier") {
  return `
    <div class="tier-selector" role="radiogroup" aria-label="${t("customer_tier")}">
      ${TIER_OPTIONS.map(
        (opt) => `
        <button type="button" class="tier-btn ${opt.cls} ${opt.value === selected ? "tier-btn-active" : ""}" data-tier="${opt.value}" role="radio" aria-checked="${opt.value === selected}">
          <span class="tier-icon">${opt.icon}</span>
          <span class="tier-label">${t(opt.labelKey)}</span>
        </button>`
      ).join("")}
      <input type="hidden" name="${inputName}" value="${selected}" />
    </div>
  `;
}

export function tierBadgeHtml(tier) {
  const opt = TIER_OPTIONS.find((o) => o.value === tier) ?? TIER_OPTIONS[0];
  return `<span class="badge tier-badge ${opt.cls}">${opt.icon}${t(opt.labelKey)}</span>`;
}

// The customer-list-row icon: the category glyph (garage/shop/workshop/
// other) as the main shape, with a small tier-colored badge in the corner
// (a numbered coin for bronze/silver/gold, the target/binoculars glyph for
// potential/competitor) -- so glancing at the row alone answers "what kind
// of place, and how big an account" without opening it. Complements the
// map pins, which encode the same two facts the other way around (tier
// owns the pin's shape/color, category is the small glyph inside it).
export function customerListIconHtml(c) {
  const tier = TIER_OPTIONS.find((o) => o.value === c.customer_tier) ?? TIER_OPTIONS[0];
  return `
    <span class="customer-card-icon">
      ${categoryIcon(c.category)}
      <span class="customer-card-icon-tier ${tier.cls}">${tier.icon}</span>
    </span>
  `;
}

// Wires up click behavior for a tierSelectorHtml() block already in the
// DOM -- pass the element containing it (not the .tier-selector itself).
export function activateTierSelector(container, onChange) {
  const wrap = container.querySelector(".tier-selector");
  if (!wrap) return;
  const hiddenInput = wrap.querySelector("input[type=hidden]");
  wrap.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".tier-btn").forEach((b) => {
        b.classList.remove("tier-btn-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("tier-btn-active");
      btn.setAttribute("aria-checked", "true");
      hiddenInput.value = btn.dataset.tier;
      onChange?.(btn.dataset.tier);
    });
  });
}

export function formatAmd(value) {
  if (value == null) return "";
  return `${Number(value).toLocaleString()} ${t("amd")}`;
}

export function formatDistance(meters) {
  if (meters == null) return "";
  const isHy = getLang() === "hy";
  const unitM = isHy ? "մ" : "m";
  const unitKm = isHy ? "կմ" : "km";
  return meters < 1000 ? `${Math.round(meters)}${unitM}` : `${(meters / 1000).toFixed(1)}${unitKm}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Deep-link into a turn-by-turn navigation app. Previously this auto-detected
// which app was installed by racing a scheme launch against a timeout, then
// cascading Yandex -> Google -> web on "not installed" -- but the detection
// is inherently racy (e.g. iOS's "Open in App?" confirmation prompt delays
// the visibility change past the timeout), so a slow-but-real Yandex launch
// could still trigger the Google fallback on top of it, opening both apps.
// Asking the rep which app to open removes the race entirely: exactly one
// scheme fires, with only its own web version as a same-app fallback.
export function openNavigation(lat, lng) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  const yandexUrl = `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`;
  const yandexWebUrl = `https://yandex.com/maps/?rtext=~${lat}%2C${lng}&rtt=auto`;
  const googleWebUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const googleIosSchemeUrl = `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`;

  function openWithFallback(schemeUrl, webFallbackUrl, timeoutMs = 1800) {
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(timer);
    }
    function onVisibilityChange() {
      if (document.hidden) settle();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = setTimeout(() => {
      if (!settled) {
        settle();
        window.location.href = webFallbackUrl;
      }
    }, timeoutMs);
    window.location.href = schemeUrl;
  }

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("choose_navigation_app")}</h2>
      <div class="nav-choice-list">
        <button type="button" class="nav-choice-btn" data-app="yandex">${t("open_in_yandex")}</button>
        <button type="button" class="nav-choice-btn" data-app="google">${t("open_in_google_maps")}</button>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-block" id="cancel-nav-choice">${t("cancel")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#cancel-nav-choice").addEventListener("click", close);

  overlay.querySelector('[data-app="yandex"]').addEventListener("click", () => {
    close();
    openWithFallback(yandexUrl, yandexWebUrl);
  });
  overlay.querySelector('[data-app="google"]').addEventListener("click", () => {
    close();
    if (isIOS) {
      openWithFallback(googleIosSchemeUrl, googleWebUrl);
    } else {
      // Google Maps' web URL resolves to the installed app via Android
      // intent handling, or the web app otherwise -- no separate scheme
      // attempt needed on Android.
      window.location.href = googleWebUrl;
    }
  });
}

export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
      ...options,
    });
  });
}

// Applies consistent dialog semantics and keyboard behavior to dynamically
// created bottom sheets, including focus restoration when a sheet closes.
export function activateDialog(overlay) {
  const dialog = overlay.querySelector(".sheet") || overlay;
  const previousFocus = document.activeElement;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("tabindex", "-1");
  const selector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      overlay.remove();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...dialog.querySelectorAll(selector)].filter((el) => !el.hidden);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1).focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0].focus();
    }
  });

  requestAnimationFrame(() => (dialog.querySelector(selector) || dialog).focus());
  const observer = new MutationObserver(() => {
    if (overlay.isConnected) return;
    observer.disconnect();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  });
  observer.observe(document.body, { childList: true });
}

// iOS-style edge-swipe-to-dismiss: a touch starting within a thin strip
// along the screen's left edge (mirroring the OS's own interactive-pop
// gesture, so it never fights normal horizontal scrolling/carousels
// elsewhere in the sheet) that drags mostly rightward closes the sheet;
// dragging mostly vertically is left alone so the sheet's own content can
// still scroll normally. `frameEl` is the element that visually slides
// (translateX); `onDismiss` is called once the close animation finishes.
const SWIPE_EDGE_ZONE = 24;
const SWIPE_DISMISS_DISTANCE = 90;
const SWIPE_DISMISS_VELOCITY = 0.5; // px/ms

export function attachSwipeToDismiss(overlay, frameEl, onDismiss) {
  let tracking = false;
  let direction = null; // null | "horizontal" | "vertical"
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let lastX = 0;
  let lastTime = 0;

  function resetTransform() {
    frameEl.style.transition = "";
    frameEl.style.transform = "";
  }

  overlay.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX > SWIPE_EDGE_ZONE) return;
      tracking = true;
      direction = null;
      startX = lastX = touch.clientX;
      startY = touch.clientY;
      startTime = lastTime = e.timeStamp;
      frameEl.style.transition = "none";
    },
    { passive: true }
  );

  overlay.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (direction === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        direction = Math.abs(dx) > Math.abs(dy) && dx > 0 ? "horizontal" : "vertical";
        if (direction === "vertical") {
          tracking = false;
          resetTransform();
          return;
        }
      }
      if (direction !== "horizontal") return;
      // Now committed to the swipe -- stop the page/content from also
      // scrolling underneath the dragging finger.
      e.preventDefault();
      lastX = touch.clientX;
      lastTime = e.timeStamp;
      frameEl.style.transform = `translateX(${Math.max(0, dx)}px)`;
    },
    { passive: false }
  );

  function finish() {
    if (!tracking) return;
    tracking = false;
    if (direction !== "horizontal") return;
    const dx = lastX - startX;
    const elapsed = Math.max(1, lastTime - startTime);
    const velocity = dx / elapsed;
    frameEl.style.transition = "transform 0.25s ease";
    if (dx > SWIPE_DISMISS_DISTANCE || velocity > SWIPE_DISMISS_VELOCITY) {
      frameEl.style.transform = "translateX(100%)";
      frameEl.addEventListener("transitionend", () => onDismiss(), { once: true });
    } else {
      frameEl.style.transform = "";
    }
  }

  overlay.addEventListener("touchend", finish);
  overlay.addEventListener("touchcancel", () => {
    tracking = false;
    if (direction === "horizontal") resetTransform();
    direction = null;
  });
}

// Gives the project-local ERP suggestion lists full combobox semantics and
// keyboard behavior without changing their filtering/data logic.
export function activateCombobox(input, list, onSelect) {
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");
  let activeIndex = -1;

  function options() {
    const items = [...list.querySelectorAll(".erp-suggest-item")];
    items.forEach((item, index) => {
      item.setAttribute("role", "option");
      item.id ||= `${list.id}-option-${index}`;
      item.setAttribute("aria-selected", String(index === activeIndex));
    });
    input.setAttribute("aria-expanded", String(!list.hidden && items.length > 0));
    return items;
  }

  function choose(item) {
    if (!item) return;
    onSelect(item);
    list.hidden = true;
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  input.addEventListener("keydown", (event) => {
    const items = options();
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + items.length) % items.length;
      items.forEach((item, index) => item.setAttribute("aria-selected", String(index === activeIndex)));
      input.setAttribute("aria-activedescendant", items[activeIndex].id);
      items[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      choose(items[activeIndex]);
    } else if (event.key === "Escape") {
      list.hidden = true;
      activeIndex = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  });

  list.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".erp-suggest-item");
    if (!item) return;
    event.preventDefault();
    choose(item);
  });

  new MutationObserver(options).observe(list, { childList: true, attributes: true, attributeFilter: ["hidden"] });
}

// Downscale + re-encode a photo client-side before upload, to keep uploads
// small on patchy field connections.
export function compressImage(file, { maxDimension = 1600, quality = 0.75 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not compress photo"))),
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read photo"));
    };
    img.src = url;
  });
}
