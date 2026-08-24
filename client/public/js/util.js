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

// Deep-link into a turn-by-turn navigation app, preferring Yandex Navi (the
// app field reps actually use), then Google Maps, then falling back to
// Yandex's own web-based route planner -- Yandex has by far the best map
// data for Armenia, so it's a better universal fallback than Apple Maps. With
// no API to ask "is this app installed?", we open the app's custom URL
// scheme and watch whether the tab is backgrounded (the OS switching apps)
// within a short window; if nothing happens we assume it's not installed and
// fall through to the next option.
export function openNavigation(lat, lng) {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function tryScheme(url, onNotInstalled, timeoutMs = 1000) {
    let settled = false;
    function onVisibilityChange() {
      if (document.hidden) settle();
    }
    function settle() {
      if (settled) return;
      settled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(timer);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = setTimeout(() => {
      if (!settled) {
        settle();
        onNotInstalled();
      }
    }, timeoutMs);
    window.location.href = url;
  }

  const yandexUrl = `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`;
  const yandexWebUrl = `https://yandex.com/maps/?rtext=~${lat}%2C${lng}&rtt=auto`;
  const googleWebUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const googleIosSchemeUrl = `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`;

  tryScheme(yandexUrl, () => {
    if (isIOS) {
      tryScheme(googleIosSchemeUrl, () => {
        window.location.href = yandexWebUrl;
      });
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
