// Shared Region -> Subregion -> [leaf] accordion tree: expandable groups
// with tri-state (checked/indeterminate/unchecked) checkboxes, used
// anywhere the app offers "pick some customers, grouped by where they
// are" -- Route Plans' own customer-pick sheet (leaf = an individual
// customer), the Map's Plan Day picker (same shape), and the Customers
// list's region filter (leaf = a whole subregion, no customer level).
// Extracted from routePlans.js so all three stay visually and behaviorally
// identical instead of drifting apart as three separate implementations.
import { escapeHtml, activateDialog } from "./util.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";

export const NO_GROUP_KEY = "__none__";

// Groups a flat customer list into Region -> Subregion -> Customer, skipping
// the subregion level entirely for a region where every customer has no
// subregion (true for every region except Yerevan, see YEREVAN_DISTRICTS in
// util.js) since a single "no subregion" bucket there would just be an extra
// tap for nothing. Each leaf is {id: customer.id, name: customer.name}.
export function buildCustomerTree(customers) {
  const regionMap = new Map();
  const regionOrder = [];
  for (const c of customers) {
    const rKey = c.region || NO_GROUP_KEY;
    if (!regionMap.has(rKey)) {
      regionMap.set(rKey, { name: c.region || t("no_region"), customers: [] });
      regionOrder.push(rKey);
    }
    regionMap.get(rKey).customers.push(c);
  }
  regionOrder.sort((a, b) => {
    if (a === NO_GROUP_KEY) return 1;
    if (b === NO_GROUP_KEY) return -1;
    return regionMap.get(a).name.localeCompare(regionMap.get(b).name);
  });

  return regionOrder.map((rKey, i) => {
    const region = regionMap.get(rKey);
    const key = `r${i}`;
    const subMap = new Map();
    const subOrder = [];
    for (const c of region.customers) {
      const sKey = c.subregion || NO_GROUP_KEY;
      if (!subMap.has(sKey)) {
        subMap.set(sKey, { name: c.subregion || t("no_subregion"), customers: [] });
        subOrder.push(sKey);
      }
      subMap.get(sKey).customers.push(c);
    }
    const hasRealSubregions = !(subOrder.length === 1 && subOrder[0] === NO_GROUP_KEY);
    subOrder.sort((a, b) => {
      if (a === NO_GROUP_KEY) return 1;
      if (b === NO_GROUP_KEY) return -1;
      return subMap.get(a).name.localeCompare(subMap.get(b).name);
    });

    return {
      key,
      name: region.name,
      allIds: region.customers.map((c) => c.id),
      leaves: hasRealSubregions ? null : [...region.customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name })),
      children: hasRealSubregions
        ? subOrder.map((sKey, j) => {
            const sub = subMap.get(sKey);
            return {
              key: `${key}-s${j}`,
              name: sub.name,
              allIds: sub.customers.map((c) => c.id),
              leaves: [...sub.customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name })),
              children: null,
            };
          })
        : null,
    };
  });
}

