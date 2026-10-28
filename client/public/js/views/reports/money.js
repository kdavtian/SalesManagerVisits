// Reports > payments, cash custody, cash reconciliation and the daily management report (moved out of reports.js with the refactor
// tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { amdWithUnitHtml, channelDisplayLabel, escapeHtml, formatAmd, formatDateDMY, labelColon } from "../../util.js";
import { t } from "../../i18n.js";
import { PERIOD_OPTIONS, formatDate, formatDateOnly, formatDateTime, periodTabsHtml, reportHeaderHtml, selectHtml } from "./common.js";

export const PAYMENT_STATUS_OPTIONS = ["pending", "approved", "rejected"];

export function formatAvgInterval(pgInterval) {
  if (!pgInterval) return "—";
  // node-postgres returns an INTERVAL as {hours, minutes, days, ...} -- keep
  // this to the coarsest unit that's actually informative for an approval
  // turnaround (hours is the practical unit here, not days/weeks).
  const totalHours = (pgInterval.days || 0) * 24 + (pgInterval.hours || 0) + (pgInterval.minutes || 0) / 60;
  return `${totalHours.toFixed(1)}h`;
}

export async function renderPaymentsReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_payments_name")}
      <form id="report-filters" class="report-filter-form">
        ${periodTabsHtml("period", PERIOD_OPTIONS.map((o) => ({ ...o, label: o.labelKey ? t(o.labelKey) : "" })), "month")}
        ${selectHtml(
          "status",
          [{ value: "", label: t("all_payment_statuses") }, ...PAYMENT_STATUS_OPTIONS.map((v) => ({ value: v, label: t(`payment_status_${v}`) }))],
          ""
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    let result;
    try {
      result = await api.getPaymentsReport(params);
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const { kpis, by_channel, by_manager, daily_trend, operations } = result;

    function drillLink(extraParams) {
      const qs = new URLSearchParams({ ...params, ...extraParams }).toString();
      return `#/payments${qs ? `?${qs}` : ""}`;
    }

    const maxDaily = Math.max(1, ...daily_trend.map((d) => Number(d.approved_amd)));

    body.innerHTML = `
      <div class="stat-grid">
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({})}">
          <span class="stat-value">${kpis.submitted_count}</span>
          <span class="stat-label">${t("report_payments_submitted")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.submitted_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "approved" })}">
          <span class="stat-value">${kpis.approved_count}</span>
          <span class="stat-label">${t("report_payments_approved")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.approved_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "pending" })}">
          <span class="stat-value">${kpis.pending_count}</span>
          <span class="stat-label">${t("payment_status_pending")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.pending_amd))}</span>
        </button>
        <button type="button" class="stat-card report-drill-card" data-href="${drillLink({ status: "rejected" })}">
          <span class="stat-value">${kpis.rejected_count}</span>
          <span class="stat-label">${t("payment_status_rejected")}</span>
          <span class="stat-sublabel">${formatAmd(Number(kpis.rejected_amd))}</span>
        </button>
      </div>

      <h2 class="section-title">${t("report_payments_operations")}</h2>
      <div class="card-list">
        <div class="card report-row"><span>${t("report_payments_pending_now")}</span><strong>${operations.pending_count}</strong></div>
        <div class="card report-row"><span>${t("report_payments_pending_over_24h")}</span><strong>${operations.pending_over_24h}</strong></div>
        <div class="card report-row"><span>${t("report_payments_oldest_pending")}</span><strong>${operations.oldest_pending_at ? formatDate(operations.oldest_pending_at) : "—"}</strong></div>
        <div class="card report-row"><span>${t("report_payments_avg_approval_time")}</span><strong>${formatAvgInterval(operations.avg_approval_interval)}</strong></div>
        <div class="card report-row"><span>${t("payment_status_rejected")}</span><strong>${operations.rejected_count}</strong></div>
      </div>

      ${
        daily_trend.length
          ? `<h2 class="section-title">${t("report_payments_daily_trend")}</h2>
        <div class="card trend-chart-card">
          <div class="trend-chart" role="img" aria-label="${t("report_payments_daily_trend")}">
            ${daily_trend
              .map((d) => {
                const heightPct = Math.round((Number(d.approved_amd) / maxDaily) * 100);
                return `<div class="trend-bar" style="height:${Math.max(heightPct, Number(d.approved_amd) > 0 ? 4 : 0)}%" title="${formatDateOnly(d.day)}: ${formatAmd(Number(d.approved_amd))}"></div>`;
              })
              .join("")}
          </div>
        </div>`
          : ""
      }

      <h2 class="section-title">${t("by_channel")}</h2>
      <div class="card-list">
        ${
          by_channel.length
            ? by_channel
                .map(
                  (c) => `
              <button type="button" class="card report-row report-drill-card" data-href="${drillLink({ sales_channel: c.sales_channel === "—" ? "" : c.sales_channel })}">
                <span>${escapeHtml(channelDisplayLabel(c.sales_channel))}</span>
                <strong>${formatAmd(Number(c.approved_amd))}</strong>
              </button>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>

      <h2 class="section-title">${t("by_manager")}</h2>
      <div class="card-list">
        ${
          by_manager.length
            ? by_manager
                .map(
                  (m) => `
              <button type="button" class="card report-row report-drill-card" data-href="${drillLink({ sales_manager_id: m.sales_manager_id })}">
                <span>${escapeHtml(m.sales_manager_name)}</span>
                <strong>${formatAmd(Number(m.approved_amd))}</strong>
              </button>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>
    `;

    body.querySelectorAll(".report-drill-card").forEach((el) => {
      el.addEventListener("click", () => navigate(el.dataset.href));
    });
  }

  form.addEventListener("change", load);
  await load();
}

// No period filter -- unlike every other report here, this is a snapshot
// of custody right now (who's physically holding unreconciled cash this
// second), not a historical query, so "this month" would be meaningless.
export async function renderCashCustodyReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_cash_custody_name")}
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const body = container.querySelector("#report-body");

  try {
    const { by_holder, totals, handoffs, operations } = await api.getCashCustodyReport();
    body.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value stat-value-amd">${amdWithUnitHtml(Number(totals.total_unreconciled_amd))}</span>
          <span class="stat-label">${t("report_cash_custody_total_unreconciled")}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value stat-value-amd">${amdWithUnitHtml(Number(totals.in_transit_amd))}</span>
          <span class="stat-label">${t("report_cash_custody_in_transit")}</span>
        </div>
      </div>

      <h2 class="section-title">${t("report_cash_custody_by_holder")}</h2>
      <div class="card-list">
        ${
          by_holder.length
            ? by_holder
                .map(
                  (h) => `
            <div class="card report-row-multiline">
              <strong>${escapeHtml(h.holder_name)}</strong>
              <span class="muted">${t(`role_${h.holder_role}`)} · ${h.payment_count}${
                    Number(h.in_transit_count) > 0
                      ? ` · <span class="sync-badge-stale">${t("report_cash_custody_holder_in_transit").replace("{n}", h.in_transit_count)}</span>`
                      : ""
                  }</span>
              <span class="muted">${formatAmd(Number(h.amount_amd))}</span>
            </div>`
                )
                .join("")
            : `<p class="empty-state">${t("no_data")}</p>`
        }
      </div>

      <h2 class="section-title">${t("report_cash_custody_handoffs_title")}</h2>
      ${
        Number(operations.pending_over_24h) > 0
          ? `<p class="sync-badge sync-badge-stale">${t("report_cash_custody_handoffs_overdue").replace("{n}", operations.pending_over_24h)}</p>`
          : ""
      }
      <div class="card-list">
        ${
          handoffs.length
            ? handoffs
                .map(
                  (h) => `
            <div class="card report-row-multiline">
              <strong>${escapeHtml(h.from_name)} → ${escapeHtml(h.to_name)}</strong>
              <span class="muted">${formatAmd(Number(h.amount_amd))} · ${t("report_cash_custody_since").replace("{date}", formatDateTime(h.submitted_at))}</span>
            </div>`
                )
                .join("")
            : `<p class="empty-state">${t("report_cash_custody_no_handoffs")}</p>`
        }
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

// Day-by-day history, unlike cash_custody's live snapshot above -- flags
// any day where field-collected cash and same-day payment submissions
// diverge by more than the server's own alert threshold (see
// CASH_RECONCILIATION_ALERT_AMD in routes/reports.js), which is a real
// signal something didn't make it from "collected" to "submitted" (or
// vice versa), not just a rep's collection landing a day later than usual.
export async function renderCashReconciliationReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_cash_reconciliation_name")}
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const body = container.querySelector("#report-body");

  try {
    const { rows, alert_threshold_amd } = await api.getCashReconciliationReport();
    const alertCount = rows.filter((r) => r.alert).length;
    body.innerHTML = `
      ${
        alertCount
          ? `<p class="sync-badge sync-badge-stale">${t("report_cash_reconciliation_alert_summary").replace("{n}", alertCount).replace("{amount}", formatAmd(alert_threshold_amd))}</p>`
          : `<p class="muted">${t("report_cash_reconciliation_no_alerts")}</p>`
      }
      <div class="card-list">
        ${rows
          .map((r) => {
            const diff = Number(r.difference_amd);
            return `
            <div class="card cash-recon-card${diff !== 0 ? " cash-recon-card-diff" : ""}">
              <div class="cash-recon-top">
                <strong>${formatDateDMY(r.day)}</strong>
                <span class="${diff !== 0 ? "cash-recon-diff-amount" : "muted"}">${t("report_cash_reconciliation_difference")}${labelColon()}${diff > 0 ? "+" : ""}${formatAmd(diff)}</span>
              </div>
              <span class="muted">${t("report_cash_reconciliation_collected")}${labelColon()}${formatAmd(Number(r.collected_amd))} · ${t("report_cash_reconciliation_submitted")}${labelColon()}${formatAmd(Number(r.submitted_amd))}</span>
            </div>`;
          })
          .join("")}
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

export function formatUsd(value) {
  if (value == null) return "";
  return `${Number(value).toLocaleString("en-US")} ${t("usd")}`;
}

export function signedAmd(value) {
  if (value == null) return t("no_data");
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${formatAmd(n)}`;
}

export const REPORT_PERIODS = ["daily", "weekly", "monthly", "quarterly", "annual"];

export async function renderDailyManagementReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_daily_management_name")}
      <form id="report-filters" class="report-filter-form">
        ${periodTabsHtml("period", REPORT_PERIODS.map((p) => ({ value: p, label: t(`report_daily_management_period_tab_${p}`) })), "daily")}
        <select name="date"></select>
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const periodSelect = form.querySelector('input[name="period"]');
  const dateSelect = form.querySelector('select[name="date"]');
  const body = container.querySelector("#report-body");

  async function load(explicitDate) {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const period = periodSelect.value;
      const result = await api.getDailyManagementReport(explicitDate ? { date: explicitDate, period } : { period });
      if (!result?.report) {
        dateSelect.innerHTML = "";
        body.innerHTML = `<p class="empty-state">${t("no_data")}</p>`;
        return;
      }
      const { report: r, available_dates } = result;

      if (!explicitDate) {
        dateSelect.innerHTML = available_dates.map((d) => `<option value="${d}" ${d === r.report_date ? "selected" : ""}>${formatDateOnly(d)}</option>`).join("");
      }

      const salesRows = [
        [t("report_daily_management_period_ytd"), r.sales_ytd_amd, r.sales_ytd_liters, r.sales_ytd_orders],
        [t("report_daily_management_period_mtd"), r.sales_mtd_amd, r.sales_mtd_liters, r.sales_mtd_orders],
        [t("report_daily_management_period_wtd"), r.sales_wtd_amd, r.sales_wtd_liters, r.sales_wtd_orders],
        [t("report_daily_management_period_day"), r.sales_day_amd, r.sales_day_liters, r.sales_day_orders],
      ];
      const paymentsRows = [
        [t("report_daily_management_period_ytd"), r.payments_ytd_amd, r.payments_ytd_customers],
        [t("report_daily_management_period_mtd"), r.payments_mtd_amd, r.payments_mtd_customers],
        [t("report_daily_management_period_wtd"), r.payments_wtd_amd, r.payments_wtd_customers],
        [t("report_daily_management_period_day"), r.payments_day_amd, r.payments_day_customers],
      ];

      body.innerHTML = `
        <h2 class="section-title">${t("report_daily_management_sales")}</h2>
        <div class="stat-grid stat-grid-4">
          ${salesRows
            .map(
              ([label, amd, liters, orders]) => `
            <div class="stat-card">
              <span class="stat-value stat-value-amd">${amdWithUnitHtml(amd)}</span>
              <span class="stat-label">${label}</span>
              <span class="muted">${liters != null ? `${Number(liters).toLocaleString("en-US")} L` : "—"} · ${orders != null ? orders : "—"}</span>
            </div>`
            )
            .join("")}
        </div>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_change_prev")}${labelColon()}${signedAmd(r.sales_change_amd)}${r.sales_change_liters != null ? ` · ${r.sales_change_liters > 0 ? "+" : ""}${Number(r.sales_change_liters).toLocaleString("en-US")} L` : ""}</p>
        <p class="muted" style="margin: 0 4px 8px;">${t("report_daily_management_margin")}${labelColon()}${formatAmd(r.sales_margin_amd)}${r.sales_margin_pct != null ? ` (${Number(r.sales_margin_pct).toFixed(1)}%)` : ""}</p>

        <h2 class="section-title">${t("report_daily_management_sales")} · ${t("by_channel")} (${formatDateOnly(r.report_date)})</h2>
        <div class="card-list">
          ${
            r.sales_by_channel.length
              ? r.sales_by_channel
                  .map(
                    (c) => `
              <div class="card report-row">
                <span>${escapeHtml(channelDisplayLabel(c.channel_code))}</span>
                <strong>${formatAmd(c.amd)} · ${c.liters != null ? `${Number(c.liters).toLocaleString("en-US")} L` : "—"} · ${c.orders != null ? c.orders : "—"}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_daily_management_payments")}</h2>
        <div class="stat-grid stat-grid-4">
          ${paymentsRows
            .map(
              ([label, amd, customers]) => `
            <div class="stat-card">
              <span class="stat-value stat-value-amd">${amdWithUnitHtml(amd)}</span>
              <span class="stat-label">${label}</span>
              <span class="muted">${customers != null ? customers : "—"}</span>
            </div>`
            )
            .join("")}
        </div>

        <h2 class="section-title">${t("report_daily_management_payments")} · ${t("by_channel")} (${formatDateOnly(r.report_date)})</h2>
        <div class="card-list">
          ${
            r.payments_by_channel.length
              ? r.payments_by_channel
                  .map(
                    (c) => `
              <div class="card report-row">
                <span>${escapeHtml(channelDisplayLabel(c.channel_code))}</span>
                <strong>${formatAmd(c.amd)} · ${c.customers != null ? c.customers : "—"}</strong>
              </div>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>

        <h2 class="section-title">${t("report_daily_management_balance")}</h2>
        <div class="card-list">
          <p class="list-group-heading">${t("report_daily_management_group_cash")}</p>
          <div class="card report-row"><span>${t("report_daily_management_balance")}</span><strong>${formatAmd(r.balance_amd)}${r.balance_usd != null ? ` (${formatUsd(r.balance_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_total")}</span><strong>${formatAmd(r.balance_total_amd)}${r.balance_total_usd != null ? ` (${formatUsd(r.balance_total_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_cash")}</span><strong>${formatAmd(r.balance_cash_amd)}${r.balance_cash_usd != null ? ` (${formatUsd(r.balance_cash_usd)})` : ""}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_noncash")}</span><strong>${formatAmd(r.balance_noncash_amd)}${r.balance_noncash_usd != null ? ` (${formatUsd(r.balance_noncash_usd)})` : ""}</strong></div>

          <p class="list-group-heading">${t("report_daily_management_with_managers")}</p>
          <div class="card report-row"><span>${t("report_daily_management_total")}</span><strong>${formatAmd(r.balance_with_managers_amd)}</strong></div>
          ${r.balance_with_managers_by_manager
            .map(
              (m) => `
          <div class="card report-row"><span style="padding-left:12px;">${escapeHtml(m.manager_name)}</span><strong>${formatAmd(m.amd)}</strong></div>`
            )
            .join("")}

          <p class="list-group-heading">${t("report_daily_management_group_other")}</p>
          <div class="card report-row"><span>${t("report_daily_management_credit_line")}</span><strong>${formatUsd(r.credit_line_usd)}</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_receivables")}</span><strong>${formatAmd(r.receivables_total_amd)} (${t("report_daily_management_receivables_net")}${labelColon()}${formatAmd(r.receivables_net_amd)})</strong></div>
          <div class="card report-row"><span>${t("report_daily_management_warehouse")}</span><strong>${formatAmd(r.warehouse_value_amd)} · ${r.warehouse_liters != null ? `${Number(r.warehouse_liters).toLocaleString("en-US")} L` : "—"}</strong></div>
        </div>
        ${
          r.prev_report_date
            ? `<p class="muted" style="margin: 8px 4px;">${t("report_daily_management_change_since")} ${formatDateOnly(r.prev_report_date)}: ${t("report_daily_management_total")} ${signedAmd(r.change_total_amd)}, ${t("report_daily_management_overdue")} ${signedAmd(r.change_overdue_amd)}</p>`
            : ""
        }
      `;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  dateSelect.addEventListener("change", () => load(dateSelect.value));
  periodSelect.addEventListener("change", () => load());
  await load();
}
