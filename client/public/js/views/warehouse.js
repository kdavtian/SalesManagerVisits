import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
import { t } from "../i18n.js";

export async function renderWarehouse(root, navigate) {
  let activeTab = "pick-list";

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_warehouse")}</h1></div>
      </div>
      <div class="segmented" id="warehouse-tabs">
        <button type="button" class="chip chip-active" data-tab="pick-list">${t("warehouse_tab_pick_list")}</button>
        <button type="button" class="chip" data-tab="staging">${t("warehouse_tab_staging")}</button>
        <button type="button" class="chip" data-tab="inventory">${t("warehouse_tab_inventory")}</button>
      </div>
      <p class="form-error" id="warehouse-error" hidden></p>
      <div id="warehouse-content" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const contentEl = container.querySelector("#warehouse-content");
  const errorEl = container.querySelector("#warehouse-error");
  const tabsEl = container.querySelector("#warehouse-tabs");

  tabsEl.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      tabsEl.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("chip-active", b.dataset.tab === activeTab));
      load();
    });
  });

  async function load() {
    contentEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      if (activeTab === "pick-list") await loadPickList();
      else if (activeTab === "staging") await loadStaging();
      else await loadInventory();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      contentEl.innerHTML = "";
    }
  }

  async function loadPickList() {
    const rows = await api.getPickList();
    contentEl.innerHTML = rows.length
      ? `<div class="card-list">${rows
          .map(
            (r) => `
        <div class="card">
          <div class="order-product-info">
            <strong>${escapeHtml(r.product_name)}</strong>
            <span class="muted">${[r.brand, `${r.order_count} ${t("warehouse_orders_count_suffix")}`].filter(Boolean).map(escapeHtml).join(" · ")}</span>
          </div>
          <div class="pick-list-qty">
            <span class="badge badge-info">${r.total_quantity}</span>
            ${r.stock_qty != null ? `<span class="muted">${t("warehouse_in_stock")}: ${r.stock_qty}</span>` : ""}
          </div>
        </div>`
          )
          .join("")}</div>`
      : `<p class="empty-state">${t("warehouse_pick_list_empty")}</p>`;
  }

  async function loadStaging() {
    const rows = await api.getStagingList();
    contentEl.innerHTML = rows.length
      ? `<div class="card-list">${rows.map((o) => stagingRowHtml(o)).join("")}</div>`
      : `<p class="empty-state">${t("warehouse_staging_empty")}</p>`;

    contentEl.querySelectorAll("[data-mark-packed]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.markOrderPacked(btn.dataset.markPacked);
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
    contentEl.querySelectorAll("[data-flag-issue]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const note = prompt(t("stock_issue_note_prompt"));
        if (!note || !note.trim()) return;
        btn.disabled = true;
        try {
          await api.flagOrderStockIssue(btn.dataset.flagIssue, note.trim());
          load();
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
          btn.disabled = false;
        }
      });
    });
  }

  function stagingRowHtml(o) {
    return `
      <div class="card">
        <div class="order-detail-ids">
          <span>${t("customer_id_label")}: ${escapeHtml(o.erp_customer_id || "")}</span>
          ${o.order_code ? `<span>${t("order_id_label")}: ${escapeHtml(o.order_code)}</span>` : ""}
        </div>
        <strong>${escapeHtml(o.customer_name)}</strong>
        <p class="muted">${escapeHtml(o.address || "")}</p>
        <div class="card-list" style="margin:8px 0;">
          ${o.items.map((i) => `<div class="order-product-row"><span>${escapeHtml(i.product_name)} × ${i.quantity}</span></div>`).join("")}
        </div>
        <p><strong>${t("total")}: ${formatAmd(Number(o.total_amd))}</strong></p>
        <div class="sheet-actions">
          <button type="button" class="btn btn-primary" data-mark-packed="${o.id}">${t("mark_packed")}</button>
          <button type="button" class="btn btn-danger" data-flag-issue="${o.id}">${t("flag_stock_issue")}</button>
        </div>
      </div>`;
  }

  async function loadInventory() {
    contentEl.innerHTML = `
      <input type="search" id="inventory-search" placeholder="${t("search")}" style="margin-bottom:8px;" />
      <div id="inventory-list" class="card-list"></div>
    `;
    const listEl = contentEl.querySelector("#inventory-list");
    const searchInput = contentEl.querySelector("#inventory-search");
    async function paint(q) {
      const rows = await api.getInventory(q);
      listEl.innerHTML = rows.length
        ? rows
            .map(
              (p) => `
        <div class="card">
          <div class="order-product-info">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}</span>
          </div>
          <span class="badge ${p.stock_qty > 0 ? "badge-success" : "badge-warning"}">${p.stock_qty != null ? p.stock_qty : t("warehouse_stock_unknown")}</span>
        </div>`
            )
            .join("")
        : `<p class="empty-state">${t("no_products_found")}</p>`;
    }
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => paint(searchInput.value.trim()), 250);
    });
    await paint("");
  }

  load();
}
