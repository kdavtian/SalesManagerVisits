// Cost & margin calculator (Products page, management only). Two ways in:
//  - "From catalog": pick a product -> its landing cost (from the Excel) and prices are filled in; change the selling price
//    and see the net cost, margins, the price for a target margin, and where the price goes;
//  - "New product": enter the pack (size, items, kg, supplier price in USD, brand) -> the landing cost is computed with the
//    workbook's import rules, then the same net cost / margin view.
// The maths is costModel.js (shared with the server's discount approvals). The rates are the workbook's; changed rates are
// kept on this device only and marked "Custom rates".
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, groupDigits, openInfoPopup } from "./util.js";
import { COST_RATES_DEFAULT, landingCost, netCost, priceForNetMargin, litersOfUnit } from "./costModel.js";

const STORE_KEY = "fv_cost_calc";
const loadStore = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null") || {};
  } catch {
    return {};
  }
};
const saveStore = (v) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* private mode: settings just last for this session */
  }
};

const SETTING_FIELDS = [
  ["rate", "cc_set_rate"],
  ["tCastrol", "cc_set_tcastrol"],
  ["tLotos", "cc_set_tlotos"],
  ["tOther", "cc_set_tother"],
  ["tReal", "cc_set_treal"],
  ["eco", "cc_set_eco"],
  ["customs", "cc_set_customs"],
  ["excise", "cc_set_excise"],
  ["vat", "cc_set_vat"],
  ["handling", "cc_set_handling"],
  ["otherUsd", "cc_set_other"],
  ["mgr", "cc_set_mgr"],
  ["vatTax", "cc_set_vattax"],
  ["ptax", "cc_set_ptax"],
  ["fixedPerL", "cc_set_fixed"],
];

