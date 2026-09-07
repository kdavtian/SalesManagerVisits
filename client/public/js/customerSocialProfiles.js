import { getLang, t } from "./i18n.js";

const INSTAGRAM_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>`;
const FACEBOOK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13.8 21v-8h2.7l.4-3h-3.1V8.1c0-.9.25-1.5 1.55-1.5H17V3.9c-.3-.04-1.3-.12-2.5-.12-2.48 0-4.18 1.5-4.18 4.3V10H7.5v3h2.82v8z" fill="currentColor" stroke="none"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const MAIL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.8 7 7.3 5.2a1.5 1.5 0 0 0 1.8 0L20.2 7"/></svg>`;
const GLOBE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"/></svg>`;

const labels = {
  hy: {
    title: "Կոնտակտներ և սոցիալական էջեր",
    add: "Ավելացնել կոնտակտներ և սոցիալական էջեր",
    edit: "Փոփոխել կոնտակտները և սոցիալական էջերը",
    instagram: "Instagram",
    facebook: "Facebook",
    save: "Պահպանել",
    cancel: "Չեղարկել",
    saving: "Պահպանվում է…",
    instagramPlaceholder: "@username կամ Instagram հղում",
    facebookPlaceholder: "Facebook username կամ հղում",
  },
  en: {
    title: "Contact & social profiles",
    add: "Add contact & social profiles",
    edit: "Edit contact & social profiles",
    instagram: "Instagram",
    facebook: "Facebook",
    save: "Save",
    cancel: "Cancel",
    saving: "Saving…",
    instagramPlaceholder: "@username or Instagram profile URL",
    facebookPlaceholder: "Facebook username or profile URL",
  },
};

