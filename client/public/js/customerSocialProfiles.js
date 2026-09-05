import { getLang } from "./i18n.js";

const INSTAGRAM_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>`;
const FACEBOOK_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13.8 21v-8h2.7l.4-3h-3.1V8.1c0-.9.25-1.5 1.55-1.5H17V3.9c-.3-.04-1.3-.12-2.5-.12-2.48 0-4.18 1.5-4.18 4.3V10H7.5v3h2.82v8z" fill="currentColor" stroke="none"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

const labels = {
  hy: {
    title: "Սոցիալական էջեր",
    add: "Ավելացնել սոցիալական էջեր",
    edit: "Փոփոխել սոցիալական էջերը",
    instagram: "Instagram",
    facebook: "Facebook",
    save: "Պահպանել",
    cancel: "Չեղարկել",
    saving: "Պահպանվում է…",
    instagramPlaceholder: "@username կամ Instagram հղում",
    facebookPlaceholder: "Facebook username կամ հղում",
  },
  en: {
    title: "Social profiles",
    add: "Add social profiles",
    edit: "Edit social profiles",
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

function openEditor(customerId, data, onSaved) {
  const l = text();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay customer-social-overlay";
  overlay.innerHTML = `
    <div class="sheet customer-social-sheet" role="dialog" aria-modal="true" aria-labelledby="customer-social-title">
      <h2 id="customer-social-title">${escapeAttr(l.title)}</h2>
      <form id="customer-social-form">
        <label>${escapeAttr(l.instagram)}<input name="instagram" inputmode="url" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(l.instagramPlaceholder)}" value="${data.instagram_username ? escapeAttr(`@${data.instagram_username}`) : ""}" /></label>
        <label>${escapeAttr(l.facebook)}<input name="facebook" inputmode="url" autocapitalize="none" autocomplete="off" placeholder="${escapeAttr(l.facebookPlaceholder)}" value="${escapeAttr(data.facebook_url || "")}" /></label>
        <p class="form-error" id="customer-social-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="customer-social-cancel">${escapeAttr(l.cancel)}</button>
          <button type="submit" class="btn btn-primary" id="customer-social-save">${escapeAttr(l.save)}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("#customer-social-form");
  const error = overlay.querySelector("#customer-social-error");
  const save = overlay.querySelector("#customer-social-save");
  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => event.target === overlay && close());
  overlay.querySelector("#customer-social-cancel").addEventListener("click", close);
  requestAnimationFrame(() => form.querySelector("input")?.focus({ preventScroll: true }));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    const original = save.textContent;
    save.textContent = l.saving;
    const fd = new FormData(form);
    try {
      const updated = await apiRequest(`/api/customer-social/${customerId}`, {
        method: "PATCH",
        body: JSON.stringify({ instagram: fd.get("instagram"), facebook: fd.get("facebook") }),
      });
      close();
      onSaved(updated);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      save.disabled = false;
      save.textContent = original;
    }
  });
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

  const l = text();
  let section = actions.querySelector(".customer-social-section");
  if (!section) {
    section = document.createElement("span");
    section.className = "customer-social-section";
    actions.prepend(section);
  }

  function paint(nextData) {
    data = nextData;
    const links = [
      data.instagram_username ? socialButton("instagram", data.instagram_username) : "",
      data.facebook_url ? socialButton("facebook", data.facebook_url) : "",
    ].filter(Boolean).join("");

    // Icon-only, matching the other header-action buttons -- aria-label/title
    // carry the meaning the old full-row text label used to spell out.
    section.innerHTML = `
      ${links}
      ${data.can_edit ? `<button type="button" class="customer-social-edit" aria-label="${escapeAttr(links ? l.edit : l.add)}" title="${escapeAttr(links ? l.edit : l.add)}">${EDIT_ICON}</button>` : ""}`;

    section.querySelectorAll("[data-social-kind]").forEach((button) => {
      button.addEventListener("click", () => openPlatformProfile(button.dataset.socialKind, button.dataset.socialValue));
    });
    section.querySelector(".customer-social-edit")?.addEventListener("click", () => openEditor(customerId, data, paint));
  }

  paint(data);
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
