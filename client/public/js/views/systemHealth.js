// Admin > System health: what this deployment is actually running, in one place -- the app version
// the server serves vs the one open on this phone, applied migrations, how fresh each ERP feed from
// the bot is, the latest Excel dates and which integrations are configured
// (server/src/routes/systemHealth.js). Answers "Not updated" / "no data today" without SSH.
import { api } from "../api.js";
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY, openInfoPopup } from "../util.js";
import { checkForUpdateManually } from "../updateBanner.js";
import { renderErpSyncCard } from "../erpSyncCard.js";

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

    ${jobsCardHtml(h.jobs ?? [])}

    <div class="card health-card" id="erp-sync-card"></div>

    <div class="card health-card" id="ai-card"></div>

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

  for (const btn of container.querySelectorAll("[data-job]")) {
    const job = (h.jobs ?? []).find((j) => j.name === btn.dataset.job);
    btn.addEventListener("click", () =>
      openInfoPopup(
        `<h3>${escapeHtml(jobLabel(job.name))}</h3><p>${escapeHtml(job.last_error ?? "")}</p>` +
          `<p class="muted">${escapeHtml(every(job.every_seconds))} · ${escapeHtml(t("health_job_failures").replace("{n}", job.failures))}</p>`
      )
    );
  }
  renderErpSyncCard(container.querySelector("#erp-sync-card"));
  renderAiCard(container.querySelector("#ai-card"));

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

// Background jobs (server/src/jobs/): when each last ran and how; a failed one opens its error and schedule.
const jobLabel = (name) => t(`job_${name.replaceAll("-", "_")}`);
const every = (seconds) => (seconds >= 3600 ? t("health_every_hours").replace("{n}", seconds / 3600) : t("health_every_minutes").replace("{n}", Math.round(seconds / 60)));
function jobsCardHtml(jobs) {
  if (!jobs.length) return "";
  const failed = jobs.filter((j) => j.enabled && j.last_ok === false).length;
  const anyOff = jobs.some((j) => !j.enabled);
  const rowOf = (j) => {
    if (!j.enabled) return row(jobLabel(j.name), `<span class="badge badge-neutral">${t("health_off")}</span>`);
    if (j.last_ok === false) {
      return `<button type="button" class="health-row health-row-btn" data-job="${escapeHtml(j.name)}">
        <span class="health-label">${escapeHtml(jobLabel(j.name))}</span>
        <span class="health-value">${escapeHtml(ago(j.last_finished_at))} <span class="badge badge-danger">${t("health_job_failed")} !</span></span>
      </button>`;
    }
    if (!j.last_finished_at) return row(jobLabel(j.name), `<span class="muted">—</span>`); // not run yet
    return row(jobLabel(j.name), escapeHtml(ago(j.last_finished_at)), `<span class="badge badge-success">${t("health_ok")}</span>`);
  };
  return `<div class="card health-card">
      <h3 class="health-title">${t("health_jobs")} ${failed ? `<span class="badge badge-danger">${failed}</span>` : ""}</h3>
      ${jobs.map(rowOf).join("")}
      <p class="muted health-note">${t("health_jobs_note")}${anyOff ? ` ${t("health_job_off_push")}` : ""}</p>
    </div>`;
}

const AI_TEST_CODES = ["not_configured", "key_rejected", "no_credit", "rate_limit", "model_not_found", "unreachable", "busy", "ai_error"];

// KAD AI (Ask KAD): is the key on the server, which model, this month's spend, and a "Test connection" button that makes one tiny call and says in plain
// words what is wrong (no key, key rejected, no credit, wrong model, slow network).
async function renderAiCard(card) {
  card.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let st;
  try {
    st = await api.askKadStatus();
  } catch (err) {
    card.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  card.innerHTML = `
    <h3 class="health-title">${t("ai_card_title")}</h3>
    ${row(t("ai_key"), badge(st.configured, "health_on", "health_off"))}
    ${row(t("ai_model"), escapeHtml(st.model ?? "?"))}
    ${row(t("ai_spend"), `${st.spent_usd} / ${st.cap_usd} USD`, st.enabled ? "" : `<span class="badge badge-neutral">${t("health_off")}</span>`)}
    <p class="muted health-note" id="ai-result" role="status" hidden></p>
    <button type="button" class="btn btn-primary health-update-btn" id="ai-test-btn">${t("ai_test")}</button>`;
  const btn = card.querySelector("#ai-test-btn");
  const result = card.querySelector("#ai-result");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    result.hidden = false;
    result.className = "muted health-note";
    result.textContent = t("ai_testing");
    try {
      const r = await api.testAskKad();
      result.className = `health-note ${r.ok ? "ai-result-ok" : "ai-result-bad"}`;
      result.textContent = r.ok ? t("ai_test_ok").replace("{model}", r.model).replace("{ms}", r.ms) : `${t(AI_TEST_CODES.includes(r.code) ? `ai_test_${r.code}` : "ai_test_ai_error")}${r.detail ? ` (${r.detail})` : ""}`;
    } catch (err) {
      result.className = "health-note ai-result-bad";
      result.textContent = err.message;
    }
    btn.disabled = false;
  });
}

