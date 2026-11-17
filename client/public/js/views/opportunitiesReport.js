// Reports > Opportunities (owner, 2026-11-17): customers ranked by the litres a month they could still buy from us -- their volume potential
// minus what they really buy (ERP, the last 3 whole months), per product line (server customers/volumeOpportunities.js). A sales manager
// sees only their own customers. Filters: places (region tree), product lines, reps, services the workshop does. Totals by region and rep;
// Excel export.
import { api } from "../api.js";
import { t, getLang } from "../i18n.js";
import { escapeHtml, openInfoPopup, regionLabelHy, subregionLabelHy, saveBlob, formatDateDMY } from "../util.js";
import { icons } from "../icons.js";
import { openTriStateTreeSheet, buildRegionSubregionTree } from "../regionTree.js";

const nf = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const VIEWS = ["customers", "region", "rep"];

export async function renderOpportunitiesReport(root, navigate) {
  const state = { places: new Set(), lines: new Set(), reps: new Set(), services: new Set(), view: "customers" };
  let data = null;
  let cat = null;
  let seq = 0;
  root.innerHTML = `
    <div class="detail-view opp-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">${icons.chevronLeft}</button>
        <div class="detail-header-title">
          <div class="sales-heading-with-hint"><button type="button" class="settings-hint-icon" id="opp-info" aria-label="${t("more_info")}">!</button><h1>${escapeHtml(t("report_volume_opportunities_name"))}</h1></div>
        </div>
        <button type="button" class="icon-btn" id="opp-export" aria-label="${t("export_excel")}">${icons.send}</button>
      </div>
      <div class="vol-chips" id="opp-filters"></div>
      <div class="vol-active" id="opp-active"></div>
      <p class="form-error" id="opp-error" hidden></p>
      <div id="opp-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  $("#back-btn").addEventListener("click", () => navigate.goBack("#/reports"));
  $("#opp-info").addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(t("opp_info_1"))}</p><p>${escapeHtml(t("opp_info_2"))}</p>`));

  const lineName = (id) => {
    const l = cat?.lines.find((x) => x.id === Number(id));
    return l ? (getLang() === "hy" ? l.name_hy : l.name_en) : String(id);
  };
  const placeLabel = (k) => {
    const [r, s] = k.split("::");
    return s && s !== "__none__" ? `${regionLabelHy(r)} › ${subregionLabelHy(s)}` : regionLabelHy(r);
  };
  const query = () =>
    [
      ["region_sub", state.places],
      ["lines", state.lines],
      ["reps", state.reps],
      ["services", state.services],
    ]
      .filter(([, set]) => set.size)
      .map(([k, set]) => `${k}=${encodeURIComponent([...set].join(","))}`)
      .join("&");

  function renderFilters() {
    const defs = [["places", "opp_f_places"], ["lines", "opp_f_lines"], ...(data?.reps?.length > 1 || state.reps.size ? [["reps", "opp_f_reps"]] : []), ["services", "opp_f_services"]];
    const chips = defs.map(([k, label]) => `<button type="button" class="map-filter-chip ${state[k].size ? "chip-active" : ""}" data-f="${k}">${escapeHtml(t(label))}${state[k].size ? ` (${state[k].size})` : ""}</button>`);
    if (defs.some(([k]) => state[k].size)) chips.push(`<button type="button" class="map-filter-chip vol-clear" data-f="clear">${escapeHtml(t("vol_f_clear"))}</button>`);
    $("#opp-filters").innerHTML = chips.join("");
    $("#opp-filters").querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => openFilter(b.dataset.f)));
    const label = { places: placeLabel, lines: lineName, reps: (v) => data?.reps.find((r) => String(r.id) === v)?.name || v, services: (v) => t(`vp_svc_${v}`) };
    const items = [];
    for (const k of ["places", "lines", "reps", "services"]) for (const v of state[k]) items.push(`<button type="button" class="vol-active-chip" data-rm="${k}" data-v="${escapeHtml(v)}">${escapeHtml(label[k](v))} <span aria-hidden="true">×</span></button>`);
    $("#opp-active").innerHTML = items.join("");
    $("#opp-active").querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        state[b.dataset.rm].delete(b.dataset.v);
        renderFilters();
        load();
      })
    );
  }
  const flat = (title, items) => [{ key: "all", name: title, allIds: items.map((i) => i.key), customerCount: items.length, leaves: items.map((i) => ({ id: i.key, name: i.label })), children: null }];
  function openFilter(kind) {
    if (kind === "clear") {
      for (const k of ["places", "lines", "reps", "services"]) state[k] = new Set();
      renderFilters();
      return load();
    }
    const apply = (selected) => {
      state[kind] = new Set([...selected].map(String));
      renderFilters();
      load();
    };
    if (kind === "places") {
      const tree = buildRegionSubregionTree((data?.places ?? []).filter((p) => p.region));
      return openTriStateTreeSheet(t("opp_f_places"), { tree, initialSelectedIds: state.places, countUnitLabel: t("opp_customers_unit"), onApply: apply });
    }
    const items =
      kind === "lines"
        ? cat.lines.map((l) => ({ key: String(l.id), label: lineName(l.id) }))
        : kind === "reps"
          ? (data?.reps ?? []).map((r) => ({ key: String(r.id), label: r.name || "—" }))
          : cat.services.map((s) => ({ key: s.key, label: t(`vp_svc_${s.key}`) }));
    openTriStateTreeSheet(t(`opp_f_${kind}`), { tree: flat(t(`opp_f_${kind}`), items), initialSelectedIds: state[kind], countUnitLabel: "", onApply: apply });
  }

  const shareCell = (p) => (p == null ? "—" : `${p}%`);
  function renderBody() {
    if (!data) return;
    const tot = data.totals;
    const w = data.window;
    const head = `
      <div class="card opp-totals">
        <div><span class="muted">${escapeHtml(t("opp_k_customers"))}</span><strong>${nf(tot.customers)}</strong></div>
        <div><span class="muted">${escapeHtml(t("opp_k_potential"))}</span><strong>${nf(tot.potential)}</strong></div>
        <div><span class="muted">${escapeHtml(t("opp_k_actual"))}</span><strong>${nf(tot.actual)} <small>${shareCell(tot.share_pct)}</small></strong></div>
        <div class="opp-gap"><span class="muted">${escapeHtml(t("opp_k_gap"))}</span><strong>${nf(tot.gap)}</strong></div>
      </div>
      <p class="muted opp-note">${escapeHtml(t("opp_note").replace("{span}", `${formatDateDMY(w.from)} – ${formatDateDMY(w.to)}`))}${data.unmapped_skus ? ` ${escapeHtml(t("opp_unmapped").replace("{n}", data.unmapped_skus))}` : ""}</p>
      <div class="vol-chips vol-chips-small" role="group">${VIEWS.map((v) => `<button type="button" class="map-filter-chip ${state.view === v ? "chip-active" : ""}" data-view="${v}" aria-pressed="${state.view === v}">${escapeHtml(t(`opp_v_${v}`))}</button>`).join("")}</div>`;
    let list;
    if (!data.rows.length) list = `<p class="empty-state">${escapeHtml(t("opp_empty"))}</p>`;
    else if (state.view === "customers") {
      list = `<div class="opp-list">${data.rows
        .map((r) => {
          const lines = r.by_lines ? r.lines.filter((l) => l.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 3).map((l) => `${lineName(l.line_id)} ${nf(l.gap)}`).join(" · ") : t("opp_total_only");
          return `<button type="button" class="opp-row" data-cid="${r.customer_id}">
            <span class="opp-name">${escapeHtml(r.name)}<small class="muted">${escapeHtml([r.region ? regionLabelHy(r.region) : "", r.rep_name || ""].filter(Boolean).join(" · "))}</small></span>
            <span class="opp-nums"><strong>${nf(r.gap)} ${escapeHtml(t("vp_l"))}</strong><small class="muted">${nf(r.actual)} / ${nf(r.potential)} · ${shareCell(r.share_pct)}</small></span>
            <span class="vp-bar opp-bar" aria-hidden="true"><span style="width:${Math.min(100, r.share_pct ?? 0)}%"></span></span>
            <small class="muted opp-lines">${escapeHtml(lines)}${r.has_erp ? "" : ` · ${escapeHtml(t("opp_no_erp"))}`}</small>
          </button>`;
        })
        .join("")}</div>`;
    } else {
      const groups = state.view === "region" ? data.by_region : data.by_rep;
      list = `<div class="card opp-groups">${groups
        .map((g) => `<div class="opp-group"><span>${escapeHtml(state.view === "region" ? (g.label ? regionLabelHy(g.label) : t("opp_no_region")) : g.label || t("opp_no_rep"))}<small class="muted"> · ${nf(g.customers)} ${escapeHtml(t("opp_customers_unit"))}</small></span><span class="opp-nums"><strong>${nf(g.gap)} ${escapeHtml(t("vp_l"))}</strong><small class="muted">${nf(g.actual)} / ${nf(g.potential)} · ${shareCell(g.share_pct)}</small></span></div>`)
        .join("")}</div>`;
    }
    $("#opp-body").innerHTML = head + list;
    $("#opp-body").querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        state.view = b.dataset.view;
        renderBody();
      })
    );
    $("#opp-body").querySelectorAll("[data-cid]").forEach((b) => b.addEventListener("click", () => navigate(`#/customers/${b.dataset.cid}`)));
  }

  async function load() {
    const my = ++seq;
    $("#opp-error").hidden = true;
    try {
      cat ??= await api.getPotentialLines();
      const d = await api.getOpportunities(query());
      if (my !== seq) return;
      data = d;
      renderFilters();
      renderBody();
    } catch (err) {
      if (my !== seq) return;
      $("#opp-body").innerHTML = "";
      $("#opp-error").textContent = err.message;
      $("#opp-error").hidden = false;
    }
  }

  $("#opp-export").addEventListener("click", async (e) => {
    if (!data) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const columns = [
        { header: t("opp_x_customer"), width: 34 },
        { header: t("opp_x_region"), width: 18 },
        { header: t("opp_x_rep"), width: 18 },
        { header: t("opp_k_potential"), type: "number", width: 14 },
        { header: t("opp_k_actual"), type: "number", width: 14 },
        { header: t("opp_x_share"), type: "number", width: 10 },
        { header: t("opp_k_gap"), type: "number", width: 14 },
        { header: t("opp_x_lines"), width: 50 },
      ];
      const rows = data.rows.map((r) => [
        r.name,
        r.region ? regionLabelHy(r.region) : "",
        r.rep_name || "",
        r.potential,
        r.actual,
        r.share_pct ?? "",
        r.gap,
        r.lines.map((l) => `${lineName(l.line_id)}: ${l.actual}/${l.potential}`).join("; "),
      ]);
      const filename = `opportunities-${data.window.to}`;
      await saveBlob(await api.buildXlsx({ filename, sheet: t("report_volume_opportunities_name").slice(0, 31), columns, rows }), `${filename}.xlsx`);
    } catch (err) {
      $("#opp-error").textContent = err.message;
      $("#opp-error").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  renderFilters();
  load();
}
