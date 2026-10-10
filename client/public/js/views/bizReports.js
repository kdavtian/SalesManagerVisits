// Weekly scorecard per sales rep and the new-customer pipeline (server: scorecard.js,
// routes/bizReports.js). Both are plain read-only report pages.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateDMY } from "../util.js";
import { t } from "../i18n.js";
import { dueChipHtml } from "../debtChip.js";

const BACK_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;

function shell(root, navigate, titleKey, extra = "") {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">${BACK_SVG}</button>
        <div class="detail-header-title"><h1>${t(titleKey)}</h1></div>
      </div>
      ${extra}
      <div id="biz-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  return root.querySelector("#biz-body");
}

const shiftDays = (dateStr, days) => new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

function metric(label, value, sub = "") {
  return `<div style="min-width:46%;flex:1"><div class="muted" style="font-size:0.8em">${label}</div><div style="font-weight:600;font-size:1.05em">${value}</div>${sub ? `<div class="muted" style="font-size:0.8em">${sub}</div>` : ""}</div>`;
}

export async function renderWeeklyScorecard(root, navigate) {
  let week = new Date().toISOString().slice(0, 10);
  const controls = `
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0">
      <button type="button" class="icon-btn" id="week-prev" aria-label="${t("scorecard_prev_week")}">&lsaquo;</button>
      <strong id="week-label" style="flex:1;text-align:center"></strong>
      <button type="button" class="icon-btn" id="week-next" aria-label="${t("scorecard_next_week")}">&rsaquo;</button>
    </div>`;
  const body = shell(root, navigate, "report_weekly_scorecard_name", controls);
  const label = root.querySelector("#week-label");

  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const card = await api.getScorecard(week);
      label.textContent = `${formatDateDMY(card.from)} – ${formatDateDMY(card.to)}`;
      if (!card.reps.length) {
        body.innerHTML = `<p class="muted">${t("scorecard_none")}</p>`;
        return;
      }
      body.innerHTML = card.reps
        .map((r) => {
          const conv = r.conversion_pct === null ? "—" : `${r.conversion_pct}%`;
          return `
        <div class="card" style="margin-bottom:12px">
          <strong>${escapeHtml(r.name)}</strong>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
            ${metric(t("scorecard_visits"), r.visits, `${r.customers_visited} ${t("scorecard_customers")}`)}
            ${metric(t("scorecard_conversion"), conv, t("scorecard_conversion_hint"))}
            ${metric(t("scorecard_orders"), r.orders, formatAmd(r.orders_amd))}
            ${metric(t("scorecard_collected"), formatAmd(r.collected_amd))}
            ${metric(t("scorecard_visit_length"), r.avg_visit_minutes == null ? "—" : `${r.avg_visit_minutes} ${t("scorecard_min")}`)}
            ${metric(t("scorecard_debt_tasks"), `${r.debt_tasks_open} ${t("scorecard_open")}`, `${t("scorecard_paid")} ${r.debt_paid} · ${t("scorecard_promised")} ${r.debt_promised} · ${t("scorecard_failed")} ${r.debt_failed}`)}
          </div>
        </div>`;
        })
        .join("");
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  root.querySelector("#week-prev").addEventListener("click", () => {
    week = shiftDays(week, -7);
    load();
  });
  root.querySelector("#week-next").addEventListener("click", () => {
    week = shiftDays(week, 7);
    load();
  });
  load();
}

