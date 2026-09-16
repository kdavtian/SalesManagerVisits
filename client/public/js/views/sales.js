// Read-only Sales viewer -- ERP order history (erp_order_lines) grouped
// into orders, company-wide, mirroring the existing per-customer "show all
// orders" screen (customerOrders.js) but scoped by date range/channel/
// customer search instead of a single customer. See server/src/routes/
// sales.js: no write-back, ERP/Excel stays the source of truth, same
// contract as Debt Balances.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatLiters, channelDisplayLabel, activateDialog, syncBadgeHtml, parseDateOnly, customerNameLinkHtml, activateCustomerNameLinks } from "../util.js";
import { t, getLang } from "../i18n.js";

// Local calendar-date components, not toISOString() -- that converts to
// UTC first, so a local midnight east of UTC (Yerevan is UTC+4) lands on
// the *previous* day once sliced back to YYYY-MM-DD (reported as the
// default "from" date showing the last day of the previous month instead
// of the 1st). Same class of bug util.js's own date-only helpers already
// avoid for the same reason.
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "15 Sep" style heading, same short-date convention as Orders' own
// per-day group heading (views/orders.js's formatOrderDateHeading) --
// parseDateOnly rather than `new Date(value)` since order_date here is a
// date-only string ("YYYY-MM-DD"), which `new Date()` parses as UTC
// midnight and would show the previous day in any timezone behind UTC.
function formatSalesDateHeading(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  const month = d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" });
  return `${d.getDate()} ${month}`;
}

