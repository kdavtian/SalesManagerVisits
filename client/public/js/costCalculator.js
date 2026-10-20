// Cost & margin calculator (Products page, management only). Two ways in:
//  - "From catalog": pick a product -> its landing cost (from the Excel) and prices are filled in; change the selling price
//    and see the net cost, margins, the price for a target margin, the result at every price level, and where the price goes;
//  - "New product": enter the pack (brand, size, items, kg, supplier price in USD) -> the landing cost is computed with the
//    import rules (per-brand freight and legal transport), then the same net cost / margin view.
// The sales channel decides the commission (SM channels 4 %, CVO/PCO/OEM 2 %, KF/CAS 0 %). Two methods: the workbook's
// (default) and the VAT-payer method; the result of the other one is always shown in one line.
// The maths is costModel.js (shared with the server's discount approvals). Settings (rates, per-brand freight, cost items,
// method) live in a second sheet, in sections, with the full methodology at the end; they are kept on this device only.
import { api } from "./api.js";
import { t, getLang } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, groupDigits, openInfoPopup, SALES_CHANNELS, channelDisplayLabel } from "./util.js";
import {
  COST_RATES_DEFAULT,
  DEFAULT_COST_ITEMS,
  RATE_MARKET_HINT,
  commissionPct,
  landingCost,
  litersOfUnit,
  mergeSavedRates,
  netCost,
  priceForNetMargin,
} from "./costModel.js";

const STORE_KEY = "fv_cost_calc";
const STORE_VERSION = 2; // 1 = the first calculator (no per-brand freight, commissions or cost items): its rates are dropped
const loadStore = () => {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null") || {};
    return s.v === STORE_VERSION ? s : { target: s.target, withFixed: s.withFixed };
  } catch {
    return {};
  }
};
const saveStore = (v) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...v, v: STORE_VERSION }));
  } catch {
    /* private mode: settings just last for this session */
  }
};