export async function renderCustomerPipeline(root, navigate) {
  const body = shell(root, navigate, "report_customer_pipeline_name");
  try {
    const { waiting, funnel } = await api.getCustomerPipeline();
    const pct = (n) => (funnel.created ? `${Math.round((n / funnel.created) * 100)}%` : "—");
    body.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <strong>${t("pipeline_funnel_title")}</strong>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
          ${metric(t("pipeline_created"), funnel.created)}
          ${metric(t("pipeline_with_erp"), funnel.with_erp_id, pct(funnel.with_erp_id))}
          ${metric(t("pipeline_ordered"), funnel.ordered, pct(funnel.ordered))}
        </div>
      </div>
      <h3 class="list-group-heading">${t("pipeline_waiting_title")} (${waiting.length})</h3>
      ${
        waiting.length
          ? waiting
              .map(
                (c) => `
        <button type="button" class="card" data-customer="${c.id}" style="display:block;width:100%;text-align:left;min-height:44px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <strong>${escapeHtml(c.name)}</strong>
            <span class="badge ${c.age_days >= 3 ? "badge-danger" : "badge-neutral"}">${c.age_days} ${t("pipeline_days")}</span>
          </div>
          <div class="muted" style="font-size:0.85em">${[c.manager_name, c.created_by_name, c.region].filter(Boolean).map(escapeHtml).join(" · ")}</div>
          ${c.draft_orders ? `<div style="font-size:0.85em">${t("pipeline_draft_orders")}: ${c.draft_orders} · ${formatAmd(c.draft_amd)}</div>` : ""}
        </button>`
              )
              .join("")
          : `<p class="muted">${t("pipeline_none")}</p>`
      }`;
    body.querySelectorAll("[data-customer]").forEach((el) => el.addEventListener("click", () => navigate(`#/customers/${el.dataset.customer}`)));
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

const fmtHours = (h) => {
  if (h === null || h === undefined) return "—";
  return h >= 48 ? `${Math.round(h / 24)} ${t("delivery_days")}` : `${Math.round(h * 10) / 10} ${t("delivery_hours")}`;
};

export async function renderDeliverySpeed(root, navigate) {
  let days = 30;
  const chips = `
    <div class="chip-row" id="delivery-days" style="display:flex;gap:8px;margin:8px 0">
      ${[7, 30, 90].map((d) => `<button type="button" class="chip ${d === days ? "chip-active" : ""}" data-days="${d}" style="min-height:44px">${d} ${t("delivery_days")}</button>`).join("")}
    </div>`;
  const body = shell(root, navigate, "report_delivery_speed_name", chips);
  async function load() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      const r = await api.getDeliverySpeed(days);
      body.innerHTML = `
        <div class="card" style="margin-bottom:12px">
          <strong>${r.delivered} ${t("delivery_delivered_orders")}</strong>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
            ${metric(t("delivery_confirm_to_pack"), fmtHours(r.pack.avg), `${t("delivery_median")} ${fmtHours(r.pack.median)}`)}
            ${metric(t("delivery_pack_to_delivered_hand"), fmtHours(r.deliver_by_hand.avg), `${r.deliver_by_hand.n} ${t("delivery_orders")}`)}
            ${metric(t("delivery_pack_to_delivered_excel"), fmtHours(r.deliver_from_excel.avg), `${r.deliver_from_excel.n} ${t("delivery_orders")}`)}
            ${metric(t("delivery_total"), fmtHours(r.total.avg), `${t("delivery_median")} ${fmtHours(r.total.median)}`)}
            ${metric(t("delivery_within_24h"), r.within_24h_pct === null ? "—" : `${r.within_24h_pct}%`)}
            ${metric(t("delivery_within_48h"), r.within_48h_pct === null ? "—" : `${r.within_48h_pct}%`)}
          </div>
          <p class="muted" style="font-size:0.8em;margin:8px 0 0">${t("delivery_excel_note")}</p>
        </div>
        <h3 class="list-group-heading">${t("delivery_waiting_now")}</h3>
        ${
          r.open.length
            ? r.open
                .map(
                  (o) => `<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><strong>${escapeHtml(o.customer_name)}</strong><span class="badge ${o.waiting_hours >= 24 ? "badge-danger" : "badge-neutral"}">${fmtHours(o.waiting_hours)}</span></div><div class="muted" style="font-size:0.85em">${o.order_code ? escapeHtml(o.order_code) + " · " : ""}${t(o.status === "confirmed" ? "delivery_waiting_pack" : "delivery_waiting_delivery")}</div></div>`
                )
                .join("")
            : `<p class="muted">${t("delivery_nothing_waiting")}</p>`
        }
        <h3 class="list-group-heading">${t("delivery_slowest")}</h3>
        ${
          r.slowest.length
            ? r.slowest
                .map(
                  (o) => `<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><strong>${escapeHtml(o.customer_name)}</strong><span class="badge badge-neutral">${fmtHours(o.total_hours)}</span></div><div class="muted" style="font-size:0.85em">${o.order_code ? escapeHtml(o.order_code) + " · " : ""}${o.from_excel ? t("delivery_from_excel") : t("delivery_by_hand")}</div></div>`
                )
                .join("")
            : `<p class="muted">${t("delivery_none")}</p>`
        }`;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  root.querySelectorAll("[data-days]").forEach((btn) =>
    btn.addEventListener("click", () => {
      days = Number(btn.dataset.days);
      root.querySelectorAll("[data-days]").forEach((b) => b.classList.toggle("chip-active", b === btn));
      load();
    })
  );
  load();
}

// Unpaid invoices (FIFO): every order still (partly) unpaid, oldest first. Tap an aging row to
// filter, search by customer / order / manager.
export async function renderUnpaidInvoices(root, navigate) {
  const selected = new Set();
  let q = "";
  const body = shell(
    root,
    navigate,
    "report_unpaid_invoices_name",
    `<div class="activity-search-combined" style="margin:8px 0"><input type="search" id="unpaid-search" placeholder="${escapeHtml(t("unpaid_invoices_search"))}" aria-label="${escapeHtml(t("unpaid_invoices_search"))}" /></div>`
  );
  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const params = {};
      if (q) params.q = q;
      if (selected.size) params.bucket = [...selected].join(",");
      const r = await api.getUnpaidInvoices(params);
      if (mine !== seq) return;
      body.innerHTML = `
        <div class="card-list" id="unpaid-buckets">
          ${r.summary
            .map(
              (b) => `<button type="button" class="card report-row report-bucket-btn ${selected.has(b.bucket) ? "report-bucket-active" : ""}" data-bucket="${b.bucket}" aria-pressed="${selected.has(b.bucket)}">
                <span>${escapeHtml(t(`debt_bucket_${b.bucket}`))}</span>
                <strong class="report-row-amount">${formatAmd(b.amount_amd)} <span class="muted">(${b.invoices})</span></strong>
              </button>`
            )
            .join("")}
        </div>
        <div class="activity-count">${r.count} ${t("unpaid_invoices_count")} · ${formatAmd(r.total_unpaid_amd)}</div>
        <div class="card-list" id="unpaid-list">
          ${
            r.rows.length
              ? r.rows
                  .map(
                    (o) => `<button type="button" class="card sales-order-card ${o.due_days > 0 ? "unpaid-row-overdue" : "unpaid-row-due"}" data-customer-id="${o.customer_id}">
                      <div class="sales-order-row">
                        <span class="muted">${escapeHtml(o.order_id ?? t("unpaid_invoices_opening_note"))} · ${escapeHtml(formatDateDMY(o.order_date))}</span>
                        <span class="text-amount sales-order-amount">${formatAmd(o.unpaid_amd)}</span>
                      </div>
                      <div class="sales-order-name-row">
                        <strong>${escapeHtml(o.customer_name || "")}</strong>
                        ${dueChipHtml(o.due_days)}
                      </div>
                      ${o.manager_name ? `<span class="muted" style="font-size:0.8em">${escapeHtml(o.manager_name)}</span>` : ""}
                    </button>`
                  )
                  .join("")
              : `<p class="empty-state">${t("no_data")}</p>`
          }
        </div>
        ${r.truncated ? `<p class="muted" style="font-size:0.85em;margin:8px 4px">${t("unpaid_invoices_more")}</p>` : ""}`;
      body.querySelectorAll("[data-bucket]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const b = btn.dataset.bucket;
          if (selected.has(b)) selected.delete(b);
          else selected.add(b);
          load();
        })
      );
      body.querySelectorAll("[data-customer-id]").forEach((btn) => btn.addEventListener("click", () => navigate(`#/customers/${btn.dataset.customerId}/orders`)));
    } catch (err) {
      if (mine === seq) body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
  let timer;
  root.querySelector("#unpaid-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = e.target.value.trim();
      load();
    }, 250);
  });
  load();
}
