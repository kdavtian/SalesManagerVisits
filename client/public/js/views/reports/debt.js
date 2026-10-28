// Reports > customer debt (moved out of reports.js with the refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { activateDialog, amdWithUnitHtml, channelDisplayLabel, escapeHtml, formatAmd, formatDateDMY, labelColon, openInfoPopup, syncNote } from "../../util.js";
import { t } from "../../i18n.js";
import { icons } from "../../icons.js";
import { dueChipHtml } from "../../debtChip.js";
import { channelOptions, currentYearMonthDay, fitReportStatValue, formatReportAsOfCaption, reportHeaderHtml, selectHtml } from "./common.js";

export async function renderCustomerDebtReport(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      ${reportHeaderHtml("report_customer_debt_name", { hint: true })}
      <form id="report-filters" class="report-filter-form report-debt-filters">
        <div class="pill-date-filter-row">
          <div class="pill-date-filter-wrap">
            <button type="button" class="pill-date-filter-btn" tabindex="-1" aria-hidden="true">
              <span class="pill-date-filter-caption">${t("debt_balances_as_of_date")}</span>
              <span class="pill-date-filter-value" id="report-debt-as-of-value">${t("debt_balances_as_of_live")}</span>
            </button>
            <input type="date" class="pill-date-picker-input" id="report-debt-as-of-input" name="date" value="" max="${currentYearMonthDay()}" aria-label="${t("debt_balances_as_of_date")}" />
          </div>
          <button type="button" class="pill-date-clear-btn" id="report-debt-as-of-clear" hidden aria-label="${t("debt_balances_as_of_clear")}" title="${t("debt_balances_as_of_clear")}">${icons.close}</button>
        </div>
        <button type="button" class="map-filter-chip report-channel-btn" id="report-debt-channels-btn" aria-haspopup="dialog">${t("all_channels")}</button>
        ${selectHtml(
          "debt_only",
          [
            { value: "1", label: t("report_customer_debt_with_debt_only") },
            { value: "", label: t("report_customer_debt_all") },
          ],
          "1"
        )}
      </form>
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  const form = container.querySelector("#report-filters");
  const body = container.querySelector("#report-body");
  const asOfInput = container.querySelector("#report-debt-as-of-input");
  const asOfValueEl = container.querySelector("#report-debt-as-of-value");
  const asOfClearBtn = container.querySelector("#report-debt-as-of-clear");
  const debtSyncHintBtn = container.querySelector("#report-sync-hint-btn");
  let debtSyncInfoHtml = "";
  debtSyncHintBtn.addEventListener("click", () => openInfoPopup(debtSyncInfoHtml));

  // Just paints the pill's own caption -- reloading is already handled by
  // the form-level "change" listener below (this input lives inside
  // #report-filters, so its native change event bubbles there too).
  asOfInput.addEventListener("change", () => {
    asOfValueEl.textContent = asOfInput.value ? formatReportAsOfCaption(asOfInput.value) : t("debt_balances_as_of_live");
    asOfClearBtn.hidden = !asOfInput.value;
  });
  // The clear button sets the input's value programmatically, which does
  // NOT fire a native "change" event on its own -- so this one does need
  // to trigger the reload itself, unlike the listener above.
  asOfClearBtn.addEventListener("click", () => {
    asOfInput.value = "";
    asOfValueEl.textContent = t("debt_balances_as_of_live");
    asOfClearBtn.hidden = true;
    load();
  });

  // Channel filter: multi-select (sheet of checkboxes). Empty set = all channels.
  const selectedChannels = new Set();
  const selectedBuckets = new Set();
  let channelList = [];
  const channelBtn = container.querySelector("#report-debt-channels-btn");
  function paintChannelBtn() {
    if (!selectedChannels.size) channelBtn.textContent = t("all_channels");
    else if (selectedChannels.size === 1) channelBtn.textContent = channelList.find((c) => c.value === [...selectedChannels][0])?.label ?? [...selectedChannels][0];
    else channelBtn.textContent = `${selectedChannels.size} ${t("channels_selected")}`;
    channelBtn.classList.toggle("chip-active", selectedChannels.size > 0);
  }
  try {
    channelList = (await channelOptions()).filter((o) => o.value);
  } catch {
    // Channel list is a filter convenience only -- if it fails to load, the
    // report itself (unfiltered) still works fine below.
  }
  channelBtn.addEventListener("click", () => {
    const picked = new Set(selectedChannels);
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <h2>${t("all_channels")}</h2>
        <div class="pd-edit-scroll">
          <div class="filter-sheet-chips">
            ${channelList.map((c) => `<button type="button" class="filter-sheet-chip ${picked.has(c.value) ? "filter-sheet-chip-selected" : ""}" data-value="${escapeHtml(c.value)}" aria-pressed="${picked.has(c.value)}">${escapeHtml(c.label)}</button>`).join("")}
          </div>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="ch-clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" id="ch-show">${t("show_results")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    const sync = (chip) => {
      chip.classList.toggle("filter-sheet-chip-selected", picked.has(chip.dataset.value));
      chip.setAttribute("aria-pressed", String(picked.has(chip.dataset.value)));
    };
    overlay.querySelector(".filter-sheet-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-value]");
      if (!chip) return;
      if (picked.has(chip.dataset.value)) picked.delete(chip.dataset.value);
      else picked.add(chip.dataset.value);
      sync(chip);
    });
    overlay.querySelector("#ch-clear").addEventListener("click", () => {
      picked.clear();
      overlay.querySelectorAll("[data-value]").forEach(sync);
    });
    overlay.querySelector("#ch-show").addEventListener("click", () => {
      selectedChannels.clear();
      for (const v of picked) selectedChannels.add(v);
      selectedBuckets.clear(); // a different channel set has different buckets
      overlay.remove();
      paintChannelBtn();
      load();
    });
  });

  // The page frame (stat cards, bucket list, customer list) is built once;
  // changing a filter only swaps the numbers and the two lists inside it, so
  // nothing blinks or collapses to a spinner and the scroll position stays.
  let scaffolded = false;
  let loadSeq = 0;
  function scaffold() {
    body.innerHTML = `
      <div id="debt-sync-badge"></div>
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value report-debt-total-value" id="report-debt-total-value"></span>
          <span class="stat-label">${t("report_customer_debt_total_debt")}</span>
        </div>
        <div class="stat-card">
          <span class="stat-value report-debt-total-value" id="report-debt-customers-value"></span>
          <span class="stat-label">${t("report_customer_debt_customers_with_debt")}</span>
        </div>
      </div>
      <div id="debt-adjusted-note"></div>
      <h2 class="section-title">${t("report_customer_debt_by_bucket")}</h2>
      <div class="card-list" id="debt-bucket-list"></div>
      <h2 class="section-title" id="debt-customers-title"></h2>
      <div class="card-list" id="debt-customer-list"></div>
    `;
    // Delegated once: the bucket rows are re-rendered on every load.
    // Tapping an aging row filters the customer list (and totals) to that
    // bucket; tap again to clear. Several buckets can be combined.
    body.querySelector("#debt-bucket-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".report-bucket-btn");
      if (!btn) return;
      const bucket = btn.dataset.bucket;
      if (selectedBuckets.has(bucket)) selectedBuckets.delete(bucket);
      else selectedBuckets.add(bucket);
      // Instant feedback on the row itself, before the numbers arrive.
      btn.classList.toggle("report-bucket-active", selectedBuckets.has(bucket));
      btn.setAttribute("aria-pressed", String(selectedBuckets.has(bucket)));
      load();
    });
    scaffolded = true;
  }

  function paintDebt({ customers, by_bucket, totals, sync }) {
    const note = syncNote(sync);
    body.querySelector("#debt-sync-badge").innerHTML = note.alert;
    debtSyncInfoHtml = note.info;
    debtSyncHintBtn.hidden = !note.info;
    body.querySelector("#report-debt-total-value").innerHTML = amdWithUnitHtml(Number(totals.total_debt_amd));
    body.querySelector("#report-debt-customers-value").textContent = totals.customers_with_debt;
    // Only meaningful in live mode -- totals.total_debt_amd_erp is always the
    // raw live erp.debt_amd sum, which as-of-date mode has no reason to match
    // (it's comparing two different things, not "collections since sync"),
    // so this note would be misleading rather than explanatory there.
    body.querySelector("#debt-adjusted-note").innerHTML =
      !asOfInput.value && Number(totals.total_debt_amd_erp) !== Number(totals.total_debt_amd)
        ? `<p class="muted" style="margin: 0 4px 12px;">${t("report_customer_debt_adjusted_note")
            .replace("{erp}", formatAmd(Number(totals.total_debt_amd_erp)))
            .replace("{adjusted}", formatAmd(Number(totals.total_debt_amd)))}</p>`
        : "";
    body.querySelector("#debt-bucket-list").innerHTML = by_bucket.length
      ? by_bucket
          .map(
            (b) => `
        <button type="button" class="card report-row report-bucket-btn ${selectedBuckets.has(b.aging_bucket) ? "report-bucket-active" : ""}" data-bucket="${escapeHtml(b.aging_bucket)}" aria-pressed="${selectedBuckets.has(b.aging_bucket)}">
          <span>${escapeHtml(t(`debt_bucket_${b.aging_bucket}`))}</span>
          <strong class="report-row-amount">${formatAmd(Number(b.total_debt_amd))} <span class="muted">(${b.customer_count})</span></strong>
        </button>`
          )
          .join("")
      : `<p class="empty-state">${t("no_data")}</p>`;
    body.querySelector("#debt-customers-title").textContent = `${t("customers")} (${customers.length})`;
    body.querySelector("#debt-customer-list").innerHTML = customers.length
      ? customers
          .map((c) => {
            const collected = Number(c.collected_since_sync_amd);
            return `
        <div class="card report-row-multiline ${Number(c.estimated_debt_amd) > 0 && c.oldest_due_days != null ? (c.oldest_due_days > 0 ? "unpaid-row-overdue" : "unpaid-row-due") : ""}">
          <div class="report-debt-customer-top">
            <strong class="report-debt-customer-name">${escapeHtml(c.customer_name)}</strong>
            <strong class="report-row-amount">${formatAmd(Number(c.estimated_debt_amd))}</strong>
          </div>
          ${c.oldest_due_days != null && Number(c.estimated_debt_amd) > 0 ? `<div class="debt-chip-line">${Number(c.overdue_amd) > 0 ? `<span class="muted">${t("debt_overdue_label")}${labelColon()}${formatAmd(Number(c.overdue_amd))}</span>` : ""}${dueChipHtml(c.oldest_due_days)}</div>` : ""}
          <span class="muted">${t("customer_id_label")}${labelColon()}${escapeHtml(c.erp_customer_id || "—")} · ${escapeHtml(channelDisplayLabel(c.assigned_sales_rep))}</span>
          <span class="muted">${t("debt_balances_last_payment")}${labelColon()}${c.last_payment_date ? escapeHtml(formatDateDMY(c.last_payment_date)) : t("report_customer_debt_no_payment")}</span>${
              collected > 0
                ? `
          <span class="muted sync-adjusted-note">${formatAmd(Number(c.debt_amd))} ${t("report_customer_debt_per_sync")} − ${formatAmd(collected)} ${t("report_customer_debt_collected_since")}</span>`
                : ""
            }
        </div>`;
          })
          .join("")
      : `<p class="empty-state">${t("no_data")}</p>`;
    fitReportStatValue(body.querySelector("#report-debt-total-value"));
  }

  async function load() {
    const seq = ++loadSeq;
    if (scaffolded) body.classList.add("report-body-refreshing");
    else body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const data = new FormData(form);
    const params = Object.fromEntries([...data.entries()].filter(([, v]) => v));
    if (selectedChannels.size) params.sales_channel = [...selectedChannels].join(",");
    if (selectedBuckets.size) params.aging = [...selectedBuckets].join(",");
    try {
      const result = await api.getCustomerDebtReport(params);
      if (seq !== loadSeq) return; // a newer filter change is already in flight
      if (!scaffolded) scaffold();
      body.querySelector(":scope > .form-error")?.remove();
      paintDebt(result);
      body.classList.remove("report-body-refreshing");
    } catch (err) {
      if (seq !== loadSeq) return;
      body.classList.remove("report-body-refreshing");
      if (scaffolded) {
        // Keep the page; show the error above it.
        body.querySelector(".form-error")?.remove();
        body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
      } else {
        body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      }
    }
  }

  form.addEventListener("change", load);
  await load();
}
