// Purchases > Suggestions (owner, 2026-11-25: "smart purchase suggestion for each supplier"). One card per supplier (the one each product was
// last bought from; a transporter's goods under the real supplier, "via" the transporter), each product with: stock now and its days, on the
// way, the order in whole steps (− / + by one step: 5 boxes of bottles, 5 pieces of a 20 L canister, 1 drum above 20 L), the stock and days
// left after receiving (counted from the arrival: today + lead time).
// Compact list (owner, 2026-11-26 audit, step 2): one short row per product (name, how long it lasts now and after receiving, the order with
// − / +); a tap on the row opens its details (the numbers, back to the suggestion, the product card, the supplier). Each supplier's name,
// totals and "Create purchase" stay pinned at the top of its card while its products scroll. The arrival / cover days line is a chip that
// opens a "what if" (other lead time or cover days for this screen only; the settings stay).
// "Create purchase" opens the purchase form filled: that supplier, Ordered, expected on the arrival day, the products and their last price.
// Server: GET /api/purchases/suggestions (products/purchaseSuggestionsData.js); the formulas: shared/purchaseSuggestion.js -- the same file
// recomputes a line here when its quantity changes, so the screen and the server can never disagree.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../util.js";
import { icons } from "../icons.js";
import { normalizeUnitLabel } from "../productSort.js";
import { purchaseLine } from "../shared/purchaseSuggestion.js";

const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const whole = (n) => Math.round(Number(n || 0)).toLocaleString("en-US");
const num = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
};
// one date format on the whole screen: 10.01.27
const shortDate = (day) => (day ? `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(2, 4)}` : "");

