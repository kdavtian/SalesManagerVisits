// Payments tab of the Sales page: customer payments from the Excel Cashflow
// sheet (only "Oil order" customer-payment rows). Built like the Sales tab --
// From/To pills, channel pills with counts, one search box, day groups with
// totals -- plus a Region filter and the Excel export (via the page header).
import { api } from "../api.js";
import { escapeHtml, openInfoPopup, formatAmd, channelDisplayLabel, syncBadgeHtml, parseDateOnly, regionLabelHy } from "../util.js";
import { t, getLang } from "../i18n.js";
import { openTriStateTreeSheet, buildRegionSubregionTree } from "../regionTree.js";

function dateInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dayHeading(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  return `${d.getDate()} ${d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" })}`;
}
function dateCaption(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  return `${dayHeading(dateOnly)} ${d.getFullYear()}`;
}

export async function renderPaymentsTab(root, navigate) {
  const now = new Date();
  let from = dateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  let to = dateInput(now);
  let channels = new Set();
  let regionKeys = new Set();
  let query = "";
  let facets = { sales_channels: [], regions: [] };
  let channelPills = [{ value: "", label: t("all_statuses"), count: 0 }];
  let lastRows = [];
  let searchTimer;
  let loadSeq = 0;

  root.innerHTML = `
    <div id="pay-sync-hint-text" hidden>
      <div id="pay-sync-badge"></div>
      <p class="muted sales-source-hint">${t("sales_payments_source_hint")}</p>
    </div>
    <div class="pill-date-filter-row">
      <div class="pill-date-filter-wrap">
        <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true">
          <span class="pill-date-filter-caption">${t("date_from")}</span>
          <span class="pill-date-filter-value" id="pay-from-value">${dateCaption(from)}</span>
        </button>
        <input type="date" class="pill-date-picker-input" id="pay-from" value="${from}" aria-label="${t("date_from")}" />
      </div>
      <div class="pill-date-filter-wrap">
        <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true">
          <span class="pill-date-filter-caption">${t("date_to")}</span>
          <span class="pill-date-filter-value" id="pay-to-value">${dateCaption(to)}</span>
        </button>
        <input type="date" class="pill-date-picker-input" id="pay-to" value="${to}" aria-label="${t("date_to")}" />
      </div>
    </div>
    <div class="customer-stats-bar sales-channel-bar" id="pay-channel-bar" aria-label="${escapeHtml(t("sales_channel_filter"))}"></div>
    <div class="list-toolbar">
      <label class="visually-hidden" for="pay-search">${t("report_erp_payments_search")}</label>
      <input type="search" id="pay-search" placeholder="${t("report_erp_payments_search")}" aria-label="${t("report_erp_payments_search")}" />
      <button type="button" class="map-filter-chip" id="pay-regions-btn">${t("report_erp_payments_regions")}</button>
    </div>
    <p class="form-error" id="pay-error" hidden></p>
    <div class="sales-subtotal-row">
      <button type="button" class="settings-hint-icon" id="pay-sync-hint-btn" aria-label="${t("more_info")}">!</button>
      <p class="sales-subtotal-bar" id="pay-subtotal"></p>
    </div>
    <div id="pay-list" class="card-list"></div>
  `;
  const $ = (sel) => root.querySelector(sel);
  const listEl = $("#pay-list");
  const errorEl = $("#pay-error");
  const subtotalEl = $("#pay-subtotal");
  const hintEl = $("#pay-sync-hint-text");
  const regionsBtn = $("#pay-regions-btn");

  function renderChannelBar() {
    const bar = $("#pay-channel-bar");
    bar.innerHTML = channelPills
      .map((p) => {
        const active = p.value === "" ? channels.size === 0 : channels.has(p.value);
        return `<button type="button" class="stat-pill ${active ? "stat-pill-active" : ""}" data-channel="${escapeHtml(p.value)}" aria-pressed="${active}"><strong>${p.count}</strong><span>${escapeHtml(p.label)}</span></button>`;
      })
      .join("");
    bar.querySelectorAll(".stat-pill").forEach((btn) =>
      btn.addEventListener("click", () => {
        const v = btn.dataset.channel;
        if (v === "") channels = new Set();
        else if (channels.has(v)) channels.delete(v);
        else channels.add(v);
        load();
      })
    );
  }

  function params(withChannels = true) {
    const p = { from, to };
    if (query) p.q = query;
    if (withChannels && channels.size) p.sales_channel = [...channels].join(",");
    if (regionKeys.size) p.region_sub = [...regionKeys].join(",");
    return p;
  }

  function render(data) {
    const rows = data.rows;
    if (!rows.length) {
      subtotalEl.textContent = "";
      listEl.innerHTML = `<p class="empty-state">${t("no_data")}</p>`;
      return;
    }
    subtotalEl.textContent = `${t("sales_subtotal")}: ${formatAmd(Number(data.totals.total_amd))} (${data.totals.payment_count} ${t("report_erp_payments_count")})`;
    const days = new Map();
    for (const r of rows) {
      const d = days.get(r.date) ?? { total: 0, count: 0 };
      d.total += Number(r.amount_amd || 0);
      d.count += 1;
      days.set(r.date, d);
    }
    let last = null;
    const truncated = data.truncated ? `<p class="muted">${t("report_erp_payments_truncated").replace("{n}", rows.length)}</p>` : "";
    listEl.innerHTML =
      truncated +
      rows
        .map((r) => {
          let heading = "";
          if (r.date !== last) {
            last = r.date;
            const d = days.get(r.date);
            heading = `<div class="order-date-heading"><span class="order-date-heading-label">${dayHeading(r.date)}</span><span class="order-date-heading-stats">${formatAmd(d.total)} | ${d.count} ${t("report_erp_payments_count")}</span></div>`;
          }
          const place = r.region ? `${regionLabelHy(r.region)}${r.subregion ? `, ${r.subregion}` : ""}` : "";
          return `${heading}
            <div class="card sales-order-card erp-pay-row">
              <div class="sales-order-row">
                <span class="muted">${[r.erp_customer_id, r.sales_channel ? channelDisplayLabel(r.sales_channel) : "", place].filter(Boolean).map(escapeHtml).join(" · ")}</span>
                <span class="text-amount sales-order-amount">${formatAmd(Number(r.amount_amd))}</span>
              </div>
              <strong>${escapeHtml(r.customer_name || "")}</strong>
            </div>`;
        })
        .join("");
  }

  async function load() {
    const mine = ++loadSeq;
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    regionsBtn.textContent = regionKeys.size ? `${t("report_erp_payments_regions")} (${regionKeys.size})` : t("report_erp_payments_regions");
    regionsBtn.classList.toggle("chip-active", regionKeys.size > 0);
    try {
      const data = await api.getErpPaymentsReport(params());
      if (mine !== loadSeq) return;
      facets = data.facets;
      lastRows = data.rows;
      $("#pay-sync-badge").innerHTML = data.sync ? syncBadgeHtml(data.sync) : "";
      // Pill counts always come from the same filters minus the channel one,
      // so choosing a channel does not zero out the other pills.
      const counted = channels.size ? await api.getErpPaymentsReport(params(false)) : data;
      if (mine !== loadSeq) return;
      const counts = new Map();
      for (const r of counted.rows) if (r.sales_channel) counts.set(r.sales_channel, (counts.get(r.sales_channel) || 0) + 1);
      channelPills = [
        { value: "", label: t("all_statuses"), count: counted.rows.length },
        ...[...counts.entries()].map(([code, count]) => ({ value: code, label: channelDisplayLabel(code), count })).sort((a, b) => b.count - a.count),
      ];
      renderChannelBar();
      render(data);
    } catch (err) {
      if (mine !== loadSeq) return;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
      subtotalEl.textContent = "";
    }
  }

  for (const [id, key] of [["#pay-from", "from"], ["#pay-to", "to"]]) {
    $(id).addEventListener("change", (e) => {
      const v = e.target.value || (key === "from" ? from : to);
      if (key === "from") from = v;
      else to = v;
      $(`${id}-value`).textContent = dateCaption(v);
      load();
    });
  }
  $("#pay-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = e.target.value.trim();
      load();
    }, 300);
  });
  regionsBtn.addEventListener("click", () => {
    openTriStateTreeSheet(t("report_erp_payments_regions"), {
      tree: buildRegionSubregionTree(facets.regions),
      initialSelectedIds: regionKeys,
      countUnitLabel: t("perf_dq_customers_unit"),
      onApply: (selected) => {
        regionKeys = new Set([...selected].map(String));
        load();
      },
    });
  });

  load();

  const hintBtn = $("#pay-sync-hint-btn");
  hintBtn.addEventListener("click", () => openInfoPopup(hintEl.innerHTML));

  return {
    getExport: () => ({
      filename: `payments-${from}_${to}`,
      sheet: t("payments_title"),
      columns: [
        { header: t("xl_date"), width: 12 },
        { header: t("xl_amount"), type: "number", width: 14 },
        { header: t("xl_customer_id"), width: 14 },
        { header: t("xl_customer_name"), width: 34 },
        { header: t("xl_channel"), width: 18 },
        { header: t("report_erp_payments_regions"), width: 18 },
        { header: t("xl_subregion"), width: 18 },
      ],
      rows: lastRows.map((r) => [r.date, r.amount_amd, r.erp_customer_id, r.customer_name, r.sales_channel ? channelDisplayLabel(r.sales_channel) : "", r.region ? regionLabelHy(r.region) : "", r.subregion || ""]),
    }),
  };
}
