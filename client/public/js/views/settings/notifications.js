// Settings > notifications: a person's switches and the admin's per-role defaults, reports management (moved out of settings.js with
// the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { state } from "../../state.js";
import { ROLES } from "../../shared/roles.js";
import { notificationGroupsFor } from "../../shared/notificationTypes.js";
import { deskSelectChips } from "../../deskTable.js";
import { ICON, groupTitleRow, settingsToggleRow } from "./rows.js";

export async function loadNotificationPreferences(slot) {
  let prefs;
  try {
    prefs = await api.getMyNotificationSettings();
  } catch {
    slot.innerHTML = "";
    return;
  }

  const byType = new Map(prefs.map((p) => [p.notification_type, p]));
  const groups = notificationGroupsFor(state.user?.role);
  slot.innerHTML = groups
    .map(
      (g) =>
        groupTitleRow(g.key) +
        g.types
          .map((type) => {
            const p = byType.get(type) ?? { enabled: true, is_override: false };
            return settingsToggleRow({
              icon: ICON.bell,
              label: t(`notification_type_${type}`),
              value: p.enabled ? t("toggle_on") : t("toggle_off"),
              id: `notif-pref-${type}`,
              checked: p.enabled,
              resetId: p.is_override ? `notif-pref-reset-${type}` : null,
              color: "red",
            });
          })
          .join("")
    )
    .join("");

  groups.flatMap((g) => g.types).forEach((type) => {
    const toggle = slot.querySelector(`#notif-pref-${type}`);
    const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
    toggle.addEventListener("click", async () => {
      const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
      toggle.disabled = true;
      try {
        await api.setMyNotificationSetting(type, nextEnabled);
        toggle.setAttribute("aria-checked", String(nextEnabled));
        valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        loadNotificationPreferences(slot);
      } catch (err) {
        alert(err.message);
        toggle.disabled = false;
      }
    });

    const resetBtn = slot.querySelector(`#notif-pref-reset-${type}`);
    resetBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      resetBtn.disabled = true;
      try {
        await api.clearMyNotificationOverride(type);
        loadNotificationPreferences(slot);
      } catch (err) {
        alert(err.message);
        resetBtn.disabled = false;
      }
    });
  });
}

export const NOTIFICATION_ROLES = ROLES;

// A role-by-role dropdown instead of one flat 7-role x 4-type grid -- the
// full matrix doesn't fit a phone screen without horizontal scrolling,
// and most admins are only ever adjusting one role at a time anyway.
export async function renderNotificationDefaultsSection(slot) {
  slot.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let matrix;
  try {
    matrix = await api.getNotificationDefaults();
  } catch {
    slot.innerHTML = "";
    return;
  }

  let selectedRole = NOTIFICATION_ROLES[0];

  slot.innerHTML = `
    <p class="muted radius-help">${t("notification_defaults_help")}</p>
    <div class="card" style="margin-bottom:10px;">
      <label>${t("role")}
        <select id="notif-default-role-select">
          ${NOTIFICATION_ROLES.map((r) => `<option value="${r}">${t(`role_${r}`)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="card settings-list" id="notif-default-toggles"></div>
  `;

  deskSelectChips(slot);
  const toggleList = slot.querySelector("#notif-default-toggles");

  function paintRole() {
    const groups = notificationGroupsFor(selectedRole);
    toggleList.innerHTML = groups
      .map(
        (g) =>
          groupTitleRow(g.key) +
          g.types
            .map((type) => {
              const entry = matrix.find((m) => m.role === selectedRole && m.notification_type === type);
              const enabled = entry?.enabled ?? true;
              return settingsToggleRow({
                icon: ICON.bell,
                label: t(`notification_type_${type}`),
                value: enabled ? t("toggle_on") : t("toggle_off"),
                id: `notif-default-${type}`,
                checked: enabled,
                color: "red",
              });
            })
            .join("")
      )
      .join("");

    groups.flatMap((g) => g.types).forEach((type) => {
      const toggle = toggleList.querySelector(`#notif-default-${type}`);
      const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
      toggle.addEventListener("click", async () => {
        const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
        toggle.disabled = true;
        try {
          await api.setNotificationDefault(selectedRole, type, nextEnabled);
          const entry = matrix.find((m) => m.role === selectedRole && m.notification_type === type);
          if (entry) entry.enabled = nextEnabled;
          else matrix.push({ role: selectedRole, notification_type: type, enabled: nextEnabled });
          toggle.setAttribute("aria-checked", String(nextEnabled));
          valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        } catch (err) {
          alert(err.message);
        } finally {
          toggle.disabled = false;
        }
      });
    });
  }

  paintRole();
  slot.querySelector("#notif-default-role-select").addEventListener("change", (e) => {
    selectedRole = e.target.value;
    paintRole();
  });
}

// Which role sees which named report -- a report-by-report dropdown, same
// shape as the notification defaults above. Toggle state comes straight
// from the access matrix endpoint, which already resolves each role's
// current effective state (an explicit override, or the report's own
// code-default when no override exists).
export async function renderReportsManagementSection(slot) {
  slot.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let matrix;
  try {
    matrix = await api.getReportAccessMatrix();
  } catch {
    slot.innerHTML = "";
    return;
  }

  let selectedReport = matrix[0];

  slot.innerHTML = `
    <div class="card" style="margin-bottom:10px;">
      <label>${t("reports")}
        <select id="report-access-select">
          ${matrix.map((r) => `<option value="${r.key}">${t(r.nameKey)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="card settings-list" id="report-access-toggles"></div>
  `;

  deskSelectChips(slot);
  const toggleList = slot.querySelector("#report-access-toggles");

  function paintReport() {
    toggleList.innerHTML = selectedReport.roles
      .map((r) =>
        settingsToggleRow({
          icon: ICON.chart,
          label: t(`role_${r.role}`),
          value: r.enabled ? t("toggle_on") : t("toggle_off"),
          id: `report-access-${r.role}`,
          checked: r.enabled,
        })
      )
      .join("");

    selectedReport.roles.forEach((r) => {
      const toggle = toggleList.querySelector(`#report-access-${r.role}`);
      const valueEl = toggle.closest(".settings-list-row").querySelector(".settings-row-value");
      toggle.addEventListener("click", async () => {
        const nextEnabled = toggle.getAttribute("aria-checked") !== "true";
        toggle.disabled = true;
        try {
          await api.setReportAccess(selectedReport.key, r.role, nextEnabled);
          r.enabled = nextEnabled;
          toggle.setAttribute("aria-checked", String(nextEnabled));
          valueEl.textContent = nextEnabled ? t("toggle_on") : t("toggle_off");
        } catch (err) {
          alert(err.message);
        } finally {
          toggle.disabled = false;
        }
      });
    });
  }

  paintReport();
  slot.querySelector("#report-access-select").addEventListener("change", (e) => {
    selectedReport = matrix.find((r) => r.key === e.target.value);
    paintReport();
  });
}
