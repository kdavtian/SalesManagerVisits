// The Pivot report (owner, 2026-11-03: "one very smart and complete pivot: choose from all data, pivot and filter everything, choose
// the fields, export Excel / CSV / PDF"). Admin and CEO only (server: routes/pivot.js). One screen, the same builder on the phone and the
// computer (bottom sheets on the phone, the builder beside the result on a wide screen):
//   Data      which source (customers, products at the shops, Excel sales, app orders, visits, payments, tasks, stock, route plans, ...)
//   Pivot     fields on Rows / Columns, aggregated Values (count, distinct count, sum, average, min, max), dates by day ... year
//   List      the chosen fields row by row (e.g. every shop with fake Castrol: address, phone, rep)
//   Filters   any field: values picked from a list (with counts), contains, empty, ranges, "last N days"
//   Saved     setups saved by name, private or shared (admin and CEO); Export: Excel, CSV, PDF of exactly what is shown
// Every change runs again by itself (a short pause after the last tap); a stale answer never paints over a newer one.
import { api } from "../api.js";
import { t, getLang, hasText, loadAllTexts } from "../i18n.js";
import { activateDialog, escapeHtml, openInfoPopup, regionLabelHy, saveBlob, showToast, subregionLabelHy } from "../util.js";
import { icons } from "../icons.js";
import { installInlineClearButton } from "../searchBar.js";
import { downloadCsv } from "../deskTable.js";
import { buildMatrix, flattenMatrix } from "../shared/pivotMatrix.js";

const STORE_KEY = "pivot.last";
const SHOW_ROWS = 1000; // drawn on screen; the export has every row
const AGG_LIST = ["count", "count_distinct", "sum", "avg", "min", "max"];
const BUCKETS = ["day", "week", "month", "quarter", "year", "weekday"];
const TYPE_ICON = { text: "Aa", number: "#", date: "📅", bool: "✓" };

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
};
const write = (v) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    // private mode: the setup is just not remembered
  }
};

function sheet(html) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet pv-sheet">${html}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  return overlay;
}

