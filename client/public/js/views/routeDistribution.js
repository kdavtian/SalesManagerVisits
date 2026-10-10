import { api } from "../api.js";
import { escapeHtml, activateDialog, REGION_LIST, YEREVAN_DISTRICTS, SALES_CHANNELS, regionLabelHy, subregionLabelHy, channelDisplayLabel } from "../util.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

// Routes Distribution: which sales channel (and, through the channel, which
// manager) a new customer in a region/subregion is suggested. A whole-region
// mapping is the default for the region; a subregion mapping overrides it.
// Region -> subregion accordion with tri-state checkboxes; every row has a
// channel button on its right, and a floating bar applies one channel to
// everything ticked. Node ids: "R" for a region, "R::S" for a subregion.
const subId = (region, subregion) => `${region}::${subregion}`;

export async function renderRouteDistribution(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("route_distribution_title")}</h1></div>
      </div>
      <p class="muted">${t("route_distribution_manager_hint")}</p>
      <input type="search" class="route-plan-tree-search" id="rd-search" placeholder="${escapeHtml(t("search"))}" aria-label="${escapeHtml(t("search"))}" />
      <p class="form-error" id="rd-error" hidden></p>
      <div id="rd-tree"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="rd-bulk-bar" id="rd-bulk-bar" hidden>
        <span id="rd-bulk-count"></span>
        <button type="button" class="btn" id="rd-bulk-clear">${t("clear")}</button>
        <button type="button" class="btn btn-primary" id="rd-bulk-set">${t("route_distribution_set_channel")}</button>
      </div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/route-plans"));
  const treeEl = container.querySelector("#rd-tree");
  const errorEl = container.querySelector("#rd-error");
  const bulkBar = container.querySelector("#rd-bulk-bar");
  const searchEl = container.querySelector("#rd-search");

  let mappings;
  let regionRows;
  try {
    [mappings, regionRows] = await Promise.all([api.listRouteDistribution(), api.getCustomerRegions().catch(() => [])]);
  } catch (err) {
    treeEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  // region -> sorted subregion list, from the fixed lists, the customers'
  // own values and anything already mapped.
  const subsByRegion = new Map(REGION_LIST.map((r) => [r, new Set(r === "Yerevan" ? YEREVAN_DISTRICTS : [])]));
  const addPair = (region, subregion) => {
    if (!region) return;
    if (!subsByRegion.has(region)) subsByRegion.set(region, new Set());
    if (subregion) subsByRegion.get(region).add(subregion);
  };
  regionRows.forEach((r) => addPair(r.region, r.subregion));
  mappings.forEach((m) => addPair(m.region, m.subregion));
  const regions = [...subsByRegion.keys()].sort((a, b) => regionLabelHy(a).localeCompare(regionLabelHy(b)));
  const subsOf = (region) => [...subsByRegion.get(region)].sort((a, b) => subregionLabelHy(a).localeCompare(subregionLabelHy(b)));

  const channelOf = new Map(); // node id -> channel code
  const rebuildMap = () => {
    channelOf.clear();
    for (const m of mappings) channelOf.set(m.subregion ? subId(m.region, m.subregion) : m.region, m.sales_channel);
  };
  rebuildMap();

  const selected = new Set();
  const expanded = new Set();

  function channelButton(id, region) {
    const own = channelOf.get(id);
    const inherited = !own && id !== region ? channelOf.get(region) : null;
    const label = own ? channelDisplayLabel(own) : inherited ? channelDisplayLabel(inherited) : t("route_distribution_no_channel");
    const cls = own ? "rd-channel-btn rd-channel-set" : inherited ? "rd-channel-btn rd-channel-inherited" : "rd-channel-btn";
    return `<button type="button" class="${cls}" data-channel-for="${escapeHtml(id)}" aria-label="${escapeHtml(t("sales_channel"))}: ${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  }

  function paint() {
    const q = searchEl.value.trim().toLowerCase();
    const html = regions
      .map((region) => {
        const subs = subsOf(region);
        const regionName = regionLabelHy(region);
        const visibleSubs = q ? subs.filter((s) => `${subregionLabelHy(s)} ${s}`.toLowerCase().includes(q)) : subs;
        const regionMatches = !q || `${regionName} ${region}`.toLowerCase().includes(q);
        if (!regionMatches && !visibleSubs.length) return "";
        const shownSubs = regionMatches ? subs : visibleSubs;
        const open = q ? true : expanded.has(region);
        const subSelected = subs.filter((s) => selected.has(subId(region, s))).length;
        const checked = selected.has(region);
        const indeterminate = !checked && subSelected > 0;
        return `
        <div class="route-plan-tree-node">
          <div class="route-plan-tree-row" data-toggle="${escapeHtml(region)}" role="button" tabindex="0" aria-expanded="${open}">
            <input type="checkbox" class="route-plan-tree-check" data-check="${escapeHtml(region)}" ${checked ? "checked" : ""} ${indeterminate ? 'data-indeterminate="1"' : ""} aria-label="${escapeHtml(regionName)}" />
            <span class="route-plan-tree-name">${escapeHtml(regionName)}</span>
            ${subs.length ? `<span class="route-plan-tree-count">${subs.length}</span>` : ""}
            ${channelButton(region, region)}
            ${subs.length ? `<span class="route-plan-tree-chevron" aria-hidden="true">${icons.chevronDown}</span>` : ""}
          </div>
          ${
            shownSubs.length
              ? `<div class="route-plan-tree-children ${open ? "expanded" : ""}"><div class="route-plan-tree-children-inner">
              ${shownSubs
                .map((s) => {
                  const id = subId(region, s);
                  return `<div class="route-plan-tree-row route-plan-tree-row-leaf">
                    <input type="checkbox" class="route-plan-tree-check" data-check="${escapeHtml(id)}" ${selected.has(id) ? "checked" : ""} aria-label="${escapeHtml(subregionLabelHy(s))}" />
                    <span class="route-plan-tree-name">${escapeHtml(subregionLabelHy(s))}</span>
                    ${channelButton(id, region)}
                  </div>`;
                })
                .join("")}
            </div></div>`
              : ""
          }
        </div>`;
      })
      .join("");
    treeEl.innerHTML = html || `<p class="empty-state">${t("route_distribution_no_match")}</p>`;
    treeEl.querySelectorAll("[data-indeterminate]").forEach((el) => (el.indeterminate = true));

    const n = selected.size;
    bulkBar.hidden = n === 0;
    container.querySelector("#rd-bulk-count").textContent = `${n}`;
  }

  treeEl.addEventListener("click", (e) => {
    const channelBtn = e.target.closest("[data-channel-for]");
    if (channelBtn) {
      e.stopPropagation();
      openChannelSheet([channelBtn.dataset.channelFor]);
      return;
    }
    const check = e.target.closest("[data-check]");
    if (check) {
      const id = check.dataset.check;
      if (id.includes("::")) {
        const [region] = id.split("::");
        if (check.checked) selected.add(id);
        else selected.delete(id);
        const subs = subsOf(region);
        if (subs.length && subs.every((s) => selected.has(subId(region, s)))) selected.add(region);
        else selected.delete(region);
      } else {
        for (const s of subsOf(id)) {
          if (check.checked) selected.add(subId(id, s));
          else selected.delete(subId(id, s));
        }
        if (check.checked) selected.add(id);
        else selected.delete(id);
      }
      paint();
      return;
    }
    const row = e.target.closest("[data-toggle]");
    if (row) {
      const region = row.dataset.toggle;
      if (expanded.has(region)) expanded.delete(region);
      else expanded.add(region);
      paint();
    }
  });
  treeEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-toggle]")) {
      e.preventDefault();
      e.target.click();
    }
  });
  searchEl.addEventListener("input", paint);
  container.querySelector("#rd-bulk-clear").addEventListener("click", () => {
    selected.clear();
    paint();
  });
  container.querySelector("#rd-bulk-set").addEventListener("click", () => openChannelSheet([...selected]));

  // One sheet for both a single row and the bulk bar: pick a channel (or
  // clear) and every given node id is written in one request.
  function openChannelSheet(ids) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet filter-sheet">
        <h2>${escapeHtml(t("sales_channel"))}${ids.length > 1 ? ` (${ids.length})` : ""}</h2>
        <div class="rd-channel-options">
          ${SALES_CHANNELS.map((c) => `<button type="button" class="chip" data-pick="${escapeHtml(c)}">${escapeHtml(channelDisplayLabel(c))}</button>`).join("")}
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="rd-sheet-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-danger" id="rd-sheet-clear">${t("route_distribution_no_channel")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#rd-sheet-cancel").addEventListener("click", () => overlay.remove());

    async function apply(channel) {
      overlay.remove();
      errorEl.hidden = true;
      const items = ids.map((id) => {
        const [region, subregion] = id.split("::");
        return { region, subregion: subregion || null, sales_channel: channel };
      });
      try {
        mappings = await api.bulkRouteDistribution(items);
        rebuildMap();
        selected.clear();
        paint();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }
    overlay.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => apply(b.dataset.pick)));
    overlay.querySelector("#rd-sheet-clear").addEventListener("click", () => apply(null));
  }

  paint();
}
