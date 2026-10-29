// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...systemApi.
import { APP_VERSION } from "../version.js";
import { getCsrfToken, json, request } from "./core.js";

export const systemApi = {
  login: (email, password) => json("/auth/login", "POST", { email, password }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/me"),
  // Backs app.js's periodic (every-60s) badge poll -- one request for all
  // seven Home-tab/nav counts instead of seven separate ones. Event-driven
  // refreshes right after a specific action still use each badge's own
  // single-purpose endpoint below (getOrdersPendingCount etc.), unchanged.
  getBadgeCounts: () => request("/badges"),
  retailDifferences: () => request("/settings/retail-differences", { fresh: true }),
  getSettings: () => request("/settings"),
  updateSettings: async (data) => {
    const result = await json("/settings", "PATCH", data);
    // Admin settings change what Home / the sidebar show: drop stale screens.
    window.dispatchEvent(new Event("app-preferences-changed"));
    return result;
  },
  // Unauthenticated on purpose -- see routes/lockdown.js.
  getLockdownStatus: () => request("/lockdown"),
  engageLockdown: () => json("/lockdown/engage", "POST", {}),
  liftLockdown: () => json("/lockdown/lift", "POST", {}),
  changeMyPassword: (currentPassword, newPassword) =>
    json("/me/password", "PATCH", { current_password: currentPassword, new_password: newPassword }),
  logoutOtherSessions: () => request("/me/logout-other-sessions", { method: "POST" }),
  uploadMyAvatar: (formData) => request("/me/avatar", { method: "POST", body: formData }),
  deleteMyAvatar: () => request("/me/avatar", { method: "DELETE" }),
  saveMySignature: (blob) => {
    const form = new FormData();
    form.set("signature", blob, "signature.png");
    return request("/me/signature", { method: "POST", body: form });
  },
  mySignatureUrl: () => `/api/me/signature?t=${Date.now()}`,
  myAvatarUrl: () => `/api/me/avatar?t=${Date.now()}`,
  // Excel file of a table the client already holds (Sales / Payments export).
  buildXlsx: async (payload) => {
    const res = await fetch("/api/table-export/xlsx", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-App-Version": APP_VERSION, ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  getCompanyProfile: () => request("/company-profile"),
  updateCompanyProfile: (data) => json("/company-profile", "PATCH", data),
  updateMyProfile: (data) => json("/me/profile", "PATCH", data),
  getAdminCounts: () => request("/settings/admin-counts", { fresh: true }),
  getVapidPublicKey: () => request("/push/vapid-public-key"),
  subscribePush: (subscription) => json("/push", "POST", subscription),
  unsubscribePush: (endpoint) => json("/push", "DELETE", { endpoint }),
  getMyNotificationSettings: () => request("/notification-settings/mine"),
  setMyNotificationSetting: (notification_type, enabled) =>
    json("/notification-settings/mine", "PUT", { notification_type, enabled }),
  clearMyNotificationOverride: (type) => request(`/notification-settings/mine/${type}`, { method: "DELETE" }),
  getNotificationDefaults: () => request("/notification-settings"),
  setNotificationDefault: (role, notification_type, enabled) =>
    json("/notification-settings", "PUT", { role, notification_type, enabled }),
  listNotifications: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/notifications${qs ? `?${qs}` : ""}`);
  },
  getUnreadNotificationCount: () => request("/notifications/unread-count"),
  getNotificationDeliveryLog: () => request("/notifications/delivery-log"),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: () => request("/notifications/read-all", { method: "PATCH" }),
  // Admin data-quality dashboard (see server/src/system/routes/dataQuality.js) --
  // admin-only server-side already.
  getDataQuality: () => request("/data-quality"),
  getSystemHealth: () => request("/system-health"),
  // Frontend error monitoring (see errorMonitoring.js) -- fire-and-forget,
  // the caller there never awaits or surfaces a failure from this.
  reportClientError: (report) => json("/client-errors", "POST", { ...report, user_agent: navigator.userAgent }),
  getClientErrorLog: (limit = 100) => request(`/client-errors?limit=${limit}`),
};