function groupLinesByBrand(lines) {
  const byBrand = new Map();
  for (const line of lines) {
    const brand = line.brand || t("erp_brand_unspecified");
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  return byBrand;
}

async function openSalesOrderSheet(erpCustomerId, orderId, navigate) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  let detail;
  try {
    detail = await api.getSalesOrder(erpCustomerId, orderId);
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const byBrand = groupLinesByBrand(detail.lines);
  const brandSections = [...byBrand.entries()]
    .map(
      ([brand, lines]) => `
      <p class="proposed-changes-label">${escapeHtml(brand)}</p>
      ${lines
        .map(
          (l) => `
        <div class="erp-line-row">
          <span>${escapeHtml(l.product_name || "")}${l.size_l ? ` ${escapeHtml(String(l.size_l))}L` : ""}</span>
          <span class="muted">${escapeHtml(String(l.qty ?? ""))}pcs</span>
          <span>${formatAmd(l.unit_price_amd)}</span>
        </div>`
        )
        .join("")}`
    )
    .join("");

  overlay.querySelector(".sheet").innerHTML = `
    <div class="order-detail-header">
      <h2>${escapeHtml(detail.order_id)}</h2>
      <button class="icon-btn" id="close-order-detail" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="order-detail-meta">
      ${customerNameLinkHtml(detail.customer_name, detail.internal_customer_id)}
      <span class="erp-debt-amount">${formatAmd(detail.total_amd)}</span>
    </div>
    <p class="muted" style="margin: -4px 0 10px;">${escapeHtml(String(detail.order_date).slice(0, 10))}${detail.channel ? ` · ${escapeHtml(channelDisplayLabel(detail.channel))}` : ""}</p>
    ${brandSections}
  `;
  overlay.querySelector("#close-order-detail").addEventListener("click", () => overlay.remove());
  activateCustomerNameLinks(overlay, (hash) => {
    overlay.remove();
    navigate(hash);
  });
}

export async function renderSales(root, navigate) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  let from = formatDateInput(monthStart);
  let to = formatDateInput(today);
  let channel = "";
  let q = "";
  let searchTimer = null;

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("sales_title")}</h1></div>
      </div>
      <div class="sales-info-row">
        <div id="sales-sync-badge"></div>
        <button type="button" class="sales-info-toggle" id="sales-info-toggle" aria-expanded="false" aria-label="${escapeHtml(t("sales_source_hint"))}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.75" r="0.15" fill="currentColor" stroke="currentColor" stroke-width="2.4"/></svg>
        </button>
      </div>
      <p class="muted sales-source-hint" id="sales-source-hint" hidden>${t("sales_source_hint")}</p>
      <div class="activity-custom-range">
        <label>${t("date_from")}<input type="date" id="sales-from" value="${from}" /></label>
        <label>${t("date_to")}<input type="date" id="sales-to" value="${to}" /></label>
      </div>
      <div class="customer-stats-bar sales-channel-bar" id="sales-channel-bar" aria-label="${escapeHtml(t("sales_channel_filter"))}"></div>
      <div class="list-toolbar">
        <label class="visually-hidden" for="sales-search">${t("sales_search_placeholder")}</label>
        <input type="search" id="sales-search" placeholder="${t("sales_search_placeholder")}" aria-label="${t("sales_search_placeholder")}" />
      </div>
      <p class="form-error" id="sales-error" hidden></p>
      <p class="sales-subtotal-bar" id="sales-subtotal"></p>
      <div id="sales-list" class="card-list"></div>
    </div>
  `;

  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#sales-list");
  const errorEl = container.querySelector("#sales-error");
  const subtotalEl = container.querySelector("#sales-subtotal");
  const syncBadgeEl = container.querySelector("#sales-sync-badge");
  const fromInput = container.querySelector("#sales-from");
  const toInput = container.querySelector("#sales-to");
  const channelBarEl = container.querySelector("#sales-channel-bar");
  const searchInput = container.querySelector("#sales-search");
  const infoToggleBtn = container.querySelector("#sales-info-toggle");
  const sourceHintEl = container.querySelector("#sales-source-hint");
  let channelPills = [{ value: "", label: t("all_statuses"), count: 0 }];

  // Both header texts (the sync-freshness note and the longer "what this
  // data is" explanation) used to sit stacked under the title by default --
  // collapsed here into the one sync badge plus a small (i) toggle, so the
  // header stays one line unless a rep actually wants the explanation.
  infoToggleBtn.addEventListener("click", () => {
    const expanded = infoToggleBtn.getAttribute("aria-expanded") === "true";
    infoToggleBtn.setAttribute("aria-expanded", String(!expanded));
    sourceHintEl.hidden = expanded;
  });

  // Same tappable-pill filter as Activity's "by sales manager" bar (see
  // views/activity.js's renderManagerPills) -- tapping the pill that's
  // already active clears the filter, so "All" isn't the only way back.
  function renderChannelBar() {
    channelBarEl.innerHTML = channelPills
      .map(
        (p) => `
      <button type="button" class="stat-pill ${channel === p.value ? "stat-pill-active" : ""}" data-channel="${escapeHtml(p.value)}" aria-pressed="${channel === p.value}">
        <strong>${p.count}</strong>
        <span>${escapeHtml(p.label)}</span>
      </button>`
      )
      .join("");
    channelBarEl.querySelectorAll(".stat-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        channel = channel === btn.dataset.channel ? "" : btn.dataset.channel;
        load();
      });
    });
  }

  // Row 1: order id · sales channel -------- amount. Row 2: customer name
  // (bold). The date itself lives on the group heading above, not the row
  // -- order_date is a date-only server field, so it's identical across
  // every card in one group and would just repeat.
  function rowHtml(o) {
    return `
      <button type="button" class="card sales-order-card" data-erp-customer-id="${escapeHtml(o.erp_customer_id)}" data-order-id="${escapeHtml(o.order_id)}">
        <div class="sales-order-row">
          <span class="muted">${escapeHtml(o.order_id)}${o.channel ? ` · ${escapeHtml(channelDisplayLabel(o.channel))}` : ""}</span>
          <span class="text-amount sales-order-amount">${formatAmd(Number(o.total_amd))}</span>
        </div>
        <strong>${escapeHtml(o.customer_name || "")}</strong>
      </button>`;
  }

  // Grouped by the order's own calendar day -- each day's header row totals
  // just that day's orders: amount, liters (server's total_liters, summed
  // from size_l), and order count. Same one-pass-totals-then-render shape
  // as Orders' own per-day grouping (views/orders.js's paint()), so a long
  // date range doesn't re-scan `rows` once per row it contains.
  function render(rows) {
    if (!rows.length) {
      subtotalEl.textContent = "";
      listEl.innerHTML = `<p class="empty-state">${t("sales_empty")}</p>`;
      return;
    }
    const subtotal = rows.reduce((sum, o) => sum + Number(o.total_amd || 0), 0);
    subtotalEl.textContent = `${t("sales_subtotal")}: ${formatAmd(subtotal)} (${rows.length} ${t("sales_order_count")})`;

    const dayTotals = new Map();
    for (const o of rows) {
      const dateKey = String(o.order_date).slice(0, 10);
      const day = dayTotals.get(dateKey) ?? { total: 0, liters: 0, count: 0 };
      day.total += Number(o.total_amd || 0);
      day.liters += Number(o.total_liters || 0);
      day.count += 1;
      dayTotals.set(dateKey, day);
    }

    let lastDateKey = null;
    listEl.innerHTML = rows
      .map((o) => {
        const dateKey = String(o.order_date).slice(0, 10);
        let dateHeading = "";
        if (dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const day = dayTotals.get(dateKey);
          dateHeading = `
            <div class="order-date-heading">
              <span class="order-date-heading-label">${formatSalesDateHeading(dateKey)}</span>
              <span class="order-date-heading-stats">${formatAmd(day.total)} | ${formatLiters(day.liters)} | ${day.count} ${t("sales_order_count")}</span>
            </div>`;
        }
        return `${dateHeading}${rowHtml(o)}`;
      })
      .join("");

    listEl.querySelectorAll(".sales-order-card").forEach((card) => {
      card.addEventListener("click", () => openSalesOrderSheet(card.dataset.erpCustomerId, card.dataset.orderId, navigate));
    });
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      const params = { from, to };
      if (channel) params.channel = channel;
      if (q) params.q = q;
      const { rows, sync } = await api.getSales(params);
      syncBadgeEl.innerHTML = syncBadgeHtml(sync);

      // Pill counts are only ever refreshed from an unfiltered-by-channel
      // fetch (this one, since `channel` is only added to params after a
      // pill is tapped) -- filtering by channel server-side would otherwise
      // collapse every other pill's count to 0. The bar itself is still
      // re-rendered every load() below so its active state always reflects
      // the current `channel`, even on a call that skips this recompute.
      if (!channel) {
        const counts = new Map();
        for (const r of rows) {
          if (!r.channel) continue;
          counts.set(r.channel, (counts.get(r.channel) || 0) + 1);
        }
        channelPills = [
          { value: "", label: t("all_statuses"), count: rows.length },
          ...[...counts.entries()]
            .map(([code, count]) => ({ value: code, label: channelDisplayLabel(code), count }))
            .sort((a, b) => b.count - a.count),
        ];
      }
      renderChannelBar();

      render(rows);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
      subtotalEl.textContent = "";
    }
  }

  fromInput.addEventListener("change", () => {
    from = fromInput.value || from;
    load();
  });
  toInput.addEventListener("change", () => {
    to = toInput.value || to;
    load();
  });
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      q = searchInput.value.trim();
      load();
    }, 300);
  });

  load();
}
