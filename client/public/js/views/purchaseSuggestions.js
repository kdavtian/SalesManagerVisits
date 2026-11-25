// Purchases > Suggestions (owner, 2026-11-25: "smart purchase suggestion for each supplier"). One card per supplier (the one each product was
// last bought from), each product with: stock now and its days, on the way, the order in whole steps (− / + by one step: 5 boxes of bottles,
// 5 pieces of a 20 L canister, 1 drum above 20 L), the stock and days left after receiving (counted from the arrival: today + lead time).
// "Create purchase" opens the purchase form filled: that supplier, Ordered, expected on the arrival day, the products and their last price.
// Server: GET /api/purchases/suggestions (products/purchaseSuggestionsData.js); the formulas: shared/purchaseSuggestion.js -- the same file
// recomputes a line here when its quantity changes, so the screen and the server can never disagree.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY } from "../util.js";
import { icons } from "../icons.js";
import { normalizeUnitLabel } from "../productSort.js";
import { purchaseLine } from "../shared/purchaseSuggestion.js";

const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const num = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
};

export async function renderPurchaseSuggestions(root, navigate) {
  root.innerHTML = `
    <div class="detail-view ps-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("ps_title")}</h1></div>
        <div class="detail-header-actions"><button type="button" class="settings-hint-icon" id="ps-hint" aria-label="${t("more_info")}" aria-expanded="false">!</button></div>
      </div>
      <p class="muted ps-hint" id="ps-hint-text" hidden></p>
      <p class="muted ps-sub" id="ps-sub"></p>
      <div id="ps-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/purchases"));
  const hintBtn = root.querySelector("#ps-hint");
  const hintText = root.querySelector("#ps-hint-text");
  hintBtn.addEventListener("click", () => {
    hintText.hidden = !hintText.hidden;
    hintBtn.setAttribute("aria-expanded", String(!hintText.hidden));
  });
  const body = root.querySelector("#ps-body");

  let data;
  let suppliers = [];
  try {
    [data, suppliers] = await Promise.all([
      api.getPurchaseSuggestions(),
      api.listSuppliers().then((s) => [...(s.suppliers ?? []).filter((x) => x.active !== false), ...(s.excel_suppliers ?? [])].map((x) => x.name)).catch(() => []),
    ]);
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!body.isConnected) return;
  const lead = data.lead_time_days;
  const cover = data.cover_days;
  const fill = (s) => s.replace("{lead}", lead).replace("{cover}", cover).replace("{date}", formatDateDMY(data.arrival_date));
  root.querySelector("#ps-sub").textContent = fill(t("ps_sub"));
  hintText.textContent = fill(t("ps_hint"));

  // every line once, by product; `group` = the supplier it sits under now (the owner can move it)
  const lines = data.suppliers.flatMap((g) => g.lines.map((l) => ({ ...l, group: g.supplier })));
  // every supplier once, however its name was typed (the cards are grouped the same way on the server)
  const byKey = new Map();
  for (const n of [...data.suppliers.map((g) => g.supplier).filter(Boolean), ...suppliers]) {
    const key = String(n).replace(/\s+/g, " ").trim().toLowerCase();
    if (key && !byKey.has(key)) byKey.set(key, n);
  }
  const names = [...byKey.values()].sort((a, b) => a.localeCompare(b));

  const recompute = (l) =>
    // from the server's exact inputs (not the rounded numbers shown), so the phone and the server agree to the piece
    Object.assign(l, purchaseLine({ stockNow: l.free_raw ?? l.stock_now, coming: l.coming, comingLots: l.coming_lots ?? null, wanted: l.wanted, daily: l.daily_raw ?? l.daily_demand, leadTimeDays: lead, coverDays: cover, safetyStock: l.safety_stock, stepPieces: l.step_pieces, order: l.order }));

  function qtyLabel(l) {
    if (l.kind === "pack" && l.pack_size > 1) return `${l.order / l.pack_size} ${t("ps_boxes")} · ${l.order} ${t("warehouse_pcs_suffix")}`;
    return `${l.order} ${t("warehouse_pcs_suffix")}`;
  }
  function lineHtml(l) {
    const size = l.unit ? normalizeUnitLabel(l.unit) : "";
    const flags = [
      l.runs_out_before_arrival ? `<span class="badge badge-danger">${t("ps_runs_out")}</span>` : "",
      l.pack_size_guessed ? `<span class="badge badge-neutral">${t("ps_pack_guessed")}</span>` : "",
      l.trend === "up" ? `<span class="badge badge-info">${t("ps_trend_up")}</span>` : l.trend === "down" ? `<span class="badge badge-neutral">${t("ps_trend_down")}</span>` : "",
    ].join("");
    // "lasts until" as day.month: the full date wrapped at 320 px
    const until = l.days_after_receiving != null ? formatDateDMY(addDays(data.arrival_date, l.days_after_receiving)).slice(0, 5).replace("-", ".") : "";
    return `<div class="ps-line ${l.order ? "" : "ps-line-off"}" data-line="${l.product_id}">
      <div class="ps-line-head">
        <a class="ps-name" href="#/product/${l.product_id}">${escapeHtml(l.name)}</a>${size ? `<span class="inventory-row-size-chip">${escapeHtml(size)}</span>` : ""}
      </div>
      <p class="muted ps-rate">${num(l.daily_demand)} ${t("warehouse_pcs_suffix")} ${t("ps_per_day")}</p>
      ${flags ? `<div class="ps-flags">${flags}</div>` : ""}
      <div class="ps-grid">
        <div><span class="ps-k">${t("ps_now")}</span><strong>${l.stock_now} ${t("warehouse_pcs_suffix")}</strong><span class="muted">${l.days_now != null ? `${num(l.days_now)} ${t("ps_days")}` : "—"}</span></div>
        <div><span class="ps-k">${t("ps_coming")}</span><strong>${l.coming} ${t("warehouse_pcs_suffix")}</strong></div>
        <div><span class="ps-k">${t("ps_after")}</span><strong>${l.after_receiving} ${t("warehouse_pcs_suffix")}</strong><span class="muted">${l.days_after_receiving != null ? `${num(l.days_after_receiving)} ${t("ps_days")}${until ? ` · ${until}` : ""}` : "—"}</span></div>
      </div>
      <div class="ps-order">
        <button type="button" class="ps-step" data-minus="${l.product_id}" aria-label="${t("ps_less")}" ${l.order ? "" : "disabled"}>−</button>
        <span class="ps-qty" aria-live="polite"><strong>${qtyLabel(l)}</strong>${l.cost_usd != null ? `<span class="muted">${usd(l.cost_usd * l.order)}</span>` : ""}</span>
        <button type="button" class="ps-step" data-plus="${l.product_id}" aria-label="${t("ps_more")}">+</button>
      </div>
      ${l.order !== l.suggested ? `<button type="button" class="ps-reset" data-reset="${l.product_id}">${t("ps_suggested")}: ${l.suggested} ${t("warehouse_pcs_suffix")}</button>` : ""}
      <label class="ps-move"><span class="muted">${t("ps_supplier")}</span>
        <select data-move="${l.product_id}"><option value="${escapeHtml(l.group)}" selected>${escapeHtml(l.group || t("ps_no_supplier"))}</option></select>
      </label>
    </div>`;
  }
  // the supplier list is put into a line's select only when it is opened: hundreds of lines x every supplier on each redraw was slow on phones
  function fillSelect(sel) {
    if (sel.dataset.filled) return;
    const l = lines.find((x) => x.product_id === Number(sel.dataset.move));
    sel.innerHTML = ["", ...names].map((n) => `<option value="${escapeHtml(n)}" ${n === l?.group ? "selected" : ""}>${escapeHtml(n || t("ps_no_supplier"))}</option>`).join("");
    sel.dataset.filled = "1";
  }
  function totals(list) {
    const on = list.filter((l) => l.order > 0);
    return {
      products: on.length,
      pieces: on.reduce((a, l) => a + l.order, 0),
      liters: on.reduce((a, l) => a + (l.liters_per_piece || 0) * l.order, 0),
      usd: on.reduce((a, l) => a + (l.cost_usd ?? 0) * l.order, 0),
      unpriced: on.filter((l) => l.cost_usd == null).length,
    };
  }
  const totalsHtml = (tot) =>
    `${tot.products} ${t("warehouse_reorder_products")} · ${tot.pieces} ${t("warehouse_pcs_suffix")} · ${num(tot.liters)} L · <strong>${usd(tot.usd)}</strong>${tot.unpriced ? ` · ${tot.unpriced} ${t("ps_unpriced")}` : ""}`;
  // − / + redraws only that line and its card's totals (the whole list was rebuilt on every tap)
  function redrawLine(l) {
    const el = body.querySelector(`[data-line="${l.product_id}"]`);
    if (el) el.outerHTML = lineHtml(l);
    const card = [...body.querySelectorAll(".ps-supplier")].find((c) => c.dataset.group === l.group);
    if (!card) return;
    const tot = totals(lines.filter((x) => x.group === l.group));
    card.querySelector(".ps-totals").innerHTML = totalsHtml(tot);
    card.querySelector(".ps-create").disabled = !tot.products;
  }
  function render() {
    const groups = new Map();
    for (const l of lines) {
      if (!groups.has(l.group)) groups.set(l.group, []);
      groups.get(l.group).push(l);
    }
    const order = [...groups.entries()].map(([g, list]) => ({ g, list, tot: totals(list) }));
    order.sort((a, b) => (a.g ? 0 : 1) - (b.g ? 0 : 1) || b.tot.usd - a.tot.usd);
    if (!order.length) {
      body.innerHTML = `<p class="empty-state">${t("ps_none")}</p>`;
      return;
    }
    body.innerHTML = order
      .map(
        ({ g, list, tot }, k) => `<section class="card ps-supplier" data-group="${escapeHtml(g)}">
          <div class="ps-supplier-head">
            <h2>${escapeHtml(g || t("ps_no_supplier"))}</h2>
            <p class="muted ps-totals">${totalsHtml(tot)}</p>
          </div>
          ${list.map(lineHtml).join("")}
          <button type="button" class="btn ${k === 0 ? "btn-primary" : ""} btn-block btn-has-icon ps-create" data-create="${escapeHtml(g)}" ${tot.products ? "" : "disabled"}>${icons.plus}${escapeHtml(t("ps_create"))}</button>
        </section>`
      )
      .join("");
  }
  render();

  const find = (id) => lines.find((l) => l.product_id === Number(id));
  body.addEventListener("click", async (e) => {
    const minus = e.target.closest("[data-minus]");
    const plus = e.target.closest("[data-plus]");
    const reset = e.target.closest("[data-reset]");
    const create = e.target.closest("[data-create]");
    if (minus || plus || reset) {
      const l = find((minus ?? plus ?? reset).dataset.minus ?? (minus ?? plus ?? reset).dataset.plus ?? (minus ?? plus ?? reset).dataset.reset);
      if (!l) return;
      l.order = reset ? l.suggested : Math.max(0, l.order + (plus ? l.step_pieces : -l.step_pieces));
      recompute(l);
      redrawLine(l);
      body.querySelector(`[data-line="${l.product_id}"] ${plus ? "[data-plus]" : "[data-minus]"}`)?.focus();
      return;
    }
    if (create) {
      const supplier = create.dataset.create;
      const list = lines.filter((l) => l.group === supplier && l.order > 0);
      const { openPurchaseForm } = await import("./purchases/form.js");
      openPurchaseForm(
        {
          supplier,
          status: "ordered",
          expected_date: data.arrival_date,
          // a draft per supplier and DAY: yesterday's draft never replaces today's suggestion (review 2026-11-25)
          draft_tag: `suggest:${supplier.toLowerCase()}:${data.today}`,
          lines: list.map((l) => ({ product_id: l.product_id, product_name: l.name, brand: l.brand, size_l: l.liters_per_piece, qty: l.order, cost_usd: l.cost_usd })),
        },
        { onSaved: () => renderPurchaseSuggestions(root, navigate) }
      );
    }
  });
  body.addEventListener("focusin", (e) => {
    const sel = e.target.closest("[data-move]");
    if (sel) fillSelect(sel);
  });
  body.addEventListener("pointerdown", (e) => {
    const sel = e.target.closest("[data-move]");
    if (sel) fillSelect(sel);
  });
  body.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-move]");
    if (!sel) return;
    const l = find(sel.dataset.move);
    if (!l) return;
    l.group = sel.value;
    render();
  });
}