function text() {
  return labels[getLang() === "hy" ? "hy" : "en"];
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function customerIdFromHash() {
  const match = location.hash.match(/^#\/customers\/(\d+)(?:$|[/?])/);
  return match ? Number(match[1]) : null;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function instagramWeb(username) {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

function normalizedFacebookWeb(value) {
  try {
    const url = new URL(value);
    return url.href;
  } catch {
    return `https://www.facebook.com/${encodeURIComponent(value.replace(/^@/, ""))}`;
  }
}

function openPlatformProfile(kind, value) {
  const webUrl = kind === "instagram" ? instagramWeb(value) : normalizedFacebookWeb(value);
  const appUrl = kind === "instagram"
    ? `instagram://user?username=${encodeURIComponent(value)}`
    : `fb://facewebmodal/f?href=${encodeURIComponent(webUrl)}`;

  let fallbackTimer;
  const cancelFallback = () => {
    if (document.visibilityState === "hidden") clearTimeout(fallbackTimer);
  };
  document.addEventListener("visibilitychange", cancelFallback, { once: true });
  fallbackTimer = setTimeout(() => {
    if (document.visibilityState === "visible") window.open(webUrl, "_blank", "noopener,noreferrer");
  }, 700);

  window.location.href = appUrl;
}

function socialButton(kind, value) {
  const isInstagram = kind === "instagram";
  const icon = isInstagram ? INSTAGRAM_ICON : FACEBOOK_ICON;
  const label = isInstagram ? "Instagram" : "Facebook";
  return `<button type="button" class="customer-social-link customer-social-${kind}" data-social-kind="${kind}" data-social-value="${escapeAttr(value)}" aria-label="${label}" title="${label}">${icon}</button>`;
}

// Email and website are plain links rather than the app-then-web dance the
// Instagram/Facebook buttons do -- there is no app to try first, the OS
// already knows what to do with a mailto:/https: URL. They still render as
// the same icon-sized control so the row reads as one set.
function linkButton(kind, href, icon, label) {
  const target = kind === "email" ? "" : ` target="_blank" rel="noopener noreferrer"`;
  return `<a class="customer-social-link customer-social-${kind}" href="${escapeAttr(href)}"${target} aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${icon}</a>`;
}

function websiteHref(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// --- Shared with customerDetail.js's merged edit sheet (item 8) ----------
// Editing contact & social profiles used to be its own sheet, opened from
// the header's overflow menu. That menu is gone now -- these fields are a
// section inside customerDetail.js's one "Edit" sheet instead -- so what
// this module exports is just the section's markup/read/save, not a whole
// standalone dialog. The one-tap external links row below (paint/
// decorateCustomerDetail) is unrelated and unchanged.
export async function fetchCustomerSocial(customerId) {
  return apiRequest(`/api/customer-social/${customerId}`);
}

export async function saveCustomerSocial(customerId, payload) {
  return apiRequest(`/api/customer-social/${customerId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export function socialFieldsHtml(data) {
  const l = text();
  return `
    <p class="proposed-changes-label">${escapeAttr(l.title)}</p>
    <label>${escapeAttr(l.instagram)}<input name="instagram" inputmode="url" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(l.instagramPlaceholder)}" value="${data.instagram_username ? escapeAttr(`@${data.instagram_username}`) : ""}" /></label>
    <label>${escapeAttr(l.facebook)}<input name="facebook" inputmode="url" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(l.facebookPlaceholder)}" value="${escapeAttr(data.facebook_url || "")}" /></label>
    <label>${escapeAttr(t("customer_email"))}<input name="email" type="email" inputmode="email" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(t("customer_email_placeholder"))}" value="${escapeAttr(data.email || "")}" /></label>
    <label>${escapeAttr(t("customer_website"))}<input name="website" inputmode="url" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(t("customer_website_placeholder"))}" value="${escapeAttr(data.website || "")}" /></label>
  `;
}

export function collectSocialPayload(form) {
  const fd = new FormData(form);
  return {
    instagram: fd.get("instagram"),
    facebook: fd.get("facebook"),
    email: fd.get("email"),
    website: fd.get("website"),
  };
}

let renderToken = 0;
async function decorateCustomerDetail() {
  const customerId = customerIdFromHash();
  if (!customerId) return;
  // Lives inline in the header's icon-action row now, next to
  // reassign/assign-ERP/edit -- a full-width "Social profiles" row in the
  // facts card was consuming a whole row for what is, most of the time,
  // zero or one icon.
  const actions = document.querySelector(".detail-view .detail-header-actions");
  if (!actions || actions.dataset.socialProfilesReady === String(customerId)) return;
  actions.dataset.socialProfilesReady = String(customerId);
  const token = ++renderToken;

  let data;
  try {
    data = await apiRequest(`/api/customer-social/${customerId}`);
  } catch {
    delete actions.dataset.socialProfilesReady;
    return;
  }
  if (token !== renderToken || customerIdFromHash() !== customerId || !actions.isConnected) return;

  let section = actions.querySelector(".customer-social-section");
  if (!section) {
    section = document.createElement("span");
    section.className = "customer-social-section";
    actions.prepend(section);
  }

  // One-tap external links only -- these cost nothing to keep visible
  // because they just hand off to another app/tab. Editing these fields
  // happens inside customerDetail.js's merged "Edit" sheet (item 8) via
  // the fetchCustomerSocial/socialFieldsHtml/collectSocialPayload/
  // saveCustomerSocial exports above, not here.
  const links = [
    data.instagram_username ? socialButton("instagram", data.instagram_username) : "",
    data.facebook_url ? socialButton("facebook", data.facebook_url) : "",
    data.email ? linkButton("email", `mailto:${data.email}`, MAIL_ICON, `${t("customer_email")}: ${data.email}`) : "",
    data.website ? linkButton("website", websiteHref(data.website), GLOBE_ICON, `${t("customer_website")}: ${data.website}`) : "",
  ].filter(Boolean).join("");

  section.innerHTML = links;
  section.querySelectorAll("[data-social-kind]").forEach((button) => {
    button.addEventListener("click", () => openPlatformProfile(button.dataset.socialKind, button.dataset.socialValue));
  });
}

function boot() {
  decorateCustomerDetail();
  const app = document.querySelector("#app");
  if (!app) return;
  const observer = new MutationObserver(() => requestAnimationFrame(decorateCustomerDetail));
  observer.observe(app, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => {
    renderToken += 1;
    requestAnimationFrame(decorateCustomerDetail);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