export async function renderPurchaseSuggestions(root, navigate, what = {}) {
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
      <div class="ps-plan" id="ps-plan"></div>
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
  const plan = root.querySelector("#ps-plan");

  let data;
  let suppliers = [];
  try {
    [data, suppliers] = await Promise.all([
      api.getPurchaseSuggestions(what),
      api.listSuppliers().then((s) => [...(s.suppliers ?? []).filter((x) => x.active !== false), ...(s.excel_suppliers ?? [])].map((x) => x.name)).catch(() => []),
    ]);
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!body.isConnected) return;
  const lead = data.lead_time_days;
  const cover = data.cover_days;
  const fill = (s) => s.replace("{lead}", lead).replace("{cover}", cover).replace("{date}", shortDate(data.arrival_date));
  // the sentence that sat under the title lives in the "!" now (owner: explanations under the "!" icon, never a paragraph over the content)
  hintText.textContent = `${fill(t("ps_sub"))}\n\n${fill(t("ps_hint"))}`;

  // ---- the arrival / cover chip and its "what if" ---------------------------------------------------------------------------------------
  const trying = (data.settings_lead_days != null && lead !== data.settings_lead_days) || (data.settings_cover_days != null && cover !== data.settings_cover_days);
  plan.innerHTML = `
    <button type="button" class="ps-plan-chip ${trying ? "ps-plan-trying" : ""}" id="ps-plan-chip" aria-expanded="false" aria-controls="ps-plan-edit">
      <span>${escapeHtml(t("ps_plan_chip").replace("{date}", shortDate(data.arrival_date)).replace("{lead}", lead).replace("{cover}", cover))}</span>
      <span aria-hidden="true" class="ps-plan-pen">✎</span>
    </button>
    ${trying ? `<span class="ps-plan-note">${escapeHtml(t("ps_plan_trying"))}</span>` : ""}
    <form class="ps-plan-edit" id="ps-plan-edit" hidden>
      <label><span>${escapeHtml(t("ps_plan_lead"))}</span><input type="number" inputmode="numeric" min="1" max="365" step="1" name="lead" value="${lead}" required></label>
      <label><span>${escapeHtml(t("ps_plan_cover"))}</span><input type="number" inputmode="numeric" min="1" max="365" step="1" name="cover" value="${cover}" required></label>
      <div class="ps-plan-actions">
        <button type="submit" class="btn btn-primary">${escapeHtml(t("ps_plan_apply"))}</button>
        ${trying ? `<button type="button" class="btn" id="ps-plan-reset">${escapeHtml(t("ps_plan_reset"))}</button>` : ""}
      </div>
    </form>`;
  const chip = plan.querySelector("#ps-plan-chip");
  const editor = plan.querySelector("#ps-plan-edit");
  chip.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    chip.setAttribute("aria-expanded", String(!editor.hidden));
    if (!editor.hidden) editor.querySelector("input").focus();
  });
  editor.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(editor);
    const ok = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365;
    if (!ok(f.get("lead")) || !ok(f.get("cover"))) return editor.reportValidity();
    renderPurchaseSuggestions(root, navigate, { lead_days: Number(f.get("lead")), cover_days: Number(f.get("cover")) });
  });
  plan.querySelector("#ps-plan-reset")?.addEventListener("click", () => renderPurchaseSuggestions(root, navigate));

  // every line once, by product; `group` = the supplier it sits under now (the owner can move it)
  const lines = data.suppliers.flatMap((g) => g.lines.map((l) => ({ ...l, group: g.supplier, group_original: g.supplier })));
  // a transporter's goods are grouped under the real supplier (owner, 2026-11-26: Sole Trans brings Castrol): the card says "via ...",
  // from the lines the card holds now (a line moved to another card takes its transporter along; review 2026-11-26)
  const viaOf = (list) => [...new Set(list.map((l) => l.via).filter(Boolean))];
  // every supplier once, however its name was typed (the cards are grouped the same way on the server)
  const byKey = new Map();
  for (const n of [...data.suppliers.map((g) => g.supplier).filter(Boolean), ...suppliers]) {
    const key = String(n).replace(/\s+/g, " ").trim().toLowerCase();
    if (key && !byKey.has(key)) byKey.set(key, n);
  }
  const names = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  const open = new Set(); // the rows whose details are open (kept through − / + and moves)

  const recompute = (l) =>
    // from the server's exact inputs (not the rounded numbers shown), so the phone and the server agree to the piece
    Object.assign(l, purchaseLine({ stockNow: l.free_raw ?? l.stock_now, coming: l.coming, comingLots: l.coming_lots ?? null, wanted: l.wanted, daily: l.daily_raw ?? l.daily_demand, leadTimeDays: lead, coverDays: cover, safetyStock: l.safety_stock, stepPieces: l.step_pieces, trend: l.trend, order: l.order }));

  const pcs = t("warehouse_pcs_suffix");
  const d = t("ps_d");
  function qtyHtml(l) {
    const boxes = l.kind === "pack" && l.pack_size > 1;
    const big = boxes ? `${l.order / l.pack_size} ${t("ps_boxes")}` : `${l.order} ${pcs}`;
    const small = [boxes ? `${l.order} ${pcs}` : "", l.cost_usd != null && l.order ? usd(l.cost_usd * l.order) : ""].filter(Boolean).join(" · ");
    return `<strong>${big}</strong>${small ? `<span class="muted">${small}</span>` : ""}`;
  }
  function lineHtml(l) {
    const size = l.unit ? normalizeUnitLabel(l.unit) : "";
    const out = l.stock_now <= 0;
    const flags = [
      // an empty shelf already says "Out of stock" on the row; the badge is for a shelf that empties before the goods come
      l.runs_out_before_arrival && !out ? `<span class="badge badge-danger">${t("ps_runs_out")}</span>` : "",
      l.too_much ? `<span class="badge badge-warning">${t(l.order <= l.step_pieces ? "ps_too_much_step" : "ps_too_much").replace("{days}", Math.round(l.days_after_receiving))}</span>` : "",
      l.pack_size_guessed ? `<span class="badge badge-neutral">${t("ps_pack_guessed")}</span>` : "",
      l.trend === "up" ? `<span class="badge badge-info">${t("ps_trend_up")}</span>` : l.trend === "down" ? `<span class="badge badge-neutral">${t("ps_trend_down")}</span>` : "",
    ].join("");
    const until = l.days_after_receiving != null ? shortDate(addDays(data.arrival_date, l.days_after_receiving)) : "";
    const now = out ? `<span class="ps-out">${t("ps_out")}</span>` : `${t("ps_now")} ${whole(l.stock_now)} ${pcs}${l.days_now != null ? ` · ${whole(l.days_now)} ${d}` : ""}`;
    const after = l.order && l.days_after_receiving != null ? ` → ${whole(l.days_after_receiving)} ${d}` : "";
    const isOpen = open.has(l.product_id);
    return `<div class="ps-line ${l.order ? "" : "ps-line-off"}" data-line="${l.product_id}">
      <button type="button" class="ps-row" data-toggle="${l.product_id}" aria-expanded="${isOpen}">
        <span class="ps-row-name">${escapeHtml(l.name)}${size ? ` <span class="inventory-row-size-chip">${escapeHtml(size)}</span>` : ""}</span>
        <span class="ps-row-sub">${now}${after}</span>
        ${flags ? `<span class="ps-flags">${flags}</span>` : ""}
      </button>
      <div class="ps-order">
        <button type="button" class="ps-step" data-minus="${l.product_id}" aria-label="${t("ps_less")}" ${l.order ? "" : "disabled"}>−</button>
        <span class="ps-qty" aria-live="polite">${qtyHtml(l)}</span>
        <button type="button" class="ps-step" data-plus="${l.product_id}" aria-label="${t("ps_more")}">+</button>
      </div>
      <div class="ps-details" ${isOpen ? "" : "hidden"}>
        <div class="ps-grid">
          <div><span class="ps-k">${t("ps_now")}</span><strong>${whole(l.stock_now)} ${pcs}</strong><span class="muted">${l.days_now != null ? `${whole(l.days_now)} ${d}` : "—"}</span></div>
          ${l.coming ? `<div><span class="ps-k">${t("ps_coming")}</span><strong>${whole(l.coming)} ${pcs}</strong></div>` : ""}
          <div><span class="ps-k">${t("ps_after")}</span><strong>${whole(l.after_receiving)} ${pcs}</strong><span class="muted">${l.days_after_receiving != null ? `${whole(l.days_after_receiving)} ${d}${until ? ` · ${until}` : ""}` : "—"}</span></div>
        </div>
        <p class="muted ps-rate">${num(l.daily_demand)} ${pcs} ${t("ps_per_day")}</p>
        <div class="ps-detail-actions">
          ${l.order !== l.suggested ? `<button type="button" class="ps-reset" data-reset="${l.product_id}">${t("ps_suggested")}: ${l.suggested} ${pcs}</button>` : ""}
          <a class="ps-open" href="#/product/${l.product_id}">${t("ps_open_product")}</a>
        </div>
        <label class="ps-move"><span class="muted">${t("ps_supplier")}</span>
          <select data-move="${l.product_id}"><option value="${escapeHtml(l.group)}" selected>${escapeHtml(l.group || t("ps_no_supplier"))}</option></select>
        </label>
      </div>
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
    `${tot.products} ${t("warehouse_reorder_products")} · ${whole(tot.pieces)} ${pcs} · ${whole(tot.liters)} L · <strong>${usd(tot.usd)}</strong>${tot.unpriced ? ` · ${tot.unpriced} ${t("ps_unpriced")}` : ""}`;
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
    if (!order.length) {
      body.innerHTML = `<p class="empty-state">${t("ps_none")}</p>`;
      return;
    }
    body.innerHTML = order
      .map(
        ({ g, list, tot }, k) => `<section class="card ps-supplier" data-group="${escapeHtml(g)}">
          <div class="ps-supplier-head">
            <div class="ps-supplier-title">
              <h2>${escapeHtml(g || t("ps_no_supplier"))}</h2>
              ${viaOf(list).length ? `<p class="muted ps-via">${escapeHtml(t("ps_via").replace("{names}", viaOf(list).join(", ")))}</p>` : ""}
              <p class="muted ps-totals">${totalsHtml(tot)}</p>
            </div>
            <button type="button" class="btn ${k === 0 ? "btn-primary" : ""} btn-has-icon ps-create" data-create="${escapeHtml(g)}" ${tot.products ? "" : "disabled"}>${icons.plus}<span>${escapeHtml(t("ps_create_short"))}</span></button>
          </div>
          ${list.map(lineHtml).join("")}
        </section>`
      )
      .join("");
  }
  render();

  const find = (id) => lines.find((l) => l.product_id === Number(id));
  body.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-toggle]");
    const minus = e.target.closest("[data-minus]");
    const plus = e.target.closest("[data-plus]");
    const reset = e.target.closest("[data-reset]");
    const create = e.target.closest("[data-create]");
    if (toggle) {
      const id = Number(toggle.dataset.toggle);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      toggle.closest(".ps-line").querySelector(".ps-details").hidden = !open.has(id);
      toggle.setAttribute("aria-expanded", String(open.has(id)));
      return;
    }
    if (minus || plus || reset) {
      const l = find((minus ?? plus ?? reset).dataset.minus ?? (minus ?? plus ?? reset).dataset.plus ?? (minus ?? plus ?? reset).dataset.reset);
      if (!l) return;
      l.order = reset ? l.suggested : Math.max(0, l.order + (plus ? l.step_pieces : -l.step_pieces));
      recompute(l);
      redrawLine(l);
      body.querySelector(`[data-line="${l.product_id}"] ${plus ? "[data-plus]" : reset ? "[data-toggle]" : "[data-minus]"}`)?.focus();
      return;
    }
    if (create) {
      const supplier = create.dataset.create;
      const list = lines.filter((l) => l.group === supplier && l.order > 0);
      // every product ordered comes via one transporter: the invoice is written under it, as the Excel writes it (so the two match)
      const via = viaOf(list);
      const invoiceSupplier = via.length === 1 && list.every((l) => l.via) ? via[0] : supplier;
      const { openPurchaseForm } = await import("./purchases/form.js");
      openPurchaseForm(
        {
          supplier: invoiceSupplier,
          status: "ordered",
          expected_date: data.arrival_date,
          // a draft per supplier and DAY: yesterday's draft never replaces today's suggestion (review 2026-11-25)
          draft_tag: `suggest:${supplier.toLowerCase()}:${data.today}`,
          lines: list.map((l) => ({ product_id: l.product_id, product_name: l.name, brand: l.brand, size_l: l.liters_per_piece, qty: l.order, cost_usd: l.cost_usd })),
        },
        { onSaved: () => renderPurchaseSuggestions(root, navigate, what) }
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
    // a line moved by hand is bought from the supplier chosen: its transporter (via) no longer names the invoice (Codex review 2026-11-26);
    // moved back to the card it came from, it is the transporter's again
    if (l.via_original === undefined) l.via_original = l.via ?? null;
    l.group = sel.value;
    l.via = l.group === l.group_original ? l.via_original : null;
    render();
  });
}