export async function renderPivot(root, navigate) {
  root.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let sources;
  try {
    [{ sources }] = await Promise.all([api.pivotSources(), loadAllTexts().catch(() => {})]);
  } catch (err) {
    root.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const lang = getLang();
  const L = (label) => label?.[lang] ?? label?.en ?? "";
  const srcBy = new Map(sources.map((s) => [s.key, s]));
  const fieldOf = (key) => cur().fields.find((f) => f.key === key);
  const fieldLabel = (key) => (key === "*" ? t("pv_rows") : L(fieldOf(key)?.label) || key);

  function defaults(sourceKey) {
    const s = srcBy.get(sourceKey);
    const firstText = s.fields.find((f) => /rep$|_rep$|^rep|assignee|^by$|planned_for|made_by|collector/.test(f.key)) ?? s.fields.find((f) => f.type === "text");
    return { source: sourceKey, mode: "pivot", rows: firstText ? [{ field: firstText.key }] : [], cols: [], values: [{ field: "*", agg: "count" }], fields: s.fields.slice(0, 6).map((f) => f.key), filters: [], sort: null };
  }
  const saved = read();
  let cfg = saved?.cfg && srcBy.has(saved.cfg.source) ? saved.cfg : defaults(sources[0].key);
  let viewId = saved?.viewId ?? null;
  let viewName = saved?.viewName ?? "";
  let result = null;
  let tableSort = null; // { col, dir } -- the screen's own sort of the pivot rows
  let seq = 0;
  let timer = null;
  const cur = () => srcBy.get(cfg.source);
  const remember = () => write({ cfg, viewId, viewName });

  root.innerHTML = `
    <div class="detail-view pv-view">
      <div class="detail-header">
        <button class="icon-btn" id="pv-back" aria-label="${t("back")}">${icons.chevronLeft}</button>
        <div class="detail-header-title"><h1>${t("report_pivot_name")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="pv-hint" aria-label="${t("more_info")}">!</span></h1></div>
        <div class="pv-head-actions">
          <button type="button" class="btn" id="pv-views" aria-label="${t("pv_saved")}">${icons.folder}<span>${t("pv_saved")}</span></button>
          <button type="button" class="btn btn-primary" id="pv-export" aria-label="${t("pv_export")}">${icons.download}<span>${t("pv_export")}</span></button>
        </div>
      </div>
      <p class="muted pv-view-name" id="pv-view-name" hidden></p>
      <div class="pv-layout">
        <aside class="pv-builder card" id="pv-builder"></aside>
        <section class="pv-result">
          <p class="muted pv-meta" id="pv-meta" role="status"></p>
          <div class="pv-table-wrap" id="pv-table"></div>
        </section>
      </div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  $("#pv-back").addEventListener("click", () => navigate.goBack("#/reports"));
  $("#pv-hint").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("pv_hint"))}</p>`));

  // ---------- value labels ----------
  function valueLabel(field, raw, bucket) {
    if (raw == null || raw === "") return t("pv_empty");
    const s = String(raw);
    if (field?.type === "bool") return s === "true" ? t("pv_yes") : s === "false" ? t("pv_no") : s;
    if (field?.type === "date" && bucket === "weekday") return t(`rp_auto_day_${Number(s) % 7}`);
    const vk = field?.vk;
    if (!vk) return s;
    if (vk === "region") return regionLabelHy(s);
    if (vk === "subregion") return subregionLabelHy(s);
    if (vk === "chips") {
      return s
        .split(", ")
        .map((part) => {
          const [g, v] = part.split(":");
          const key = g === "competitors" ? `competitor_${v}` : `chip_${g}_${v}`;
          return hasText(key) ? t(key) : part;
        })
        .join(", ");
    }
    if (vk.includes("{v}")) {
      // a list ("a, b") is translated part by part (visit outcomes)
      return s
        .split(", ")
        .map((p) => (hasText(vk.replace("{v}", p)) ? t(vk.replace("{v}", p)) : p))
        .join(", ");
    }
    return s;
  }
  const fmtNum = (v) => {
    if (v == null || v === "") return "";
    if (typeof v !== "number") return String(v);
    const abs = Math.abs(v);
    return v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) || abs >= 1000 ? 0 : abs >= 10 ? 1 : 2 });
  };
  const aggLabel = (v) => (v.field === "*" ? t("pv_count_rows") : `${t(`pv_agg_${v.agg}`)}: ${fieldLabel(v.field)}`);
  const dimText = (d) => `${fieldLabel(d.field)}${d.bucket && d.bucket !== "day" ? ` (${t(`pv_bucket_${d.bucket}`)})` : ""}`;

  // ---------- builder ----------
  function chip(zone, i, label, sub = "") {
    return `<span class="pv-chip" data-zone="${zone}" data-i="${i}"><button type="button" class="pv-chip-main" data-act="edit">${escapeHtml(label)}${sub ? ` <small>${escapeHtml(sub)}</small>` : ""}</button><button type="button" class="pv-chip-x" data-act="remove" aria-label="${t("pv_remove")}">×</button></span>`;
  }
  function filterText(f) {
    const field = fieldOf(f.field);
    const v = f.value;
    switch (f.op) {
      case "in":
      case "not_in": {
        const list = (v ?? []).map((x) => valueLabel(field, x));
        const shown = list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ");
        return `${f.op === "not_in" ? `${t("pv_not")} ` : ""}${shown}`;
      }
      case "contains":
        return `“${v}”`;
      case "not_contains":
        return `${t("pv_not")} “${v}”`;
      case "empty":
        return t("pv_op_empty");
      case "not_empty":
        return t("pv_op_not_empty");
      case "between":
        return `${v?.[0] ?? "…"} – ${v?.[1] ?? "…"}`;
      case "last_days":
        return t("pv_last_n").replace("{n}", v);
      default:
        return String(v ?? "");
    }
  }
  function zoneHtml(zone, title, chips) {
    return `<div class="pv-zone" data-zone="${zone}"><div class="pv-zone-title">${escapeHtml(title)}</div><div class="pv-chips">${chips.join("")}<button type="button" class="pv-add" data-add="${zone}" aria-label="${escapeHtml(`${t("pv_add")} · ${title}`)}">+ ${t("pv_add")}</button></div></div>`;
  }
  // "Subregion · Products at the shop · Number of rows" (pivot) or the chosen fields (list)
  function setupSummary() {
    return cfg.mode === "pivot"
      ? [cfg.rows.map(dimText).join(", "), cfg.cols.map(dimText).join(", "), cfg.values.map(aggLabel).join(", ")].filter(Boolean).join(" · ")
      : cfg.fields.map(fieldLabel).join(", ");
  }

  function paintBuilder() {
    const b = $("#pv-builder");
    const open = b.dataset.open !== "false";
    const summary = setupSummary();
    b.innerHTML = `
      <button type="button" class="pv-builder-toggle" id="pv-toggle" aria-expanded="${open}">
        <span><strong>${escapeHtml(L(cur().label))}</strong><span class="muted pv-summary">${escapeHtml(summary)}${cfg.filters.length ? ` · ${escapeHtml(t("pv_n_filters").replace("{n}", cfg.filters.length))}` : ""}</span></span>
        <span class="pv-toggle-icon" aria-hidden="true">${open ? "−" : "+"}</span>
      </button>
      <div class="pv-builder-body" ${open ? "" : "hidden"}>
        <label class="pv-field-label">${t("pv_data")}
          <select id="pv-source">${sources.map((s) => `<option value="${s.key}" ${s.key === cfg.source ? "selected" : ""}>${escapeHtml(L(s.label))}</option>`).join("")}</select>
        </label>
        <div class="segmented pv-mode" role="group" aria-label="${t("pv_mode")}">
          <button type="button" class="chip ${cfg.mode === "pivot" ? "chip-active" : ""}" data-mode="pivot" aria-pressed="${cfg.mode === "pivot"}">${t("pv_mode_pivot")}</button>
          <button type="button" class="chip ${cfg.mode === "list" ? "chip-active" : ""}" data-mode="list" aria-pressed="${cfg.mode === "list"}">${t("pv_mode_list")}</button>
        </div>
        ${
          cfg.mode === "pivot"
            ? zoneHtml("rows", t("pv_zone_rows"), cfg.rows.map((d, i) => chip("rows", i, dimText(d)))) +
              zoneHtml("cols", t("pv_zone_cols"), cfg.cols.map((d, i) => chip("cols", i, dimText(d)))) +
              zoneHtml("values", t("pv_zone_values"), cfg.values.map((v, i) => chip("values", i, aggLabel(v))))
            : zoneHtml(
                "fields",
                t("pv_zone_fields"),
                cfg.fields.map((k, i) => chip("fields", i, fieldLabel(k), cfg.sort?.field === k ? (cfg.sort.dir === "desc" ? "↓" : "↑") : ""))
              )
        }
        ${zoneHtml("filters", t("pv_zone_filters"), cfg.filters.map((f, i) => chip("filters", i, fieldLabel(f.field), filterText(f))))}
        <button type="button" class="btn-link pv-reset" id="pv-reset">${t("pv_reset")}</button>
      </div>`;
    const nameEl = $("#pv-view-name");
    nameEl.hidden = !viewName;
    nameEl.textContent = viewName ? `${t("pv_view")}: ${viewName}` : "";
  }

  $("#pv-builder").addEventListener("click", (e) => {
    if (e.target.closest("#pv-toggle")) {
      const b = $("#pv-builder");
      b.dataset.open = b.dataset.open === "false" ? "true" : "false";
      return paintBuilder();
    }
    const mode = e.target.closest("[data-mode]");
    if (mode) {
      cfg.mode = mode.dataset.mode;
      return changed();
    }
    if (e.target.closest("#pv-reset")) {
      cfg = defaults(cfg.source);
      viewId = null;
      viewName = "";
      return changed();
    }
    const add = e.target.closest("[data-add]");
    if (add) return pickField(add.dataset.add);
    const c = e.target.closest(".pv-chip");
    if (!c) return;
    const zone = c.dataset.zone;
    const i = Number(c.dataset.i);
    if (e.target.closest('[data-act="remove"]')) {
      cfg[zone].splice(i, 1);
      if (zone === "fields" && cfg.sort && !cfg.fields.includes(cfg.sort.field)) cfg.sort = null;
      return changed();
    }
    if (zone === "filters") return editFilter(i);
    return editChip(zone, i);
  });
  $("#pv-builder").addEventListener("change", (e) => {
    if (e.target.id !== "pv-source") return;
    cfg = defaults(e.target.value);
    viewId = null;
    viewName = "";
    changed();
  });

  function changed() {
    tableSort = null;
    remember();
    paintBuilder();
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  }

  // ---------- sheets ----------
  function pickField(zone) {
    const fields = cur().fields.filter((f) => zone !== "values" || true);
    const multi = zone === "fields";
    const chosen = new Set(multi ? cfg.fields : []);
    const overlay = sheet(`
      <h2>${escapeHtml(t(`pv_zone_${zone}`))}</h2>
      <input type="search" id="pv-fq" placeholder="${escapeHtml(t("pv_search_fields"))}" aria-label="${escapeHtml(t("pv_search_fields"))}" autocomplete="off" />
      <div class="pv-field-list" id="pv-fl"></div>
      <div class="sheet-actions sheet-actions-floating">
        <button type="button" class="btn" id="pv-fx">${t("cancel")}</button>
        ${multi ? `<button type="button" class="btn btn-primary" id="pv-fok">${t("pv_done")}</button>` : ""}
      </div>`);
    const q = overlay.querySelector("#pv-fq");
    installInlineClearButton(q);
    const list = overlay.querySelector("#pv-fl");
    const extra = zone === "values" ? [{ key: "*", type: "number", label: { en: t("pv_count_rows"), hy: t("pv_count_rows") } }] : [];
    const paint = () => {
      const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      // both languages: an English word finds the field on an Armenian screen and the other way round
      const hay = (f) => `${f.label?.en ?? ""} ${f.label?.hy ?? ""} ${typeof f.label === "string" ? f.label : ""}`.toLowerCase();
      const shown = [...extra, ...fields].filter((f) => words.every((w) => hay(f).includes(w)));
      list.innerHTML = shown.length
        ? shown
            .map(
              (f) => `<button type="button" class="pv-field-row ${chosen.has(f.key) ? "pv-field-on" : ""}" data-key="${escapeHtml(f.key)}" aria-pressed="${chosen.has(f.key)}">
                <span class="pv-type" aria-hidden="true">${TYPE_ICON[f.type] ?? ""}</span><span class="pv-field-name">${escapeHtml(L(f.label))}</span>${multi ? `<span class="pv-check" aria-hidden="true">${chosen.has(f.key) ? "✓" : ""}</span>` : ""}</button>`
            )
            .join("")
        : `<p class="empty-state">${t("pv_no_fields")}</p>`;
    };
    q.addEventListener("input", paint);
    paint();
    overlay.querySelector("#pv-fx").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#pv-fok")?.addEventListener("click", () => {
      // keep the order: fields already there stay where they are, new ones at the end
      cfg.fields = [...cfg.fields.filter((k) => chosen.has(k)), ...[...chosen].filter((k) => !cfg.fields.includes(k))];
      overlay.remove();
      changed();
    });
    list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-key]");
      if (!row) return;
      const key = row.dataset.key;
      if (multi) {
        if (chosen.has(key)) chosen.delete(key);
        else chosen.add(key);
        return paint();
      }
      overlay.remove();
      const f = key === "*" ? null : fieldOf(key);
      if (zone === "rows" || zone === "cols") {
        cfg[zone].push({ field: key, ...(f?.type === "date" ? { bucket: "month" } : {}) });
        changed();
      } else if (zone === "values") {
        cfg.values.push({ field: key, agg: key === "*" ? "count" : f.type === "number" ? f.agg || "sum" : "count_distinct" });
        changed();
      } else if (zone === "filters") {
        cfg.filters.push({ field: key, op: f.type === "date" ? "last_days" : f.type === "number" ? "between" : "in", value: f.type === "date" ? 30 : f.type === "number" ? [null, null] : [] });
        editFilter(cfg.filters.length - 1, true);
      }
    });
    q.focus();
  }

  function editChip(zone, i) {
    const item = cfg[zone][i];
    const key = zone === "fields" ? item : item.field;
    const f = key === "*" ? null : fieldOf(key);
    const moveBtns = `<div class="pv-opt-row">
        <button type="button" class="btn" data-move="-1" ${i === 0 ? "disabled" : ""}>← ${t("pv_move_earlier")}</button>
        <button type="button" class="btn" data-move="1" ${i === cfg[zone].length - 1 ? "disabled" : ""}>${t("pv_move_later")} →</button>
      </div>`;
    let body = "";
    if ((zone === "rows" || zone === "cols") && f?.type === "date") {
      body += `<p class="pv-opt-title">${t("pv_group_dates")}</p><div class="pv-opt-chips">${BUCKETS.map((b) => `<button type="button" class="pv-opt ${(item.bucket || "day") === b ? "pv-opt-on" : ""}" data-bucket="${b}">${t(`pv_bucket_${b}`)}</button>`).join("")}</div>`;
    }
    if (zone === "rows" || zone === "cols") {
      const other = zone === "rows" ? "cols" : "rows";
      body += `<button type="button" class="btn btn-block" data-swap="${other}">${t(zone === "rows" ? "pv_to_cols" : "pv_to_rows")}</button>`;
    }
    if (zone === "values" && f) {
      const aggs = f.type === "number" ? AGG_LIST : f.type === "date" ? ["count", "count_distinct", "min", "max"] : ["count", "count_distinct"];
      body += `<p class="pv-opt-title">${t("pv_aggregation")}</p><div class="pv-opt-chips">${aggs.map((a) => `<button type="button" class="pv-opt ${item.agg === a ? "pv-opt-on" : ""}" data-agg="${a}">${t(`pv_agg_${a}`)}</button>`).join("")}</div>`;
    }
    if (zone === "fields") {
      const on = cfg.sort?.field === key ? cfg.sort.dir : null;
      body += `<p class="pv-opt-title">${t("pv_sort")}</p><div class="pv-opt-chips">
        <button type="button" class="pv-opt ${on === "asc" ? "pv-opt-on" : ""}" data-sort="asc">↑ ${t("pv_sort_asc")}</button>
        <button type="button" class="pv-opt ${on === "desc" ? "pv-opt-on" : ""}" data-sort="desc">↓ ${t("pv_sort_desc")}</button>
        <button type="button" class="pv-opt ${on ? "" : "pv-opt-on"}" data-sort="">${t("pv_sort_none")}</button></div>`;
    }
    const overlay = sheet(`<h2>${escapeHtml(key === "*" ? t("pv_count_rows") : L(f.label))}</h2>${body}${moveBtns}
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn btn-danger" id="pv-rm">${t("pv_remove")}</button><button type="button" class="btn btn-primary" id="pv-ok">${t("pv_done")}</button></div>`);
    const done = () => {
      overlay.remove();
      changed();
    };
    overlay.addEventListener("click", (e) => {
      const b = e.target.closest("[data-bucket],[data-agg],[data-sort],[data-move],[data-swap]");
      if (!b) return;
      if (b.dataset.bucket) item.bucket = b.dataset.bucket;
      if (b.dataset.agg) item.agg = b.dataset.agg;
      if (b.dataset.sort !== undefined) cfg.sort = b.dataset.sort ? { field: key, dir: b.dataset.sort } : null;
      if (b.dataset.move) {
        const j = i + Number(b.dataset.move);
        [cfg[zone][i], cfg[zone][j]] = [cfg[zone][j], cfg[zone][i]];
        return done();
      }
      if (b.dataset.swap) {
        cfg[zone].splice(i, 1);
        cfg[b.dataset.swap].push(item);
        return done();
      }
      overlay.querySelectorAll(".pv-opt").forEach((o) => {
        const on = (o.dataset.bucket && o.dataset.bucket === (item.bucket || "day")) || (o.dataset.agg && o.dataset.agg === item.agg) || (o.dataset.sort !== undefined && (o.dataset.sort || null) === (cfg.sort?.field === key ? cfg.sort.dir : null));
        o.classList.toggle("pv-opt-on", Boolean(on));
      });
    });
    overlay.querySelector("#pv-rm").addEventListener("click", () => {
      cfg[zone].splice(i, 1);
      if (zone === "fields" && cfg.sort?.field === key) cfg.sort = null;
      done();
    });
    overlay.querySelector("#pv-ok").addEventListener("click", done);
  }

  function specFor(c = cfg) {
    return c.mode === "list"
      ? { source: c.source, mode: "list", fields: c.fields, filters: c.filters, sort: c.sort }
      : { source: c.source, mode: "pivot", rows: c.rows, cols: c.cols, values: c.values, filters: c.filters };
  }

  function editFilter(i, isNew = false) {
    const flt = { ...cfg.filters[i], value: Array.isArray(cfg.filters[i].value) ? [...cfg.filters[i].value] : cfg.filters[i].value };
    const f = fieldOf(flt.field);
    const drop = () => {
      if (isNew) cfg.filters.splice(i, 1);
    };
    let body = "";
    if (f.type === "date") {
      const quick = [7, 30, 90, 365];
      body = `<div class="pv-opt-chips">${quick.map((n) => `<button type="button" class="pv-opt ${flt.op === "last_days" && Number(flt.value) === n ? "pv-opt-on" : ""}" data-last="${n}">${t("pv_last_n").replace("{n}", n)}</button>`).join("")}</div>
        <div class="pv-two"><label class="pv-field-label">${t("pv_from")}<input type="date" id="pv-from" value="${flt.op === "between" ? (flt.value?.[0] ?? "") : ""}" /></label>
        <label class="pv-field-label">${t("pv_to")}<input type="date" id="pv-to" value="${flt.op === "between" ? (flt.value?.[1] ?? "") : ""}" /></label></div>`;
    } else if (f.type === "number") {
      body = `<div class="pv-two"><label class="pv-field-label">${t("pv_min")}<input type="number" inputmode="decimal" id="pv-from" value="${flt.value?.[0] ?? ""}" /></label>
        <label class="pv-field-label">${t("pv_max")}<input type="number" inputmode="decimal" id="pv-to" value="${flt.value?.[1] ?? ""}" /></label></div>`;
    } else {
      body = `<div class="segmented pv-ops" role="group">
          ${["in", "not_in", "contains", "empty", "not_empty"].map((op) => `<button type="button" class="chip ${flt.op === op || (op === "contains" && flt.op === "not_contains") ? "chip-active" : ""}" data-op="${op}">${t(`pv_op_${op}`)}</button>`).join("")}
        </div>
        <div id="pv-fbody"></div>`;
    }
    const overlay = sheet(`<h2>${escapeHtml(L(f.label))}</h2>${body}
      <p class="form-error" id="pv-ferr" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="pv-fx">${t(isNew ? "cancel" : "pv_remove")}</button><button type="button" class="btn btn-primary" id="pv-fok">${t("pv_apply")}</button></div>`);
    const $s = (s) => overlay.querySelector(s);
    let values = null;
    let picked = new Set(flt.op === "in" || flt.op === "not_in" ? (flt.value ?? []).map((v) => (v == null ? "\u0000" : String(v))) : []);
    async function paintValues() {
      const box = $s("#pv-fbody");
      if (!box) return;
      if (flt.op === "contains" || flt.op === "not_contains") {
        box.innerHTML = `<label class="pv-check-row"><input type="checkbox" id="pv-neg" ${flt.op === "not_contains" ? "checked" : ""} /> ${t("pv_exclude")}</label>
          <input type="search" id="pv-text" value="${escapeHtml(typeof flt.value === "string" ? flt.value : "")}" placeholder="${escapeHtml(t("pv_text"))}" aria-label="${escapeHtml(t("pv_text"))}" autocomplete="off" />`;
        installInlineClearButton($s("#pv-text"));
        $s("#pv-text").focus();
        return;
      }
      if (flt.op === "empty" || flt.op === "not_empty") {
        box.innerHTML = "";
        return;
      }
      box.innerHTML = `<input type="search" id="pv-vq" placeholder="${escapeHtml(t("pv_search_values"))}" aria-label="${escapeHtml(t("pv_search_values"))}" autocomplete="off" />
        <div class="pv-value-tools"><button type="button" class="btn-link" id="pv-all">${t("pv_select_all")}</button><button type="button" class="btn-link" id="pv-none">${t("pv_select_none")}</button></div>
        <div class="pv-value-list" id="pv-vl"><p class="loading-state" role="status">${t("loading")}</p></div>`;
      installInlineClearButton($s("#pv-vq"));
      const list = $s("#pv-vl");
      let qseq = 0;
      const load = async () => {
        const mine = ++qseq;
        try {
          const spec = { ...specFor(), filters: cfg.filters.filter((_, j) => j !== i) };
          const r = await api.pivotValues(spec, flt.field, $s("#pv-vq")?.value.trim() ?? "");
          if (mine !== qseq) return;
          values = r.values;
          paintList();
        } catch (err) {
          list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        }
      };
      const paintList = () => {
        list.innerHTML = values.length
          ? values
              .map((x) => {
                const id = x.v == null ? "\u0000" : String(x.v);
                return `<label class="pv-check-row"><input type="checkbox" data-v="${escapeHtml(id)}" ${picked.has(id) ? "checked" : ""} /><span class="pv-value-name">${escapeHtml(valueLabel(f, x.v))}</span><span class="muted pv-value-n">${x.n.toLocaleString("en-US")}</span></label>`;
              })
              .join("")
          : `<p class="empty-state">${t("pv_no_values")}</p>`;
      };
      list.addEventListener("change", (e) => {
        const v = e.target.dataset.v;
        if (v === undefined) return;
        if (e.target.checked) picked.add(v);
        else picked.delete(v);
      });
      $s("#pv-all").addEventListener("click", () => {
        (values ?? []).forEach((x) => picked.add(x.v == null ? "\u0000" : String(x.v)));
        paintList();
      });
      $s("#pv-none").addEventListener("click", () => {
        picked = new Set();
        paintList();
      });
      let vt = null;
      $s("#pv-vq").addEventListener("input", () => {
        clearTimeout(vt);
        vt = setTimeout(load, 250);
      });
      load();
    }
    overlay.querySelector(".pv-ops")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-op]");
      if (!b) return;
      flt.op = b.dataset.op === "contains" && flt.op === "not_contains" ? "not_contains" : b.dataset.op;
      if ((flt.op === "contains" || flt.op === "not_contains") && typeof flt.value !== "string") flt.value = "";
      overlay.querySelectorAll(".pv-ops [data-op]").forEach((x) => x.classList.toggle("chip-active", x.dataset.op === b.dataset.op));
      paintValues();
    });
    overlay.addEventListener("click", (e) => {
      const last = e.target.closest("[data-last]");
      if (!last) return;
      flt.op = "last_days";
      flt.value = Number(last.dataset.last);
      overlay.remove();
      cfg.filters[i] = flt;
      changed();
    });
    paintValues();
    $s("#pv-fx").addEventListener("click", () => {
      if (isNew) drop();
      else cfg.filters.splice(i, 1);
      overlay.remove();
      changed();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && isNew) {
        drop();
        changed();
      }
    });
    $s("#pv-fok").addEventListener("click", () => {
      if (f.type === "date" || f.type === "number") {
        const a = $s("#pv-from").value;
        const b = $s("#pv-to").value;
        if (!a && !b && !(flt.op === "last_days" && f.type === "date")) {
          return Object.assign($s("#pv-ferr"), { textContent: t("pv_fill_range"), hidden: false });
        }
        if (a || b) {
          flt.op = "between";
          flt.value = [a || null, b || null];
        }
      } else if (flt.op === "contains" || flt.op === "not_contains") {
        const text = $s("#pv-text").value.trim();
        if (!text) return Object.assign($s("#pv-ferr"), { textContent: t("pv_fill_text"), hidden: false });
        flt.op = $s("#pv-neg").checked ? "not_contains" : "contains";
        flt.value = text;
      } else if (flt.op === "in" || flt.op === "not_in") {
        if (!picked.size) return Object.assign($s("#pv-ferr"), { textContent: t("pv_pick_values"), hidden: false });
        flt.value = [...picked].map((v) => (v === "\u0000" ? null : v));
      }
      cfg.filters[i] = flt;
      overlay.remove();
      changed();
    });
  }

  // ---------- running and drawing ----------
  async function run() {
    const mine = ++seq;
    const meta = $("#pv-meta");
    if (cfg.mode === "list" && !cfg.fields.length) {
      result = null;
      meta.textContent = t("pv_choose_fields");
      $("#pv-table").innerHTML = "";
      return;
    }
    meta.textContent = t("pv_calculating");
    root.querySelector(".pv-result").setAttribute("aria-busy", "true");
    try {
      const r = await api.pivotRun(specFor());
      if (mine !== seq || !root.isConnected) return;
      result = { ...r, cfg: JSON.parse(JSON.stringify(cfg)) };
      paintResult();
    } catch (err) {
      if (mine !== seq) return;
      meta.textContent = "";
      $("#pv-table").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    } finally {
      if (mine === seq) root.querySelector(".pv-result")?.removeAttribute("aria-busy");
    }
  }

  // The table the screen shows and the export sends: { header, rows, total, numeric }
  function flatTable() {
    const c = result.cfg;
    if (result.kind === "list") {
      const fs = c.fields.map((k) => fieldOf(k));
      return {
        header: c.fields.map(fieldLabel),
        // a blank cell stays blank in the list (and in its export); "(empty)" only names a pivot group
        rows: result.rows.map((r) => r.map((v, i) => (v == null || v === "" ? "" : fs[i]?.type === "number" ? v : valueLabel(fs[i], v)))),
        total: null,
        numeric: fs.map((f) => f?.type === "number"),
      };
    }
    const m = buildMatrix(result);
    const dims = [...c.rows, ...c.cols];
    return flattenMatrix(m, {
      rowDimLabels: c.rows.map(dimText),
      valueLabels: c.values.map(aggLabel),
      dimLabel: (i, raw) => valueLabel(fieldOf(dims[i].field), raw, dims[i].bucket),
      colLabel: (k) => k.map((raw, j) => valueLabel(fieldOf(dims[c.rows.length + j].field), raw, dims[c.rows.length + j].bucket)).join(" · "),
      totalLabel: t("pv_total"),
      sort: tableSort,
    });
  }

  function paintResult() {
    const tbl = flatTable();
    const n = tbl.rows.length;
    const meta = [
      result.kind === "list" ? t("pv_n_rows").replace("{n}", n.toLocaleString("en-US")) : t("pv_n_groups").replace("{n}", n.toLocaleString("en-US")),
      `${(result.ms / 1000).toFixed(1)} s`,
      result.truncated ? t("pv_truncated") : "",
      n > SHOW_ROWS ? t("pv_shown_first").replace("{n}", SHOW_ROWS.toLocaleString("en-US")) : "",
    ].filter(Boolean);
    $("#pv-meta").textContent = meta.join(" · ");
    if (!n && !(tbl.total && tbl.total.some((v) => v != null && v !== ""))) {
      $("#pv-table").innerHTML = `<p class="empty-state">${t("pv_no_rows")}</p>`;
      return;
    }
    const sortMark = (i) => (tableSort?.col === i ? (tableSort.dir === "asc" ? " ↑" : " ↓") : "");
    const td = (v, i, total = false) => {
      const num = tbl.numeric[i];
      return `<td class="${num ? "pv-num" : ""}${total ? " pv-total" : ""}">${escapeHtml(num ? fmtNum(v) : (v ?? ""))}</td>`;
    };
    $("#pv-table").innerHTML = `<table class="pv-table">
      <thead><tr>${tbl.header.map((h, i) => `<th class="${tbl.numeric[i] ? "pv-num" : ""}"><button type="button" class="pv-th" data-sortcol="${i}">${escapeHtml(h)}${sortMark(i)}</button></th>`).join("")}</tr></thead>
      <tbody>${tbl.rows
        .slice(0, SHOW_ROWS)
        .map((r) => `<tr>${r.map((v, i) => td(v, i)).join("")}</tr>`)
        .join("")}</tbody>
      ${tbl.total ? `<tfoot><tr>${tbl.total.map((v, i) => td(v, i, true)).join("")}</tr></tfoot>` : ""}
    </table>`;
  }

  // tap a heading: sort by it, tap again: the other way (the owner's tap-to-reverse)
  $("#pv-table").addEventListener("click", (e) => {
    const th = e.target.closest("[data-sortcol]");
    if (!th || !result) return;
    const col = Number(th.dataset.sortcol);
    if (result.kind === "list") {
      const key = result.cfg.fields[col];
      cfg.sort = cfg.sort?.field === key && cfg.sort.dir === "asc" ? { field: key, dir: "desc" } : { field: key, dir: "asc" };
      remember();
      paintBuilder();
      run();
      return;
    }
    const numeric = flatTable().numeric[col];
    tableSort = tableSort?.col === col ? { col, dir: tableSort.dir === "asc" ? "desc" : "asc" } : { col, dir: numeric ? "desc" : "asc" };
    paintResult();
  });

  // ---------- export ----------
  $("#pv-export").addEventListener("click", () => {
    if (!result) return showToast(t("pv_nothing"));
    const overlay = sheet(`<h2>${t("pv_export")}</h2>
      <div class="pv-export-list">
        <button type="button" class="btn btn-block" data-fmt="xlsx">Excel (.xlsx)</button>
        <button type="button" class="btn btn-block" data-fmt="csv">CSV</button>
        <button type="button" class="btn btn-block" data-fmt="pdf">PDF</button>
      </div>
      <p class="form-error" id="pv-xerr" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="pv-xx">${t("cancel")}</button></div>`);
    overlay.querySelector("#pv-xx").addEventListener("click", () => overlay.remove());
    overlay.querySelector(".pv-export-list").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-fmt]");
      if (!b) return;
      const tbl = flatTable();
      const title = viewName || L(cur().label);
      const base = `${title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "pivot"} ${new Date().toISOString().slice(0, 10)}`;
      const plain = (r) => r.map((v, i) => (tbl.numeric[i] ? v : (v ?? "")));
      if (b.dataset.fmt === "csv") {
        downloadCsv(`${base}.csv`, tbl.header, [...tbl.rows.map(plain), ...(tbl.total ? [plain(tbl.total)] : [])]);
        overlay.remove();
        return;
      }
      b.disabled = true;
      try {
        // what the file shows, for whoever reads the printout: the setup, the filters and when it was made (Yerevan time)
        const made = new Date().toLocaleString("en-GB", { timeZone: "Asia/Yerevan", dateStyle: "short", timeStyle: "short" });
        const subtitle = [setupSummary(), ...cfg.filters.map((f) => `${fieldLabel(f.field)}: ${filterText(f)}`), made].filter(Boolean).join(" · ");
        const blob = await api.pivotExport({ format: b.dataset.fmt, title, subtitle, header: tbl.header, rows: tbl.rows.map(plain), total: tbl.total ? plain(tbl.total) : null, numeric: tbl.numeric });
        await saveBlob(blob, `${base}.${b.dataset.fmt}`);
        overlay.remove();
      } catch (err) {
        b.disabled = false;
        Object.assign(overlay.querySelector("#pv-xerr"), { textContent: err.message, hidden: false });
      }
    });
  });

  // ---------- saved views ----------
  $("#pv-views").addEventListener("click", async () => {
    const overlay = sheet(`<h2>${t("pv_saved")}</h2>
      <div class="pv-save-box">
        <label class="pv-field-label">${t("pv_view_name")}<input id="pv-vname" maxlength="120" value="${escapeHtml(viewName)}" autocomplete="off" /></label>
        <div class="pv-opt-row">
          ${viewId ? `<button type="button" class="btn" id="pv-vupdate">${t("pv_save_changes")}</button>` : ""}
          <button type="button" class="btn btn-primary" id="pv-vnew">${t(viewId ? "pv_save_as_new" : "pv_save")}</button>
        </div>
        <label class="pv-check-row"><input type="checkbox" id="pv-vshare" /> ${t("pv_share")}</label>
      </div>
      <p class="form-error" id="pv-verr" hidden></p>
      <div class="pv-view-list" id="pv-vlist"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="pv-vx">${t("pv_done")}</button></div>`);
    const $s = (s) => overlay.querySelector(s);
    const err = (m) => Object.assign($s("#pv-verr"), { textContent: m, hidden: false });
    let views = [];
    const paintList = () => {
      const current = views.find((v) => v.id === viewId);
      if (current) $s("#pv-vshare").checked = current.shared;
      $s("#pv-vlist").innerHTML = views.length
        ? views
            .map(
              (v) => `<div class="pv-view-row ${v.id === viewId ? "pv-view-current" : ""}">
                <button type="button" class="pv-view-open" data-open="${v.id}"><strong>${escapeHtml(v.name)}</strong>
                  <span class="muted">${escapeHtml(L(srcBy.get(v.config?.source)?.label) || "")}${v.shared ? ` · ${t("pv_shared")}` : ""}${v.mine ? "" : ` · ${escapeHtml(v.owner_name || "")}`}</span></button>
                ${v.mine ? `<button type="button" class="pv-chip-x" data-del="${v.id}" aria-label="${t("pv_delete")}">×</button>` : ""}
              </div>`
            )
            .join("")
        : `<p class="empty-state">${t("pv_no_views")}</p>`;
    };
    try {
      views = (await api.pivotViews()).views;
      paintList();
    } catch (e) {
      err(e.message);
    }
    $s("#pv-vx").addEventListener("click", () => overlay.remove());
    const save = async (asNew) => {
      const name = $s("#pv-vname").value.trim();
      if (!name) return err(t("pv_name_needed"));
      try {
        const body = { name, config: cfg, shared: $s("#pv-vshare").checked };
        const r = asNew || !viewId ? await api.pivotSaveView(body) : await api.pivotUpdateView(viewId, body);
        viewId = r.view.id;
        viewName = r.view.name;
        remember();
        paintBuilder();
        overlay.remove();
        showToast(t("pv_saved_ok"));
      } catch (e) {
        err(e.message);
      }
    };
    $s("#pv-vnew").addEventListener("click", () => save(true));
    $s("#pv-vupdate")?.addEventListener("click", () => save(false));
    $s("#pv-vlist").addEventListener("click", async (e) => {
      const open = e.target.closest("[data-open]");
      if (open) {
        const v = views.find((x) => x.id === Number(open.dataset.open));
        if (!v || !srcBy.has(v.config?.source)) return err(t("pv_view_broken"));
        cfg = { ...defaults(v.config.source), ...v.config };
        viewId = v.id;
        viewName = v.name;
        overlay.remove();
        return changed();
      }
      const del = e.target.closest("[data-del]");
      if (!del) return;
      const id = Number(del.dataset.del);
      try {
        const r = await api.pivotDeleteView(id);
        views = views.filter((x) => x.id !== id);
        if (viewId === id) {
          viewId = null;
          viewName = "";
          remember();
          paintBuilder();
        }
        paintList();
        // a wrong tap is undone from the toast (no "are you sure?")
        showToast(t("pv_deleted"), {
          actionLabel: t("undo"),
          ms: 6000,
          onAction: () => api.pivotSaveView({ name: r.deleted.name, config: r.deleted.config, shared: r.deleted.shared }).catch((x) => showToast(x.message)),
        });
      } catch (x) {
        err(x.message);
      }
    });
  });

  // phone: the setup folded once a result is on screen, so the table gets the room (a tap opens it again)
  if (window.matchMedia?.("(max-width: 1023px)").matches && saved?.cfg) $("#pv-builder").dataset.open = "false";
  paintBuilder();
  run();
  return () => clearTimeout(timer);
}
