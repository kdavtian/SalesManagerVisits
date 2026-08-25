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

export const CATEGORY_OPTIONS = ["Յուղման կետ", "Խանութ", "Ավտոպարկ", "Ավտոսերվիս", "Այլ"];

// Customer relationship tier -- distinct from category (what kind of
// business). potential/competitor have no ERP Customer ID; bronze/silver/
// gold are real accounts, each priced from a different Castrol PriceList
// column (see server products.silver_price_amd / gold_price_amd).
const TIER_ICON = {
  potential: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6"/><path d="M21 21l-5.2-5.2"/></svg>`,
  medal: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="15" r="6"/><path d="M9 10 6 3h3l3 6 3-6h3l-3 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  competitor: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

export const TIER_OPTIONS = [
  { value: "potential", labelKey: "tier_potential", icon: TIER_ICON.potential, cls: "tier-potential" },
  { value: "bronze", labelKey: "tier_bronze", icon: TIER_ICON.medal, cls: "tier-bronze" },
  { value: "silver", labelKey: "tier_silver", icon: TIER_ICON.medal, cls: "tier-silver" },
  { value: "gold", labelKey: "tier_gold", icon: TIER_ICON.medal, cls: "tier-gold" },
  { value: "competitor", labelKey: "tier_competitor", icon: TIER_ICON.competitor, cls: "tier-competitor" },
];

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