const amd = (n) => (Number.isFinite(n) ? groupDigits(Math.round(n)) : "—");
const usd = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const pct = (n) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);
const readNum = (el) => {
  const v = parseFloat(String(el.value).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

export function openCostCalculator({ products: given = [], product = null } = {}) {
  let products = given;
  const store = loadStore();
  let rates = { ...COST_RATES_DEFAULT, ...(store.rates || {}) };
  let withFixed = store.withFixed !== false;
  let targetPct = Number.isFinite(store.target) ? store.target : 10;
  let mode = product || products.length ? "catalog" : "new";
  let picked = product;
  let landingOverride = null; // catalog mode: typed landing cost (null = the Excel value)
  const persist = () => saveStore({ rates, withFixed, target: targetPct });
  const customRates = () => SETTING_FIELDS.some(([k]) => Math.abs(rates[k] - COST_RATES_DEFAULT[k]) > 1e-9);

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet cost-calc" role="dialog" aria-modal="true">
      <button type="button" class="icon-btn sheet-close-x" data-action="close" aria-label="${t("close")}">${icons.close}</button>
      <div class="cc-title"><h2>${t("cc_title")}</h2><button type="button" class="settings-hint-icon" id="cc-hint" aria-label="${t("more_info")}">!</button></div>
      <div class="segmented cc-modes" id="cc-modes">
        <button type="button" class="chip" data-mode="catalog">${t("cc_mode_catalog")}</button>
        <button type="button" class="chip" data-mode="new">${t("cc_mode_new")}</button>
      </div>
      <div id="cc-inputs"></div>
      <div id="cc-results"></div>
      <details class="cc-details" id="cc-break"><summary>${t("cc_breakdown")}</summary><div class="cc-table" id="cc-table"></div></details>
      <details class="cc-details" id="cc-sett"><summary>${t("cc_settings")} <span class="badge badge-warning cc-custom" id="cc-custom" hidden>${t("cc_custom_rates")}</span></summary>
        <label class="cc-check"><input type="checkbox" id="cc-fixed" /> <span id="cc-fixed-label"></span></label>
        <div class="cc-set" id="cc-set"></div>
        <button type="button" class="btn" id="cc-reset">${t("cc_reset")}</button>
      </details>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  $('[data-action="close"]').addEventListener("click", () => overlay.remove());
  $("#cc-hint").addEventListener("click", () => openInfoPopup(`<p>${t("cc_hint")}</p>`));

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
        box.querySelectorAll("[data-tier]").forEach((b) =>
          b.addEventListener("click", () => {
            $("#cc-price").value = tierPrice(picked, b.dataset.tier) || "";
            paintResults();
          })
        );
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
        if (!picked) search.focus({ preventScroll: true });
      }
    } else {
      box.innerHTML = `
        <div class="cc-field"><span>${t("cc_brand")}</span>
          <div class="segmented cc-brands" id="cc-brands">${["Castrol", "Lotos", "Other"].map((b) => `<button type="button" class="chip ${b === newBrand ? "chip-active" : ""}" data-brand="${b}">${b === "Other" ? t("cc_brand_other") : b}</button>`).join("")}</div>
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
  const newPack = { size: "", items: "", packKg: "", packCostUsd: "" };
  let newBrand = "Castrol";
  let newPrice = "";

  const priceField = (value) => `<label class="cc-field cc-price"><span>${t("cc_price")}</span><input id="cc-price" type="number" inputmode="decimal" step="any" min="0" value="${value || ""}" /></label>`;
  function catalogFields() {
    const wb = Number(picked.landing_cost_amd) || 0;
    const tiers = [["bronze", "col_bronze"], ["silver", "col_silver"], ["gold", "col_gold"], ["retail", "price_retail"]]
      .map(([k, label]) => [k, t(label), tierPrice(picked, k)])
      .filter(([, , v]) => v > 0);
    return `
      ${numField("cc-landing-in", t("cc_landing_in"), landingOverride ?? (wb || ""))}
      ${wb ? "" : `<p class="form-error cc-note">${t("cc_no_landing")}</p>`}
      ${priceField(defaultPrice(picked))}
      <div class="cc-tiers">${tiers.map(([k, label, v]) => `<button type="button" class="chip" data-tier="${k}">${escapeHtml(label)} <b>${amd(v)}</b></button>`).join("")}</div>`;
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
      return { price, landingAmd, liters, parts: null, landing: null };
    }
    const landing = landingCost({ brand: newBrand, size: newPack.size, items: newPack.items, packKg: newPack.packKg, packCostUsd: newPack.packCostUsd }, rates);
    return { price, landingAmd: landing.amd, liters: Number(newPack.size) || 0, landing, parts: landing };
  }

  function paintResults() {
    const c = current();
    const res = $("#cc-results");
    const table = $("#cc-table");
    $("#cc-custom").hidden = !customRates();
    if (!c) {
      res.innerHTML = "";
      table.innerHTML = "";
      return;
    }
    const hasLanding = c.landingAmd > 0;
    const hasPrice = c.price > 0;
    const n = netCost({ landing: c.landingAmd, price: c.price, liters: c.liters }, rates, { withFixed });
    const fig = (k, v, x, cls = "") => `<div class="cc-fig ${cls}"><div class="cc-k">${k}</div><div class="cc-v">${v}</div><div class="cc-x">${x}</div></div>`;
    const perL = (v) => (c.liters > 0 ? ` · ${amd(v / c.liters)} ${t("cc_per_l")}` : "");
    const excelNet = mode === "catalog" && picked && Number(picked.net_cost_workbook_amd) > 0 ? Number(picked.net_cost_workbook_amd) : null;

    let html = `<p class="cc-caption">${t("cc_caption")}</p><div class="cc-figs">
      ${fig(t("landing_cost"), hasLanding ? amd(c.landingAmd) : "—", hasLanding ? [c.landing ? `$${usd(c.landing.usd)}` : "", c.liters > 0 ? `${amd(c.landingAmd / c.liters)} ${t("cc_per_l")}` : ""].filter(Boolean).join(" · ") : t("cc_enter_pack"))}
      ${fig(t("net_cost"), hasLanding && hasPrice ? amd(n.net) : "—", hasLanding && hasPrice ? `${perL(n.net).replace(/^ · /, "")}${excelNet ? `${c.liters > 0 ? " · " : ""}${t("cc_excel_shows").replace("{amount}", amd(excelNet))}` : ""}` : hasPrice ? t("cc_enter_pack") : t("cc_enter_price"))}
      ${fig(t("cc_margin"), hasLanding && hasPrice ? pct(n.margin) : "—", hasLanding && hasPrice ? amd(c.price - c.landingAmd) : "", hasLanding && hasPrice && n.margin < 0 ? "cc-neg" : "")}
      ${fig(t("cc_net_margin"), hasLanding && hasPrice ? pct(n.netMargin) : "—", hasLanding && hasPrice ? `${amd(n.profit)}${perL(n.profit)}` : "", `cc-hero ${hasLanding && hasPrice && n.netMargin < 0 ? "cc-neg" : ""}`)}
    </div>`;

    if (hasLanding && hasPrice && n.profit < 0) html += `<p class="cc-warn">${t("cc_below_cost").replace("{amount}", amd(-n.profit))}</p>`;
    if (hasLanding && hasPrice && c.price < c.landingAmd) html += `<p class="cc-warn">${t("cc_below_landing")}</p>`;

    if (hasLanding) {
      const be = priceForNetMargin({ landing: c.landingAmd, liters: c.liters }, 0, rates, { withFixed });
      const target = priceForNetMargin({ landing: c.landingAmd, liters: c.liters }, targetPct, rates, { withFixed });
      const diff = target != null && hasPrice ? target - c.price : null;
      html += `<div class="cc-target">
        <label class="cc-field cc-target-in"><span>${t("cc_target")}</span><input id="cc-target" type="number" inputmode="decimal" step="any" value="${targetPct}" /></label>
        <div class="cc-target-out">
          <div><span class="muted">${t("cc_price_for_target").replace("{pct}", targetPct)}</span><strong>${target != null ? amd(target) : "—"}</strong>${diff != null ? `<span class="cc-diff ${diff > 0 ? "cc-neg" : ""}">${diff > 0 ? "+" : ""}${amd(diff)}</span>` : ""}</div>
          <div><span class="muted">${t("cc_breakeven")}</span><strong>${be != null ? amd(be) : "—"}</strong></div>
        </div>
      </div>`;
    }

    // where the selling price goes
    if (hasLanding && hasPrice) {
      const R = rates.rate;
      const segs = c.parts
        ? [
            [t("cc_seg_purchase"), c.parts.cost * R, "--cc-1"],
            [t("cc_seg_transport"), (c.parts.tLegal + c.parts.tReal) * R, "--cc-2"],
            [t("cc_seg_duties"), (c.parts.eco + c.parts.customs + c.parts.excise + c.parts.vat + c.parts.handling + c.parts.other) * R, "--cc-3"],
          ]
        : [[t("landing_cost"), c.landingAmd, "--cc-1"]];
      segs.push([t("cc_seg_salary"), n.mgr, "--cc-4"], [t("cc_seg_taxes"), n.vatTax + n.ptax, "--cc-5"]);
      if (withFixed) segs.push([t("cc_seg_fixed"), n.fixed, "--cc-6"]);
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
        // repaint only the numbers so the field keeps focus
        const keep = tIn.value;
        paintResults();
        const again = $("#cc-target");
        again.value = keep;
        again.focus({ preventScroll: true });
      });
    }

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
    rows +=
      row(t("cc_seg_salary"), null, n.mgr, `${rates.mgr}% × ${t("cc_price_short")}`) +
      row(t("cc_row_vattax"), null, n.vatTax, `${rates.vatTax}% × (${t("cc_price_short")} − ${t("landing_cost")})`) +
      row(t("cc_row_ptax"), null, n.ptax, `${rates.ptax}% × (${t("cc_price_short")} − ${t("landing_cost")} − ${t("cc_row_vattax")})`) +
      (withFixed ? row(t("cc_seg_fixed"), null, n.fixed, `${rates.fixedPerL} ${t("amd")} × ${c.liters || 0} ${t("cc_l")}`) : "") +
      row(t("net_cost"), null, hasPrice && hasLanding ? n.net : NaN, "", "cc-tot");
    table.innerHTML = `<table>${rows}</table>`;
  }

  // ----- settings -----
  function paintSettings() {
    $("#cc-fixed").checked = withFixed;
    $("#cc-fixed-label").textContent = t("cc_include_fixed").replace("{amount}", amd(rates.fixedPerL));
    $("#cc-set").innerHTML = SETTING_FIELDS.map(([k, label]) => `<label class="cc-field"><span>${t(label)}</span><input data-rate="${k}" type="number" inputmode="decimal" step="any" value="${+Number(rates[k]).toFixed(6)}" /></label>`).join("");
    overlay.querySelectorAll("[data-rate]").forEach((inp) =>
      inp.addEventListener("input", () => {
        rates[inp.dataset.rate] = readNum(inp);
        persist();
        $("#cc-fixed-label").textContent = t("cc_include_fixed").replace("{amount}", amd(rates.fixedPerL));
        paintResults();
      })
    );
  }
  $("#cc-fixed").addEventListener("change", () => {
    withFixed = $("#cc-fixed").checked;
    persist();
    paintResults();
  });
  $("#cc-reset").addEventListener("click", () => {
    rates = { ...COST_RATES_DEFAULT };
    withFixed = true;
    persist();
    paintSettings();
    paintResults();
  });
  $("#cc-modes").querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      paintInputs();
      paintResults();
    })
  );

  paintInputs();
  paintSettings();
  paintResults();
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