// Groups a flat customer list into Region -> Subregion, with each
// SUBREGION itself as a selectable leaf (id = "region::subregion") rather
// than drilling down to individual customers -- what a list FILTER needs
// (narrow to a set of subregions) as opposed to a picker (choose specific
// customers). A region with no real subregions gets one leaf standing in
// for the whole region.
export function buildRegionSubregionTree(customers) {
  const regionMap = new Map();
  const regionOrder = [];
  for (const c of customers) {
    if (!c.region) continue;
    const rKey = c.region;
    if (!regionMap.has(rKey)) {
      regionMap.set(rKey, { name: c.region, customers: [] });
      regionOrder.push(rKey);
    }
    regionMap.get(rKey).customers.push(c);
  }
  regionOrder.sort((a, b) => regionMap.get(a).name.localeCompare(regionMap.get(b).name));

  return regionOrder.map((rKey, i) => {
    const region = regionMap.get(rKey);
    const key = `r${i}`;
    const subMap = new Map();
    const subOrder = [];
    for (const c of region.customers) {
      const sKey = c.subregion || NO_GROUP_KEY;
      if (!subMap.has(sKey)) {
        subMap.set(sKey, { name: c.subregion || t("no_subregion"), customers: [] });
        subOrder.push(sKey);
      }
      subMap.get(sKey).customers.push(c);
    }
    subOrder.sort((a, b) => {
      if (a === NO_GROUP_KEY) return 1;
      if (b === NO_GROUP_KEY) return -1;
      return subMap.get(a).name.localeCompare(subMap.get(b).name);
    });

    return {
      key,
      name: region.name,
      allIds: region.customers.map((c) => c.id),
      leaves: subOrder.map((sKey) => {
        const sub = subMap.get(sKey);
        return { id: `${rKey}::${sKey}`, name: sub.name, ids: sub.customers.map((c) => c.id) };
      }),
      children: null,
    };
  });
}

function leafRowHtml(leaf) {
  return `
    <label class="route-plan-tree-row route-plan-tree-row-leaf">
      <input type="checkbox" class="route-plan-tree-check" data-leaf-id="${escapeHtml(String(leaf.id))}" />
      <span class="route-plan-tree-name">${escapeHtml(leaf.name)}</span>
    </label>`;
}

function groupNodeHtml(node, countUnitLabel, nested) {
  const childrenHtml = node.children
    ? node.children.map((c) => groupNodeHtml(c, countUnitLabel, true)).join("")
    : node.leaves.map(leafRowHtml).join("");
  return `
    <div class="route-plan-tree-node ${nested ? "route-plan-tree-node-nested" : ""}">
      <div class="route-plan-tree-row" data-toggle="${escapeHtml(node.key)}" role="button" tabindex="0" aria-expanded="false">
        <input type="checkbox" class="route-plan-tree-check" data-group-key="${escapeHtml(node.key)}" />
        <span class="route-plan-tree-name">${escapeHtml(node.name)}</span>
        <span class="route-plan-tree-count">${node.allIds.length} ${countUnitLabel}</span>
        <span class="route-plan-tree-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </div>
      <div class="route-plan-tree-children" data-children-for="${escapeHtml(node.key)}">
        <div class="route-plan-tree-children-inner">${childrenHtml}</div>
      </div>
    </div>`;
}

// Walks the tree in the same pre-order every HTML string above is built in,
// so a plain document-order DOM query lines back up with this array by
// index -- avoids ever needing to CSS-escape a generated key to look an
// element back up.
function collectGroupNodes(nodes, out = []) {
  for (const n of nodes) {
    if (n.children) {
      out.push(n);
      collectGroupNodes(n.children, out);
    } else {
      out.push(n);
    }
  }
  return out;
}

function setSelection(ids, checked, selectedIds) {
  for (const id of ids) {
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
  }
}

function applyGroupState(checkbox, ids, selectedIds) {
  if (!checkbox) return;
  const checkedCount = ids.filter((id) => selectedIds.has(id)).length;
  checkbox.checked = ids.length > 0 && checkedCount === ids.length;
  checkbox.indeterminate = checkedCount > 0 && checkedCount < ids.length;
}

