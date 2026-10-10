// Admin > System health: what this deployment is actually running, in one place -- the app version
// the server serves vs the one open on this phone, applied migrations, how fresh each ERP feed from
// the bot is, the latest Excel dates and which integrations are configured
// (server/src/routes/systemHealth.js). Answers "Not updated" / "no data today" without SSH.
import { api } from "../api.js";
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY } from "../util.js";
import { checkForUpdateManually } from "../updateBanner.js";

function ago(iso) {
  if (!iso) return t("health_never");
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return t("health_ago_minutes").replace("{n}", mins);
  const hours = Math.round(mins / 60);
  if (hours < 48) return t("health_ago_hours").replace("{n}", hours);
  return t("health_ago_days").replace("{n}", Math.round(hours / 24));
}

function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days} ${t("health_days_short")} ${hours} ${t("health_hours_short")}` : `${hours} ${t("health_hours_short")} ${Math.floor((seconds % 3600) / 60)} ${t("health_min_short")}`;
}

const badge = (ok, okKey, badKey) => `<span class="badge ${ok ? "badge-success" : "badge-danger"}">${t(ok ? okKey : badKey)}</span>`;
const row = (label, value, extra = "") => `
  <div class="health-row">
    <span class="health-label">${escapeHtml(label)}</span>
    <span class="health-value">${value}${extra ? ` ${extra}` : ""}</span>
  </div>`;

export async function renderSystemHealthSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let h;
  try {
    h = await api.getSystemHealth();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const versionsMatch = h.server_version === APP_VERSION;
  const staleSources = h.erp.sources.filter((s) => s.stale).length;

  container.innerHTML = `
    <div class="card health-card">
      <h3 class="health-title">${t("health_versions")}</h3>
      ${row(t("health_phone_version"), escapeHtml(APP_VERSION))}
      ${row(t("health_server_version"), escapeHtml(h.server_version ?? "?"), badge(versionsMatch, "health_match", "health_update_available"))}
      ${row(t("health_cache_version"), escapeHtml(h.cache_version ?? "?"))}
      ${versionsMatch ? "" : `<button type="button" class="btn btn-primary health-update-btn" id="health-update-btn">${t("check_for_updates")}</button>`}
    </div>

    <div class="card health-card">
      <h3 class="health-title">${t("health_database")}</h3>
      ${row(t("health_db_status"), badge(h.database.ok, "health_ok", "health_down"), `<span class="muted">${h.database.latency_ms} ms</span>`)}
      ${row(t("health_migration_latest"), escapeHtml(h.migrations.latest ?? "—"))}
      ${row(t("health_migrations_applied"), String(h.migrations.applied), h.migrations.pending.length ? `<span class="badge badge-danger">${h.migrations.pending.length} ${t("health_pending")}</span>` : "")}
      ${row(t("health_uptime"), uptime(h.uptime_seconds))}
    </div>

    <div class="card health-card">
      <h3 class="health-title">${t("health_erp_feeds")} ${staleSources ? `<span class="badge badge-danger">${staleSources}</span>` : ""}</h3>
      ${h.erp.sources
        .map((s) => row(s.label, escapeHtml(ago(s.synced_at)), badge(!s.stale, "health_fresh", "health_stale")))
        .join("")}
      <p class="muted health-note">${t("health_stale_note").replace("{h}", h.erp.stale_after_hours)}</p>
    </div>

    <div class="card health-card">
      <h3 class="health-title">${t("health_excel_data")}</h3>
      ${row(t("health_latest_order"), h.erp.latest_order_date ? escapeHtml(formatDateDMY(h.erp.latest_order_date)) : "—")}
      ${row(t("health_latest_report"), h.erp.latest_report_date ? escapeHtml(formatDateDMY(h.erp.latest_report_date)) : "—")}
      ${row(t("health_erp_customers"), String(h.erp.erp_customers))}
      ${row(t("health_last_digest"), h.last_debt_digest ? escapeHtml(formatDateDMY(h.last_debt_digest)) : "—")}
    </div>

    <div class="card health-card">
      <h3 class="health-title">${t("health_integrations")}</h3>
      ${row(t("health_push"), badge(h.integrations.push, "health_on", "health_off"))}
      ${row(t("health_telegram"), badge(h.integrations.telegram, "health_on", "health_off"))}
      ${row(t("health_erp_key"), badge(h.integrations.erp_sync_key, "health_on", "health_off"))}
    </div>`;

  container.querySelector("#health-update-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = t("checking_for_updates");
    const { updateFound } = await checkForUpdateManually();
    if (!updateFound) {
      btn.disabled = false;
      btn.textContent = t("up_to_date");
    }
  });
}
