// Excel -> app sync status for management (owner, 2026-10-24): when the last sync ran, how old the Excel file the bot used is, the last problem, and
// a "Sync now" button that asks the bot to push the workbook it holds again. Used in Administration > System health (the full card) and on the
// admin / CEO Home (one line). A stale feed was invisible before: the app only knew when a sync RAN, not that the file behind it was 4 days old.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, formatDateDMY, formatDateTime, openInfoPopup, showToast } from "./util.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const badge = (ok) => `<span class="badge ${ok ? "badge-success" : "badge-danger"}">${t(ok ? "health_fresh" : "health_stale")}</span>`;

// "today" / "3 days old" from the age in hours
function fileAgeText(hours) {
  if (hours == null) return t("es_file_unknown");
  const days = Math.floor(hours / 24);
  return days < 1 ? t("es_file_today") : t("es_file_days").replace("{n}", days);
}

// true when something needs attention: no sync yet, the sync or the file is older than the limit, or the newest call failed
export function syncNeedsAttention(st) {
  return !st.last_success || st.sync_stale || st.workbook_stale || Boolean(st.last_failure);
}

function row(label, value, extra = "") {
  return `<div class="health-row"><span class="health-label">${escapeHtml(label)}</span><span class="health-value">${value}${extra ? ` ${extra}` : ""}</span></div>`;
}

function cardHtml(st) {
  const last = st.last_success;
  const req = st.request;
  const lastReq =
    req && req.finished_at
      ? row(t("es_last_request"), escapeHtml(formatDateTime(req.finished_at)), `<span class="badge ${req.ok ? "badge-success" : "badge-danger"}">${t(req.ok ? "es_ok" : "es_failed")}</span>`) +
        (req.message ? `<p class="muted health-note">${escapeHtml(req.message)}</p>` : "")
      : "";
  return `
    <h3 class="health-title">${t("es_title")}<button type="button" class="settings-hint-icon" id="es-hint" aria-label="${t("more_info")}">!</button></h3>
    ${row(t("es_last_sync"), last ? escapeHtml(formatDateTime(last.at)) : t("es_never"), badge(!st.sync_stale))}
    ${row(t("es_file"), last?.workbook_modified_at ? escapeHtml(formatDateDMY(last.workbook_modified_at)) : "—", `<span class="muted">${escapeHtml(fileAgeText(st.workbook_age_hours))}</span> ${st.workbook_age_hours == null ? "" : badge(!st.workbook_stale)}`)}
    ${last?.warnings?.length ? row(t("es_skipped"), String(last.warnings.length)) : ""}
    ${st.last_failure ? `<div class="es-problem"><strong>${t("es_problem")}</strong> ${escapeHtml(formatDateTime(st.last_failure.at))}<br>${escapeHtml(st.last_failure.error ?? "")}</div>` : ""}
    ${lastReq}
    <p class="muted health-note" id="es-state" role="status" hidden></p>
    <button type="button" class="btn btn-primary health-update-btn" id="es-sync-now">${t("es_sync_now")}</button>`;
}

// Fills `container` (a .card) and keeps itself current; returns nothing.
export async function renderErpSyncCard(container) {
  container.classList.add("health-card");
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  const paint = (st) => {
    container.innerHTML = cardHtml(st);
    container.querySelector("#es-hint").addEventListener("click", () => openInfoPopup(`<p>${t("es_hint")}</p>`));
    container.querySelector("#es-sync-now").addEventListener("click", () => syncNow(container, paint));
  };
  try {
    paint(await api.getErpSyncStatus());
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

async function syncNow(container, paint) {
  const btn = container.querySelector("#es-sync-now");
  const state = container.querySelector("#es-state");
  const say = (text) => {
    state.textContent = text;
    state.hidden = !text;
  };
  btn.disabled = true;
  say(t("es_waiting"));
  try {
    const { id } = await api.requestErpSync();
    const started = Date.now();
    while (Date.now() - started < 100000) {
      await sleep(3000);
      if (!container.isConnected) return;
      const st = await api.getErpSyncStatus();
      const r = st.request;
      if (r && r.id === id) {
        if (r.finished_at) {
          showToast(t(r.ok ? "es_done_ok" : "es_done_fail").replace("{m}", r.message ?? ""), { ms: 5000 });
          paint(st);
          return;
        }
        if (r.picked_at) say(t("es_running"));
      }
    }
    say(t("es_timeout"));
  } catch (err) {
    say(err.message);
  }
  btn.disabled = false;
}

// One line for the admin's Home screen; taps through to System health (admin only, like the Sync now button).
export async function renderErpSyncHomeLine(slot, navigate) {
  let st;
  try {
    st = await api.getErpSyncStatus();
  } catch {
    return;
  }
  if (!slot.isConnected) return;
  const bad = syncNeedsAttention(st);
  const last = st.last_success;
  const text = last
    ? `${t("es_home_label")}: ${formatDateTime(last.at)}${last.workbook_modified_at ? ` · ${t("es_home_file").replace("{d}", formatDateDMY(last.workbook_modified_at))} (${fileAgeText(st.workbook_age_hours)})` : ""}`
    : `${t("es_home_label")}: ${t("es_never")}`;
  slot.innerHTML = `<button type="button" class="card es-home ${bad ? "es-home-bad" : ""}" aria-label="${escapeHtml(t("es_title"))}"><span class="es-home-dot" aria-hidden="true"></span><span class="es-home-text">${escapeHtml(text)}${st.last_failure ? ` · ${escapeHtml(t("es_failed"))}` : ""}</span><span class="chevron">&#8250;</span></button>`;
  slot.querySelector(".es-home").addEventListener("click", () => navigate("#/settings?section=system-health"));
}