// Renders the accordion into listEl and wires up every interaction. The
// Set of selected leaf ids is the single source of truth -- every group's
// checked/indeterminate state is always *derived* from it (never
// hand-tracked), so any change (a leaf checkbox, or a group checkbox that
// bulk (de)selects every leaf beneath it) ends by recomputing every
// ancestor's state from scratch. Returns the live selectedIds Set so the
// caller can read it back on Save/Apply.
//
// IDs are normalized to strings throughout (a DOM dataset value is always
// a string, so comparing against it consistently avoids ever needing to
// know whether a caller's own ids are numbers -- customer ids -- or
// strings -- "region::subregion" filter keys). initialSelectedIds and the
// returned Set are both string sets; a caller that needs numeric customer
// ids back (e.g. to save a visit plan) converts with Number(id) itself.
//
// tree: output of buildCustomerTree/buildRegionSubregionTree.
// countUnitLabel: unit word shown next to each group's count (e.g. "customers").
// totalLabel(n): optional -- if given, a total-selected line is shown above
//   the tree, rendered via this function.
export function renderTriStateTree(listEl, { tree, initialSelectedIds, countUnitLabel, totalLabel }) {
  const selectedIds = new Set([...initialSelectedIds].map(String));
  const groupNodes = collectGroupNodes(tree);

  listEl.innerHTML = `
    ${totalLabel ? `<p class="route-plan-tree-total" id="tree-selected-total"></p>` : ""}
    <div class="route-plan-tree">${tree.map((n) => groupNodeHtml(n, countUnitLabel, false)).join("")}</div>
  `;
  const totalEl = totalLabel ? listEl.querySelector("#tree-selected-total") : null;
  // Both built via the exact same pre-order recursion, so index i here is
  // the same node as groupNodes[i].
  const groupCheckboxEls = [...listEl.querySelectorAll("input[data-group-key]")];
  const groupAllIdStrings = groupNodes.map((node) => node.allIds.map(String));

  function recompute() {
    listEl.querySelectorAll("input[data-leaf-id]").forEach((cb) => {
      cb.checked = selectedIds.has(cb.dataset.leafId);
    });
    groupNodes.forEach((node, i) => applyGroupState(groupCheckboxEls[i], groupAllIdStrings[i], selectedIds));
    if (totalEl) totalEl.textContent = totalLabel(selectedIds.size);
  }

  function toggleExpand(row) {
    const key = row.dataset.toggle;
    const childrenEl = listEl.querySelector(`.route-plan-tree-children[data-children-for="${key}"]`);
    const expanded = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", String(!expanded));
    childrenEl?.classList.toggle("expanded", !expanded);
  }

  listEl.querySelectorAll(".route-plan-tree-row[data-toggle]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      toggleExpand(row);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target.closest("input")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpand(row);
      }
    });
  });

  listEl.querySelectorAll("input[data-leaf-id]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(cb.dataset.leafId);
      else selectedIds.delete(cb.dataset.leafId);
      recompute();
    });
  });

  groupNodes.forEach((node, i) => {
    groupCheckboxEls[i].addEventListener("change", () => {
      setSelection(groupAllIdStrings[i], groupCheckboxEls[i].checked, selectedIds);
      recompute();
    });
  });

  recompute();
  return selectedIds;
}

// A compact 44px icon button that opens this tree as a full-height bottom
// sheet -- for the Customers list's region filter, where there's no
// existing host sheet to render into (unlike Route Plans/Plan Day, which
// already have one with a Save/Done button of their own).
export function openTriStateTreeSheet(titleText, { tree, initialSelectedIds, countUnitLabel, totalLabel, onApply }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet region-filter-sheet">
      <h2>${escapeHtml(titleText)}</h2>
      <div id="tree-sheet-body"></div>
      <div class="sheet-actions">
        <button type="button" class="btn" id="tree-sheet-clear">${t("clear")}</button>
        <button type="button" class="btn btn-primary" id="tree-sheet-done">${t("done")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const bodyEl = overlay.querySelector("#tree-sheet-body");
  let selectedIds = renderTriStateTree(bodyEl, { tree, initialSelectedIds, countUnitLabel, totalLabel });

  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector("#tree-sheet-clear").addEventListener("click", () => {
    selectedIds = renderTriStateTree(bodyEl, { tree, initialSelectedIds: [], countUnitLabel, totalLabel });
  });
  overlay.querySelector("#tree-sheet-done").addEventListener("click", () => {
    overlay.remove();
    onApply(selectedIds);
  });
}
