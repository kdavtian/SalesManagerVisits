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
import { escapeHtml, saveBlob } from "../util.js";
import { icons } from "../icons.js";
import { normalizeUnitLabel, compareProducts } from "../productSort.js";
import { purchaseLine } from "../shared/purchaseSuggestion.js";

// dollars as the owner writes them: 4,500$ (whole) and 12.7$ (a piece's price, up to 2 decimals)
const usd = (n) => `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}$`;
const usdPiece = (n) => `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}$`;
// the size is on its chip: it is taken out of the name ("Edge 0W-30 1L" + chip "1 L" -> "Edge 0W-30" + chip; owner 2026-11-26: no duplication)
function nameWithoutSize(name, unit) {
  const m = String(unit ?? "").replace(",", ".").match(/(\d+(?:\.\d+)?)\s*l/i);
  if (!m) return name;
  const n = m[1].replace(".", "[.,]");
  const cut = String(name).replace(new RegExp(`(^|\\s)${n}\\s*(l|լ|ltr|litre|liter)(?=\\s|$)`, "i"), " ").replace(/\s+/g, " ").trim();
  return cut || name;
}
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
        <div class="detail-header-actions">
          <button type="button" class="icon-btn" id="ps-share" aria-label="${t("ps_share")}" disabled>${icons.share}</button>
          <button type="button" class="settings-hint-icon" id="ps-hint" aria-label="${t("more_info")}" aria-expanded="false">!</button>
        </div>
      </div>
      <p class="muted ps-hint" id="ps-hint-text" hidden></p>
      <div class="ps-plan" id="ps-plan"></div>
      <div class="ps-share-pick" id="ps-share-pick" hidden></div>
      <div class="segmented ps-sort" id="ps-sort" role="group" aria-label="${t("ps_sort")}">
        ${["products", "urgency", "price"].map((k) => `<button type="button" class="chip" data-sort="${k}">${t(`ps_sort_${k}`)}</button>`).join("")}
      </div>
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
    <button type="button" class="ps-plan-chip ps-urgent-chip" id="ps-urgent" aria-pressed="false" hidden></button>
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
  // urgency_rank = the server's order inside a card (runs out before the goods come first, then the fewest days left)
  const lines = data.suppliers.flatMap((g) => g.lines.map((l, i) => ({ ...l, group: g.supplier, group_original: g.supplier, urgency_rank: i })));

  // ---- sort (owner, 2026-11-26): by products (as in Stock), by urgency, by price; products by default, remembered on this phone --------
  const SORT_KEY = "fieldvisits_ps_sort";
  let sortBy = "products";
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (["products", "urgency", "price"].includes(saved)) sortBy = saved;
  } catch {
    // private mode: the default
  }
  const SORTS = {
    products: compareProducts,
    // the server's urgency, for every line alike (a line moved to another card sorts right too): runs out before the goods come first,
    // then the fewest days left
    urgency: (a, b) => Number(b.runs_out_before_arrival) - Number(a.runs_out_before_arrival) || (a.days_now ?? 0) - (b.days_now ?? 0) || a.urgency_rank - b.urgency_rank,
    // the most money first; products without a last price after the priced ones
    price: (a, b) => (b.order > 0) - (a.order > 0) || (b.cost_usd != null) - (a.cost_usd != null) || (b.cost_usd ?? 0) * b.order - (a.cost_usd ?? 0) * a.order || compareProducts(a, b),
  };
  const sortBar = root.querySelector("#ps-sort");
  const paintSort = () =>
    sortBar.querySelectorAll("[data-sort]").forEach((b) => {
      b.classList.toggle("chip-active", b.dataset.sort === sortBy);
      b.setAttribute("aria-pressed", String(b.dataset.sort === sortBy));
    });
  paintSort();
  sortBar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b || b.dataset.sort === sortBy) return;
    sortBy = b.dataset.sort;
    try {
      localStorage.setItem(SORT_KEY, sortBy);
    } catch {
      // not remembered: fine
    }
    paintSort();
    render();
  });
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
  // the − / + section (owner 2026-11-26): boxes (or pieces) on top, the line's money under it
  function qtyHtml(l) {
    const boxes = l.kind === "pack" && l.pack_size > 1;
    const big = boxes ? `${l.order / l.pack_size} ${t("ps_boxes")}` : `${l.order} ${pcs}`;
    const money = l.cost_usd != null ? usd(l.cost_usd * l.order) : "—";
    return `<strong>${big}</strong><span class="muted">${money}</span>`;
  }
  // the why of the suggested order (owner 2026-11-26 audit, step 3): cover days' sales + safety + still owed − left on arrival = need,
  // then whole steps, and why one step less when it was
  function whyHtml(l) {
    if (!l.suggested) return "";
    const parts = [`${cover} ${d} × ${num(l.daily_raw ?? l.daily_demand)} = ${whole(l.cover_need)}`];
    if (l.safety_used) parts.push(`+ ${t("ps_why_safety")} ${whole(l.safety_used)}`);
    if (l.backlog) parts.push(`+ ${t("ps_why_owed")} ${whole(l.backlog)}`);
    if (l.stock_at_arrival) parts.push(`− ${t("ps_why_left")} ${whole(l.stock_at_arrival)}`);
    const steps = l.step_pieces ? l.suggested / l.step_pieces : 0;
    // the total is the sum of the parts as shown (each part is rounded), so the line always adds up (review 2026-11-27)
    const shownNeed = Math.max(0, l.cover_need + (l.safety_used || 0) + (l.backlog || 0) - (l.stock_at_arrival || 0));
    const note = l.rounding === "down_covers" ? t("ps_why_down_covers") : l.rounding === "down_trend" ? t("ps_why_down_trend") : "";
    return `<p class="muted ps-why"><strong>${t("ps_why")}:</strong> ${parts.join(" ")} = ${whole(shownNeed)} ${pcs} → ${whole(steps)} × ${whole(l.step_pieces)} = ${whole(l.suggested)} ${pcs}${note ? `. ${escapeHtml(note)}` : ""}</p>`;
  }
  function lineHtml(l) {
    const size = l.unit ? normalizeUnitLabel(l.unit) : "";
    const out = l.stock_now <= 0;
    const flags = [
      // an empty shelf already says "Out of stock" on the row; the badge is for a shelf that empties before the goods come
      out ? `<span class="badge badge-danger">${t("ps_out")}</span>` : l.runs_out_before_arrival ? `<span class="badge badge-danger">${t("ps_runs_out")}</span>` : "",
      l.too_much ? `<span class="badge badge-warning">${t(l.order <= l.step_pieces ? "ps_too_much_step" : "ps_too_much").replace("{days}", Math.round(l.days_after_receiving))}</span>` : "",
      l.pack_size_guessed ? `<span class="badge badge-neutral">${t("ps_pack_guessed")}</span>` : "",
      l.trend === "up" ? `<span class="badge badge-info">${t("ps_trend_up")}</span>` : l.trend === "down" ? `<span class="badge badge-neutral">${t("ps_trend_down")}</span>` : "",
    ].join("");
    const until = l.days_after_receiving != null ? shortDate(addDays(data.arrival_date, l.days_after_receiving)) : "";
    // row 2 (owner 2026-11-26): "Առկա 4 հատ • 23 օր → 43 հատ • 143 օր" -- after receiving = what is left on the arrival day (the free stock
    // minus the sales of the delivery days) + the order, and how long that lasts from the arrival day
    const days = (n) => (n != null ? ` • ${whole(n)} ${d}` : "");
    const now = `<span class="${out ? "ps-out" : ""}">${t("ps_have")} ${whole(l.stock_now)} ${pcs}${days(l.days_now)}</span>`;
    const after = l.order ? ` <span aria-hidden="true">→</span><span class="visually-hidden">${t("ps_after")}</span> ${whole(l.after_receiving)} ${pcs}${days(l.days_after_receiving)}` : "";
    // row 3: the order in pieces x the last price of a piece
    const price = `${whole(l.order)} ${pcs}${l.cost_usd != null ? ` x ${usdPiece(l.cost_usd)}` : ""}`;
    const isOpen = open.has(l.product_id);
    return `<div class="ps-line ${l.order ? "" : "ps-line-off"}" data-line="${l.product_id}">
      <button type="button" class="ps-row" data-toggle="${l.product_id}" aria-expanded="${isOpen}">
        <span class="ps-row-name">${escapeHtml(size ? nameWithoutSize(l.name, l.unit) : l.name)}${size ? ` <span class="inventory-row-size-chip">${escapeHtml(size)}</span>` : ""}</span>
        <span class="ps-row-sub">${now}${after}</span>
        ${flags ? `<span class="ps-flags">${flags}</span>` : ""}
      </button>
      <span class="ps-price">${price}</span>
      <div class="ps-order">
        <button type="button" class="ps-step" data-minus="${l.product_id}" aria-label="${t("ps_less")}" ${l.order ? "" : "disabled"}>−</button>
        <span class="ps-qty" aria-live="polite">${qtyHtml(l)}</span>
        <button type="button" class="ps-step" data-plus="${l.product_id}" aria-label="${t("ps_more")}">+</button>
      </div>
      <div class="ps-details" ${isOpen ? "" : "hidden"}>
        <p class="muted ps-rate">${[
          `${num(l.daily_demand)} ${pcs} ${t("ps_per_day")}`,
          l.coming ? `${t("ps_coming")}: ${whole(l.coming)} ${pcs}` : "",
          `${t("ps_at_arrival")}: ${whole(l.stock_at_arrival)} ${pcs}`,
          until ? `${t("ps_lasts_until")} ${until}` : "",
        ].filter(Boolean).join(" · ")}</p>
        ${whyHtml(l)}
        ${l.lost_before_arrival > 0 ? `<p class="ps-lost">${escapeHtml(t("ps_lost").replace("{pcs}", whole(l.lost_before_arrival)).replace("{days}", whole(l.lost_days)))}${l.price_amd ? ` ≈ ${whole(l.lost_before_arrival * l.price_amd)} ֏` : ""}</p>` : ""}
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
  // "only urgent" (owner 2026-11-26 audit, step 3): out of stock now, or runs out before the goods could come. It only hides rows: the
  // totals, Create and Share still take the whole order of a supplier.
  const isUrgent = (l) => l.stock_now <= 0 || l.runs_out_before_arrival;
  let urgentOnly = false;
  const urgentChip = root.querySelector("#ps-urgent");
  function paintUrgent() {
    const n = lines.filter(isUrgent).length;
    urgentChip.hidden = !n;
    urgentChip.textContent = t("ps_only_urgent").replace("{n}", n);
    urgentChip.classList.toggle("chip-active", urgentOnly);
    urgentChip.setAttribute("aria-pressed", String(urgentOnly));
  }
  urgentChip.addEventListener("click", () => {
    urgentOnly = !urgentOnly;
    paintUrgent();
    render();
  });
  function render() {
    paintUrgent();
    const groups = new Map();
    for (const l of lines) {
      if (!groups.has(l.group)) groups.set(l.group, []);
      groups.get(l.group).push(l);
    }
    // the server's supplier order (by money) stays; a card a line was moved to comes after them, "no supplier" last (review 2026-11-26)
    const rank = new Map(data.suppliers.map((s, i) => [s.supplier, i]));
    const order = [...groups.entries()]
      .map(([g, list]) => ({ g, list, tot: totals(list) }))
      // "urgent only": a supplier with no urgent product is left out (its card would be empty; review 2026-11-27)
      .filter(({ list }) => !urgentOnly || list.some(isUrgent))
      .sort((a, b) => (a.g ? 0 : 1) - (b.g ? 0 : 1) || (rank.get(a.g) ?? 1e6) - (rank.get(b.g) ?? 1e6));
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
            <button type="button" class="btn ${k === 0 ? "btn-primary" : ""} btn-has-icon ps-create" data-create="${escapeHtml(g)}" aria-label="${escapeHtml(`${t("ps_create")}: ${g || t("ps_no_supplier")}`)}" ${tot.products ? "" : "disabled"}>${icons.plus}<span>${escapeHtml(t("ps_create_short"))}</span></button>
          </div>
          ${[...list].filter((l) => !urgentOnly || isUrgent(l)).sort(SORTS[sortBy]).map(lineHtml).join("")}
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
      // focus stays on the button pressed; − at 0 is disabled, so focus goes to + (review 2026-11-26)
      body.querySelector(`[data-line="${l.product_id}"] ${plus || (minus && !l.order) ? "[data-plus]" : reset ? "[data-toggle]" : "[data-minus]"}`)?.focus();
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
          // a what-if keeps its own draft: it never replaces the day's draft made from the settings (review 2026-11-26)
          draft_tag: `suggest:${supplier.toLowerCase()}:${data.today}${trying ? `:w${lead}-${cover}` : ""}`,
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

  // ---- share as Excel (owner, 2026-11-26): SKU, product name, packs -- one supplier's order, in the order shown ----------------------
  const shareBtn = root.querySelector("#ps-share");
  const pick = root.querySelector("#ps-share-pick");
  const ordered = () => {
    const groups = new Map();
    for (const l of lines.filter((x) => x.order > 0)) {
      if (!groups.has(l.group)) groups.set(l.group, []);
      groups.get(l.group).push(l);
    }
    return groups;
  };
  shareBtn.disabled = false;
  async function shareSupplier(supplier) {
    // the file follows the rows as they are on the screen: − / + never moves a row under the finger (the sort applies when it is chosen
    // or the list is drawn again), and the file keeps that same order (Codex review 2026-11-27)
    const shown = new Map([...body.querySelectorAll("[data-line]")].map((el, i) => [Number(el.dataset.line), i]));
    const list = [...(ordered().get(supplier) ?? [])].sort((a, b) => (shown.get(a.product_id) ?? 1e9) - (shown.get(b.product_id) ?? 1e9));
    if (!list.length) return;
    const packs = (l) => (l.kind === "pack" && l.pack_size > 1 ? l.order / l.pack_size : l.order);
    const nameOf = (l) => {
      const size = l.unit ? normalizeUnitLabel(l.unit) : "";
      // the size goes with the name when the name does not say it ("Edge 0W-30" + "1 L")
      return size && !String(l.name).replace(/\s+/g, "").toLowerCase().includes(size.replace(/\s+/g, "").toLowerCase()) ? `${l.name} ${size}` : l.name;
    };
    const columns = [
      { header: t("ps_x_sku"), width: 16 },
      { header: t("ps_x_product"), width: 40 },
      { header: t("ps_x_packs"), type: "number", width: 12 },
    ];
    const rows = list.map((l) => [l.sku ?? "", nameOf(l), packs(l)]);
    const safe = String(supplier || "order").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "order";
    const filename = `purchase-${safe}-${data.today}`;
    shareBtn.disabled = true;
    try {
      await saveBlob(await api.buildXlsx({ filename, sheet: String(supplier || t("ps_no_supplier")).slice(0, 31), columns, rows }), `${filename}.xlsx`);
    } catch (err) {
      pick.hidden = false;
      pick.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    } finally {
      shareBtn.disabled = false;
    }
  }
  shareBtn.addEventListener("click", () => {
    const groups = [...ordered().keys()];
    if (groups.length === 1) {
      pick.hidden = true;
      shareSupplier(groups[0]);
      return;
    }
    // several suppliers with something to order: which one goes to the file (one supplier = one order)
    pick.hidden = false; // always the current suppliers (a supplier may have gone to 0 since), and an old error is replaced
    pick.innerHTML = groups.length
      ? `<p class="muted">${escapeHtml(t("ps_share_pick"))}</p>${groups.map((g) => `<button type="button" class="chip" data-share="${escapeHtml(g)}">${escapeHtml(g || t("ps_no_supplier"))}</button>`).join("")}`
      : `<p class="muted">${escapeHtml(t("ps_share_none"))}</p>`;
  });
  pick.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share]");
    if (!b) return;
    pick.hidden = true;
    shareSupplier(b.dataset.share);
  });
}