const amd = (n) => (Number.isFinite(n) ? groupDigits(Math.round(n)) : "—");
const usd = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const pct = (n) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);
const readNum = (el) => {
  const v = parseFloat(String(el.value).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};
const trim = (n, d = 6) => +Number(n).toFixed(d);
const NEW_BRANDS = ["Castrol", "Royal", "Lotos", "Orlen", "Other"];
const ITEM_UNITS = { pct: "cc_unit_pct", liter: "cc_unit_liter", pack: "cc_unit_pack" };

export function openCostCalculator({ products: given = [], product = null } = {}) {
  let products = given;
  const store = loadStore();
  let appRates = null; // freight / customs / excise ... from App configuration (loaded just after opening)
  let rates = mergeSavedRates(store.rates);
  let withFixed = store.withFixed !== false;
  let targetPct = Number.isFinite(store.target) ? store.target : 10;
  let channel = typeof store.channel === "string" ? store.channel : ""; // "" = dearest case (no channel)
  let mode = product || products.length ? "catalog" : "new";
  let picked = product;
  let landingOverride = null; // catalog mode: typed landing cost (null = the Excel value)
  const persist = () => saveStore({ rates, withFixed, target: targetPct, channel });
  const isCustom = () => JSON.stringify(mergeSavedRates(rates)) !== JSON.stringify(mergeSavedRates(null, appRates));

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet cost-calc" role="dialog" aria-modal="true">
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <div class="cc-title"><h2>${t("cc_title")}</h2><button type="button" class="settings-hint-icon" id="cc-hint" aria-label="${t("more_info")}">!</button></div>
      <div class="cc-topbar">
        <div class="segmented cc-modes" id="cc-modes">
          <button type="button" class="chip" data-mode="catalog">${t("cc_mode_catalog")}</button>
          <button type="button" class="chip" data-mode="new">${t("cc_mode_new")}</button>
        </div>
        <button type="button" class="icon-btn cc-gear" id="cc-gear" aria-label="${t("cc_settings")}" title="${t("cc_settings")}">${icons.settings || icons.calculator}<span class="cc-gear-dot" id="cc-custom" hidden></span></button>
      </div>
      <div id="cc-inputs"></div>
      <div class="cc-opts">
        <label class="cc-field cc-channel"><span>${t("cc_channel")}</span>
          <select id="cc-channel">
            <option value="">${t("cc_channel_none")}</option>
            ${SALES_CHANNELS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(channelDisplayLabel(c))}</option>`).join("")}
          </select>
        </label>
        <div class="cc-field cc-method"><span>${t("cc_method")} <button type="button" class="settings-hint-icon" id="cc-method-hint" aria-label="${t("more_info")}">!</button></span>
          <div class="segmented" id="cc-method">
            <button type="button" class="chip" data-vat="workbook">${t("cc_method_workbook")}</button>
            <button type="button" class="chip" data-vat="payer">${t("cc_method_payer")}</button>
          </div>
        </div>
      </div>
      <div id="cc-results"></div>
      <details class="cc-details" id="cc-break"><summary>${t("cc_breakdown")}</summary><div class="cc-table" id="cc-table"></div></details>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  $('[data-action="close"]').addEventListener("click", () => overlay.remove());
  $("#cc-hint").addEventListener("click", () => openInfoPopup(`<p>${t("cc_hint")}</p>`));
  $("#cc-method-hint").addEventListener("click", () => openInfoPopup(`<p>${t("cc_method_hint")}</p>`));
  $("#cc-channel").value = channel;
  $("#cc-channel").addEventListener("change", () => {
    channel = $("#cc-channel").value;
    persist();
    paintResults();
  });
  const paintMethod = () => $("#cc-method").querySelectorAll("[data-vat]").forEach((b) => b.classList.toggle("chip-active", b.dataset.vat === rates.vatMode));
  $("#cc-method").querySelectorAll("[data-vat]").forEach((b) =>
    b.addEventListener("click", () => {
      rates.vatMode = b.dataset.vat;
      persist();
      paintMethod();
      paintResults();
    })
  );

  // ----- inputs (built once per mode; the results below repaint on every keystroke without touching the inputs) -----
  const numField = (id, label, value, step = "any") =>
    `<label class="cc-field"><span>${label}</span><input id="${id}" type="number" inputmode="decimal" step="${step}" min="0" value="${value ?? ""}" /></label>`;

  function productLabel(p) {
    const hasSize = p.unit && String(p.name).toLowerCase().replace(/\s+/g, "").includes(String(p.unit).toLowerCase().replace(/\s+/g, ""));
    return `${p.brand ? `${p.brand} · ` : ""}${p.name}${p.unit && !hasSize ? ` · ${p.unit}` : ""}`;
  }
  function tierPrice(p, key) {
    return key === "retail" ? Number(p.effective_retail_amd ?? p.retail_price_amd) || 0 : Number(p[`${key}_price_amd`]) || 0;
  }
  function defaultPrice(p) {
    return tierPrice(p, "silver") || tierPrice(p, "bronze") || Number(p.unit_price_amd) || 0;
  }
  const tierList = () =>
    picked
      ? [["bronze", "col_bronze"], ["silver", "col_silver"], ["gold", "col_gold"], ["retail", "price_retail"]]
          .map(([k, label]) => [k, t(label), tierPrice(picked, k)])
          .filter(([, , v]) => v > 0)
      : [];

  const newPack = { size: "", items: "", packKg: "", packCostUsd: "" };
  let newBrand = "Castrol";
  let newPrice = "";
  const priceField = (value) => `<label class="cc-field cc-price"><span>${t("cc_price")}</span><input id="cc-price" type="number" inputmode="decimal" step="any" min="0" value="${value || ""}" /></label>`;

  function paintInputs() {
    const box = $("#cc-inputs");
    $("#cc-modes").querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("chip-active", b.dataset.mode === mode));
    if (mode === "catalog") {
      box.innerHTML = `
        <div class="cc-field cc-pick">
          <span>${t("cc_product")}</span>
          ${
            picked
              ? `<div class="cc-picked"><strong>${escapeHtml(productLabel(picked))}</strong><button type="button" class="task-chip-x" id="cc-unpick" aria-label="${t("task_change_customer")}">${icons.close}</button></div>`
              : `<input type="search" id="cc-search" placeholder="${t("cc_search_product")}" autocomplete="off" aria-label="${t("cc_search_product")}" /><div class="cc-results-list" id="cc-pick-list" hidden></div>`
          }
        </div>
        ${picked ? catalogFields() : ""}`;
      if (picked) {
        $("#cc-unpick").addEventListener("click", () => {
          picked = null;
          landingOverride = null;
          paintInputs();
          paintResults();
        });
        bindCommon();
        $("#cc-landing-in").addEventListener("input", () => {
          landingOverride = readNum($("#cc-landing-in"));
          paintResults();
        });
      } else {
        const search = $("#cc-search");
        const list = $("#cc-pick-list");
        search.addEventListener("input", () => {
          const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
          if (!words.length) {
            list.hidden = true;
            return;
          }
          const found = products.filter((p) => words.every((w) => productLabel(p).toLowerCase().includes(w))).slice(0, 8);
          list.hidden = false;
          list.innerHTML = found.length
            ? found.map((p) => `<button type="button" class="cc-result" data-id="${p.id}">${escapeHtml(productLabel(p))}</button>`).join("")
            : `<p class="muted cc-empty">${t("cc_no_products")}</p>`;
          list.querySelectorAll("[data-id]").forEach((b) =>
            b.addEventListener("click", () => {
              picked = products.find((p) => String(p.id) === b.dataset.id);
              landingOverride = null;
              paintInputs();
              paintResults();
            })
          );
        });
        search.focus({ preventScroll: true });
      }
    } else {
      box.innerHTML = `
        <div class="cc-field"><span>${t("cc_brand")}</span>
          <div class="segmented cc-brands" id="cc-brands">${NEW_BRANDS.map((b) => `<button type="button" class="chip ${b === newBrand ? "chip-active" : ""}" data-brand="${b}">${b === "Other" ? t("cc_brand_other") : b}</button>`).join("")}</div>
        </div>
        <div class="cc-grid">
          ${numField("cc-size", t("cc_size"), newPack.size)}
          ${numField("cc-items", t("cc_items"), newPack.items)}
          ${numField("cc-kg", t("cc_pack_kg"), newPack.packKg)}
          ${numField("cc-cost", t("cc_pack_cost"), newPack.packCostUsd)}
        </div>
        ${priceField(newPrice)}`;
      box.querySelectorAll("[data-brand]").forEach((b) =>
        b.addEventListener("click", () => {
          newBrand = b.dataset.brand;
          box.querySelectorAll("[data-brand]").forEach((x) => x.classList.toggle("chip-active", x === b));
          paintResults();
        })
      );
      for (const [id, key] of [["cc-size", "size"], ["cc-items", "items"], ["cc-kg", "packKg"], ["cc-cost", "packCostUsd"]]) {
        $(`#${id}`).addEventListener("input", () => {
          newPack[key] = readNum($(`#${id}`));
          paintResults();
        });
      }
      bindCommon();
    }
  }
  function catalogFields() {
    const wb = Number(picked.landing_cost_amd) || 0;
    return `
      ${numField("cc-landing-in", t("cc_landing_in"), landingOverride ?? (wb || ""))}
      ${wb ? "" : `<p class="form-error cc-note">${t("cc_no_landing")}</p>`}
      ${priceField(defaultPrice(picked))}`;
  }
  function bindCommon() {
    $("#cc-price").addEventListener("input", () => {
      if (mode === "new") newPrice = readNum($("#cc-price"));
      paintResults();
    });
  }

  // ----- results -----
  function current() {
    const price = $("#cc-price") ? readNum($("#cc-price")) : 0;
    if (mode === "catalog") {
      if (!picked) return null;
      const landingAmd = landingOverride ?? (Number(picked.landing_cost_amd) || 0);
      const liters = litersOfUnit(picked.unit);
      return { price, landingAmd, liters, parts: null, landing: null, vatIn: null };
    }
    const landing = landingCost({ brand: newBrand, size: newPack.size, items: newPack.items, packKg: newPack.packKg, packCostUsd: newPack.packCostUsd }, rates);
    return { price, landingAmd: landing.amd, liters: Number(newPack.size) || 0, landing, parts: landing, vatIn: landing.vat * rates.rate };
  }
  // the same pack under the other VAT method, for the one-line comparison
  const other = (c) => {
    const alt = { ...rates, vatMode: rates.vatMode === "payer" ? "workbook" : "payer" };
    return netCost({ landing: c.landingAmd, price: c.price, liters: c.liters }, alt, { withFixed, channel: channel || null, vatIn: c.vatIn });
  };

  function paintResults() {
    paintMethod();
    $("#cc-custom").hidden = !isCustom();
    const c = current();
    const res = $("#cc-results");
    const table = $("#cc-table");
    if (!c) {
      res.innerHTML = "";
      table.innerHTML = "";
      return;
    }
    const opts = { withFixed, channel: channel || null, vatIn: c.vatIn };
    const hasLanding = c.landingAmd > 0;
    const hasPrice = c.price > 0;
    const ok = hasLanding && hasPrice;
    const n = netCost({ landing: c.landingAmd, price: c.price, liters: c.liters }, rates, opts);
    const fig = (k, v, x, cls = "") => `<div class="cc-fig ${cls}"><div class="cc-k">${k}</div><div class="cc-v">${v}</div><div class="cc-x">${x}</div></div>`;
    const perL = (v) => (c.liters > 0 ? `${amd(v / c.liters)} ${t("cc_per_l")}` : "");
    const excelNet = mode === "catalog" && picked && Number(picked.net_cost_workbook_amd) > 0 ? Number(picked.net_cost_workbook_amd) : null;
    const comm = commissionPct(channel || null, rates);

    let html = `<p class="cc-caption">${t("cc_caption")} · ${t("cc_commission")} <b>${trim(comm, 2)}%</b></p><div class="cc-figs">
      ${fig(t("landing_cost"), hasLanding ? amd(c.landingAmd) : "—", hasLanding ? [c.landing ? `$${usd(c.landing.usd)}` : "", perL(c.landingAmd)].filter(Boolean).join(" · ") : t("cc_enter_pack"))}
      ${fig(t("net_cost"), ok ? amd(n.net) : "—", ok ? [perL(n.net), excelNet ? t("cc_excel_shows").replace("{amount}", amd(excelNet)) : ""].filter(Boolean).join(" · ") : hasPrice ? t("cc_enter_pack") : t("cc_enter_price"))}
      ${fig(t("cc_profit"), ok ? amd(n.profit) : "—", ok ? [perL(n.profit), `${t("cc_margin")} ${pct(n.margin)}`].filter(Boolean).join(" · ") : "", ok && n.profit < 0 ? "cc-neg" : "")}
      ${fig(t("cc_net_margin"), ok ? pct(n.netMargin) : "—", ok ? `${t("cc_of_price")}` : "", `cc-hero ${ok && n.netMargin < 0 ? "cc-neg" : ""}`)}
    </div>`;
    if (ok) {
      const o = other(c);
      const d = o.net - n.net;
      html += `<p class="cc-alt"><span class="muted">${t(rates.vatMode === "payer" ? "cc_alt_workbook" : "cc_alt_payer")}</span> <b>${amd(o.net)}</b> <span class="${d < 0 ? "cc-diff" : "cc-diff cc-neg"}">${d > 0 ? "+" : ""}${amd(d)}</span> · ${pct(o.netMargin)}</p>`;
    }
    if (ok && n.profit < 0) html += `<p class="cc-warn">${t("cc_below_cost").replace("{amount}", amd(-n.profit))}</p>`;
    if (ok && c.price < c.landingAmd) html += `<p class="cc-warn">${t("cc_below_landing")}</p>`;

    if (hasLanding) {
      const be = priceForNetMargin({ landing: c.landingAmd, liters: c.liters }, 0, rates, opts);
      const target = priceForNetMargin({ landing: c.landingAmd, liters: c.liters }, targetPct, rates, opts);
      const diff = target != null && hasPrice ? target - c.price : null;
      html += `<div class="cc-target">
        <div class="cc-target-top">
          <label class="cc-field cc-target-in"><span>${t("cc_target")}</span><input id="cc-target" type="number" inputmode="decimal" step="any" value="${targetPct}" /></label>
          <div class="cc-presets">${[5, 10, 15, 20, 25].map((v) => `<button type="button" class="chip ${v === targetPct ? "chip-active" : ""}" data-preset="${v}">${v}%</button>`).join("")}</div>
        </div>
        <div class="cc-target-out">
          <div><span class="muted">${t("cc_price_for_target").replace("{pct}", targetPct)}</span><strong>${target != null ? amd(target) : "—"}</strong>${diff != null ? `<span class="cc-diff ${diff > 0 ? "cc-neg" : ""}">${diff > 0 ? "+" : ""}${amd(diff)}</span>` : ""}${target != null && c.liters > 0 ? `<span class="muted">${perL(target)}</span>` : ""}</div>
          <div><span class="muted">${t("cc_breakeven")}</span><strong>${be != null ? amd(be) : "—"}</strong>${be != null && c.liters > 0 ? `<span class="muted">${perL(be)}</span>` : ""}</div>
        </div>
      </div>`;
    }

    // every price level of the product at once (tap a row to try that price)
    const tiers = mode === "catalog" ? tierList() : [];
    if (hasLanding && tiers.length) {
      html += `<div class="cc-levels"><div class="cc-anat-title">${t("cc_levels")}</div><table>
        <tr><th></th><th>${t("cc_price_short")}</th><th>${t("net_cost")}</th><th>${t("cc_profit")}</th><th>%</th></tr>
        ${tiers
          .map(([k, label, v]) => {
            const x = netCost({ landing: c.landingAmd, price: v, liters: c.liters }, rates, opts);
            return `<tr class="cc-level ${x.profit < 0 ? "cc-neg" : ""}" data-tier="${k}" tabindex="0" role="button"><td>${escapeHtml(label)}</td><td>${amd(v)}</td><td>${amd(x.net)}</td><td>${amd(x.profit)}</td><td>${pct(x.netMargin)}</td></tr>`;
          })
          .join("")}
      </table></div>`;
    }

    // where the selling price goes
    if (ok) {
      const R = rates.rate;
      const segs = c.parts
        ? [
            [t("cc_seg_purchase"), c.parts.cost * R, "--cc-1"],
            [t("cc_seg_transport"), (c.parts.tLegal + c.parts.tReal) * R, "--cc-2"],
            [t("cc_seg_duties"), (c.parts.eco + c.parts.customs + c.parts.excise + c.parts.vat + c.parts.handling + c.parts.other) * R, "--cc-3"],
          ]
        : [[t("landing_cost"), c.landingAmd, "--cc-1"]];
      segs.push([t("cc_seg_commission"), n.commission, "--cc-4"], [t("cc_seg_taxes"), n.vatTax + n.ptax, "--cc-5"]);
      if (withFixed) segs.push([t("cc_seg_overhead"), n.overhead, "--cc-6"]);
      segs.push([t("cc_seg_profit"), Math.max(n.profit, 0), "--cc-7"]);
      const total = Math.max(c.price, n.net) || 1;
      html += `<div class="cc-anat"><div class="cc-anat-title">${t("cc_where")}</div>
        <div class="cc-bar" role="img" aria-label="${t("cc_where")}">${segs.map(([name, v, col]) => `<span style="flex-basis:${(Math.max(v, 0) / total) * 100}%;background:var(${col})" title="${escapeHtml(name)}: ${amd(v)}"></span>`).join("")}</div>
        <div class="cc-legend">${segs.map(([name, v, col]) => `<span><i style="background:var(${col})"></i>${escapeHtml(name)} <b>${amd(v)}</b></span>`).join("")}</div></div>`;
    }
    res.innerHTML = html;

    const tIn = $("#cc-target");
    if (tIn) {
      tIn.addEventListener("input", () => {
        targetPct = readNum(tIn);
        persist();
        const keep = tIn.value; // repaint only the numbers so the field keeps focus
        paintResults();
        const again = $("#cc-target");
        again.value = keep;
        again.focus({ preventScroll: true });
      });
    }
    res.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        targetPct = Number(b.dataset.preset);
        persist();
        paintResults();
      })
    );
    res.querySelectorAll("[data-tier]").forEach((row) => {
      const go = () => {
        $("#cc-price").value = tierPrice(picked, row.dataset.tier) || "";
        paintResults();
      };
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
    });

    // full breakdown
    const row = (name, u, a, formula, cls = "") =>
      `<tr class="${cls}"><td>${name}${formula ? `<span class="cc-formula">${formula}</span>` : ""}</td><td>${u == null ? "" : usd(u)}</td><td>${Number.isFinite(a) ? amd(a) : ""}</td></tr>`;
    const R = rates.rate;
    let rows = `<tr><th></th><th>USD</th><th>${t("amd")}</th></tr>`;
    if (c.parts) {
      const p = c.parts;
      rows +=
        row(t("cc_row_cost"), p.cost, p.cost * R, t("cc_f_cost")) +
        row(t("cc_row_tlegal"), p.tLegal, p.tLegal * R) +
        row(t("cc_row_treal"), p.tReal, p.tReal * R) +
        row(t("cc_row_eco"), p.eco, p.eco * R, `${rates.eco}%`) +
        row(t("cc_row_customs"), p.customs, p.customs * R, `${rates.customs}%`) +
        row(t("cc_row_excise"), p.excise, p.excise * R, `${rates.excise} ${t("amd")}/${t("cc_kg")}`) +
        row(t("cc_row_vat"), p.vat, p.vat * R, `${rates.vat}%`) +
        row(t("cc_row_handling"), p.handling, p.handling * R) +
        (p.other ? row(t("cc_row_other"), p.other, p.other * R) : "") +
        row(t("landing_cost"), p.usd, p.amd, "", "cc-tot");
    } else {
      rows += row(t("landing_cost"), null, c.landingAmd, mode === "catalog" && landingOverride == null ? t("cc_f_excel") : "", "cc-tot");
    }
    rows += row(t("cc_seg_commission"), null, n.commission, `${trim(n.commissionPct, 2)}% × ${t("cc_price_short")}`);
    for (const it of n.items) {
      const name = it.labelKey ? t(it.labelKey) : escapeHtml(it.label || "");
      const f = it.kind === "pct" ? `${trim(it.value, 2)}% × ${t("cc_price_short")}` : it.kind === "liter" ? `${trim(it.value, 2)} ${t("amd")} × ${trim(c.liters, 2)} ${t("cc_l")}` : t("cc_unit_pack");
      rows += row(name, null, it.amount, f);
    }
    if (n.mode === "payer") {
      rows +=
        row(t("cc_row_vat_state"), null, n.vatTax, `${t("cc_price_short")} − ${t("cc_price_short")}/${trim(1 + rates.vat / 100, 2)} − ${t("cc_row_vat")} (${amd(n.vatIn)})`) +
        row(t("cc_row_ptax"), null, n.ptax, `${rates.ptax}% × (${t("cc_f_revenue_ex")} − ${t("landing_cost")} + ${t("cc_row_vat")} − ${t("cc_seg_commission")} − ${t("cc_seg_overhead")})`);
    } else {
      rows +=
        row(t("cc_row_vattax"), null, n.vatTax, `${rates.vatTax}% × (${t("cc_price_short")} − ${t("landing_cost")})`) +
        row(t("cc_row_ptax"), null, n.ptax, `${rates.ptax}% × (${t("cc_price_short")} − ${t("landing_cost")} − ${t("cc_row_vattax")})`);
    }
    rows += row(t("net_cost"), null, ok ? n.net : NaN, "", "cc-tot");
    table.innerHTML = `<table>${rows}</table>`;
  }

  $("#cc-modes").querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      paintInputs();
      paintResults();
    })
  );
  $("#cc-gear").addEventListener("click", () =>
    openCostSettings({
      getRates: () => rates,
      getBase: () => mergeSavedRates(null, appRates),
      setRates: (r) => {
        rates = r;
        persist();
        paintResults();
      },
      getWithFixed: () => withFixed,
      setWithFixed: (v) => {
        withFixed = v;
        persist();
        paintResults();
      },
    })
  );

  paintInputs();
  paintResults();
  // The rates set in App configuration are this calculator's starting point; a phone that saved its own rates keeps them.
  api
    .getSettings()
    .then((s) => {
      if (!s?.landing_rates) return;
      appRates = s.landing_rates;
      if (!store.rates) {
        rates = mergeSavedRates(null, appRates);
        paintResults();
      }
    })
    .catch(() => {});
  // Opened from a single product: the catalog (for "pick another product") loads in the background.
  if (!products.length) {
    api
      .listProducts()
      .then((list) => {
        products = list.filter((p) => String(p.family || "").toLowerCase() !== "merch");
      })
      .catch(() => {});
  }
}

// ======================================================================================================================
// Settings: a second sheet, in sections. Every change is applied (and remembered on this phone) at once.
// ======================================================================================================================
function openCostSettings({ getRates, getBase, setRates, getWithFixed, setWithFixed }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay cc-settings-overlay";
  overlay.innerHTML = `<div class="sheet cost-calc cc-settings" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const sheet = overlay.querySelector(".sheet");
  const openSections = new Set(["rate"]);

  const rateInput = (key, label, unit = "", step = "any") =>
    `<label class="cc-field cc-set-row"><span>${label}</span><span class="cc-set-in"><input data-rate="${key}" type="number" inputmode="decimal" step="${step}" value="${trim(getRates()[key])}" />${unit ? `<em>${unit}</em>` : ""}</span></label>`;
  const section = (id, title, summary, body) =>
    `<details class="cc-sec" data-sec="${id}" ${openSections.has(id) ? "open" : ""}><summary><span>${title}</span><small>${summary}</small></summary><div class="cc-sec-body">${body}</div></details>`;

  function itemRow(it) {
    const name = it.labelKey ? t(it.labelKey) : escapeHtml(it.label || "");
    return `<div class="cc-item ${it.on === false ? "cc-item-off" : ""}" data-item="${escapeHtml(it.id)}">
      <label class="cc-item-on"><input type="checkbox" data-item-on ${it.on === false ? "" : "checked"} aria-label="${name}" /></label>
      <span class="cc-item-name">${name}${it.custom ? "" : `<small>${t(`${it.labelKey}_src`)}</small>`}</span>
      <span class="cc-set-in cc-item-val"><input data-item-val type="number" inputmode="decimal" step="any" value="${trim(it.value, 4)}" aria-label="${name}" /><em>${t(ITEM_UNITS[it.kind])}</em></span>
      ${it.custom ? `<button type="button" class="icon-btn cc-item-del" data-item-del aria-label="${t("delete")}">${icons.trash}</button>` : ""}
    </div>`;
  }

  function summaryOfItems() {
    const r = getRates();
    const on = (r.items || []).filter((i) => i.on !== false);
    const p = on.filter((i) => i.kind === "pct").reduce((a, i) => a + Number(i.value), 0);
    const l = on.filter((i) => i.kind === "liter").reduce((a, i) => a + Number(i.value), 0);
    const k = on.filter((i) => i.kind === "pack").reduce((a, i) => a + Number(i.value), 0);
    return `${trim(p, 2)}% ${t("cc_of_price")}${l ? ` + ${trim(l, 1)} ${t("cc_per_l")}` : ""}${k ? ` + ${amd(k)} ${t("cc_unit_pack")}` : ""}`;
  }

  function paint() {
    const r = getRates();
    const marketNote = r.rate !== RATE_MARKET_HINT.value ? `<button type="button" class="cc-hintbtn" id="cc-market">${t("cc_market_rate").replace("{rate}", RATE_MARKET_HINT.value).replace("{date}", RATE_MARKET_HINT.asOf)}</button>` : "";
    sheet.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <div class="cc-title"><h2>${t("cc_settings")}</h2></div>
      <p class="muted cc-set-intro">${t("cc_set_intro")}</p>
      ${section("rate", t("cc_sec_rate"), `${trim(r.rate)} ${t("amd")}/USD`, `${rateInput("rate", t("cc_set_rate"), t("amd"))}${marketNote}`)}
      ${section(
        "duties",
        t("cc_sec_duties"),
        `${r.customs}% · ${r.eco}% · ${r.excise}/${t("cc_kg")}`,
        `${rateInput("customs", t("cc_set_customs"), "%")}${rateInput("eco", t("cc_set_eco"), "%")}${rateInput("excise", t("cc_set_excise"), `${t("amd")}/${t("cc_kg")}`)}${rateInput("vat", t("cc_set_vat"), "%")}${rateInput("handling", t("cc_set_handling"), "USD/L")}${rateInput("otherUsd", t("cc_set_other"), "USD")}<p class="muted cc-note">${t("cc_set_duties_note")}</p>`
      )}
      ${section(
        "transport",
        t("cc_sec_transport"),
        `${trim(r.tRealCastrol, 3)} / ${trim(r.tRealRoyal, 3)} / ${trim(r.tRealLotos, 3)} USD/${t("cc_kg")}`,
        `<p class="muted cc-note">${t("cc_set_transport_note")}</p>
        <table class="cc-brandtbl"><tr><th></th><th>${t("cc_real")}<small>USD/${t("cc_kg")}</small></th><th>${t("cc_legal")}<small>USD/${t("cc_kg")}</small></th></tr>
        ${[["Castrol", "Castrol"], ["Royal", "Royal"], ["Lotos", "Lotos + Orlen"], ["Other", t("cc_brand_other")]]
          .map(([k, label]) => `<tr><td>${label}</td><td><input data-rate="tReal${k}" type="number" inputmode="decimal" step="any" value="${trim(r[`tReal${k}`])}" /></td><td><input data-rate="tLegal${k}" type="number" inputmode="decimal" step="any" value="${trim(r[`tLegal${k}`])}" /></td></tr>`)
          .join("")}</table>`
      )}
      ${section(
        "commission",
        t("cc_sec_commission"),
        `SM ${trim(r.commDirector + r.commRep, 2)}% · CVO/PCO/OEM ${trim(r.commDirector, 2)}% · KF/CAS 0%`,
        `${rateInput("commDirector", t("cc_set_comm_director"), "%")}${rateInput("commRep", t("cc_set_comm_rep"), "%")}<p class="muted cc-note">${t("cc_set_comm_note")}</p>`
      )}
      ${section(
        "items",
        t("cc_sec_items"),
        summaryOfItems(),
        `<label class="cc-check"><input type="checkbox" id="cc-fixed" ${getWithFixed() ? "checked" : ""} /> <span>${t("cc_include_overhead")}</span></label>
        <p class="muted cc-note">${t("cc_set_items_note")}</p>
        <div class="cc-items">${(r.items || []).map(itemRow).join("")}</div>
        <div class="cc-add">
          <input id="cc-add-name" type="text" maxlength="60" placeholder="${t("cc_add_name")}" aria-label="${t("cc_add_name")}" />
          <select id="cc-add-kind" aria-label="${t("cc_add_unit")}">${Object.entries(ITEM_UNITS).map(([k, key]) => `<option value="${k}">${t(key)}</option>`).join("")}</select>
          <input id="cc-add-val" type="number" inputmode="decimal" step="any" placeholder="0" aria-label="${t("cc_add_value")}" />
          <button type="button" class="btn btn-primary" id="cc-add-btn">${t("cc_add_btn")}</button>
        </div>`
      )}
      ${section(
        "taxes",
        t("cc_sec_taxes"),
        `${r.ptax}% · ${r.vatMode === "payer" ? t("cc_method_payer") : t("cc_method_workbook")}`,
        `${rateInput("ptax", t("cc_set_ptax"), "%")}${rateInput("vatTax", t("cc_set_vattax"), "%")}${rateInput("vatShare", t("cc_set_vatshare"), "0–1", "0.01")}
        <div class="cc-field"><span>${t("cc_method")}</span><div class="segmented" id="cc-s-method"><button type="button" class="chip ${r.vatMode === "workbook" ? "chip-active" : ""}" data-vat="workbook">${t("cc_method_workbook")}</button><button type="button" class="chip ${r.vatMode === "payer" ? "chip-active" : ""}" data-vat="payer">${t("cc_method_payer")}</button></div></div>
        <p class="muted cc-note">${t("cc_method_hint")}</p>`
      )}
      ${section("method", t("cc_sec_method"), t("cc_sec_method_sub"), methodologyHtml())}
      <div class="sheet-actions"><button type="button" class="btn" id="cc-reset">${t("cc_reset")}</button><button type="button" class="btn btn-primary" data-action="close">${t("done")}</button></div>`;
    bind();
  }

  function bind() {
    sheet.querySelectorAll('[data-action="close"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
    sheet.querySelectorAll("details.cc-sec").forEach((d) => d.addEventListener("toggle", () => (d.open ? openSections.add(d.dataset.sec) : openSections.delete(d.dataset.sec))));
    sheet.querySelectorAll("[data-rate]").forEach((inp) =>
      inp.addEventListener("input", () => {
        const r = { ...getRates(), [inp.dataset.rate]: readNum(inp) };
        setRates(r);
        refreshSummaries();
      })
    );
    sheet.querySelector("#cc-market")?.addEventListener("click", () => {
      setRates({ ...getRates(), rate: RATE_MARKET_HINT.value });
      paint();
    });
    sheet.querySelector("#cc-fixed").addEventListener("change", (e) => setWithFixed(e.target.checked));
    sheet.querySelectorAll("#cc-s-method [data-vat]").forEach((b) =>
      b.addEventListener("click", () => {
        setRates({ ...getRates(), vatMode: b.dataset.vat });
        paint();
      })
    );
    const updateItem = (id, patch) => {
      const r = getRates();
      setRates({ ...r, items: r.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
      refreshSummaries();
    };
    sheet.querySelectorAll("[data-item]").forEach((rowEl) => {
      const id = rowEl.dataset.item;
      rowEl.querySelector("[data-item-on]").addEventListener("change", (e) => {
        rowEl.classList.toggle("cc-item-off", !e.target.checked);
        updateItem(id, { on: e.target.checked });
      });
      rowEl.querySelector("[data-item-val]").addEventListener("input", (e) => updateItem(id, { value: readNum(e.target) }));
      rowEl.querySelector("[data-item-del]")?.addEventListener("click", () => {
        const r = getRates();
        setRates({ ...r, items: r.items.filter((i) => i.id !== id) });
        openSections.add("items");
        paint();
      });
    });
    sheet.querySelector("#cc-add-btn").addEventListener("click", () => {
      const label = sheet.querySelector("#cc-add-name").value.trim();
      if (!label) {
        sheet.querySelector("#cc-add-name").focus();
        return;
      }
      const r = getRates();
      setRates({ ...r, items: [...r.items, { id: `c${Date.now()}`, label, kind: sheet.querySelector("#cc-add-kind").value, value: readNum(sheet.querySelector("#cc-add-val")), on: true, custom: true }] });
      openSections.add("items");
      paint();
    });
    sheet.querySelector("#cc-reset").addEventListener("click", () => {
      setRates(getBase());
      setWithFixed(true);
      paint();
    });
  }

  // keep the one-line summaries of the closed sections current while numbers are typed (without repainting the inputs)
  function refreshSummaries() {
    const r = getRates();
    const set = (id, text) => {
      const el = sheet.querySelector(`details[data-sec="${id}"] summary small`);
      if (el) el.textContent = text;
    };
    set("rate", `${trim(r.rate)} ${t("amd")}/USD`);
    set("duties", `${r.customs}% · ${r.eco}% · ${r.excise}/${t("cc_kg")}`);
    set("transport", `${trim(r.tRealCastrol, 3)} / ${trim(r.tRealRoyal, 3)} / ${trim(r.tRealLotos, 3)} USD/${t("cc_kg")}`);
    set("commission", `SM ${trim(r.commDirector + r.commRep, 2)}% · CVO/PCO/OEM ${trim(r.commDirector, 2)}% · KF/CAS 0%`);
    set("items", summaryOfItems());
    set("taxes", `${r.ptax}% · ${r.vatMode === "payer" ? t("cc_method_payer") : t("cc_method_workbook")}`);
  }

  paint();
}

// The methodology: what the numbers mean, where they come from, what is estimated, and the Armenian-law notes.
function methodologyHtml() {
  const lang = getLang() === "hy" ? "hy" : "en";
  const keys = ["landing", "commission", "overhead", "transport", "taxes", "rate", "law", "limits"];
  return `<div class="cc-method-doc" lang="${lang}">${keys.map((k) => `<h4>${t(`cc_m_${k}_h`)}</h4>${t(`cc_m_${k}`)}`).join("")}</div>`;
}
