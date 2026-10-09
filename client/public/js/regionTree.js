// Shared Region -> Subregion -> [leaf] accordion tree: expandable groups
// with tri-state (checked/indeterminate/unchecked) checkboxes, used
// anywhere the app offers "pick some customers, grouped by where they
// are" -- Route Plans' own customer-pick sheet (leaf = an individual
// customer), the Map's Plan Day picker (same shape), and the Customers
// list's region filter (leaf = a whole subregion, no customer level).
// Extracted from routePlans.js so all three stay visually and behaviorally
// identical instead of drifting apart as three separate implementations.
import { escapeHtml, activateDialog, regionLabelHy, subregionLabelHy } from "./util.js";
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
      regionMap.set(rKey, { name: c.region ? regionLabelHy(c.region) : t("no_region"), customers: [] });
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
        subMap.set(sKey, { name: c.subregion ? subregionLabelHy(c.subregion) : t("no_subregion"), customers: [] });
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
      // Customer ids double as leaf ids here (a leaf IS a customer), so
      // allIds (used for tri-state selection matching) and customerCount
      // (used for the "N customers" badge) happen to come from the same
      // array -- unlike buildRegionSubregionTree below, where they don't.
      allIds: region.customers.map((c) => c.id),
      customerCount: region.customers.length,
      leaves: hasRealSubregions ? null : [...region.customers].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.id, name: c.name })),
      children: hasRealSubregions
        ? subOrder.map((sKey, j) => {
            const sub = subMap.get(sKey);
            return {
              key: `${key}-s${j}`,
              name: sub.name,
              allIds: sub.customers.map((c) => c.id),
              customerCount: sub.customers.length,
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
      regionMap.set(rKey, { name: regionLabelHy(c.region), customers: [] });
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
        subMap.set(sKey, { name: c.subregion ? subregionLabelHy(c.subregion) : t("no_subregion"), customers: [] });
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
      // Unlike buildCustomerTree, a leaf here is a whole SUBREGION, not a
      // customer -- so allIds (for tri-state selection matching) must be
      // the leaf ids ("region::subregion" keys), while customerCount (for
      // the "N customers" badge) is a separate tally of the actual
      // customers those subregions contain.
      allIds: subOrder.map((sKey) => `${rKey}::${sKey}`),
      customerCount: region.customers.length,
      leaves: subOrder.map((sKey) => {
        const sub = subMap.get(sKey);
        return { id: `${rKey}::${sKey}`, name: sub.name };
      }),
      children: null,
    };
  });
}

// Sales direction (sales_channel) -> assigned sales manager, each MANAGER a
// selectable leaf (id = "channel::managerId") -- the Customers list's
// assignment filter for roles that see everyone's customers. Needs the
// list rows' assigned_manager_name (GET /customers joins it in).
export function buildDirectionManagerTree(customers, { channelLabel, noDirectionLabel, unassignedLabel }) {
  const channelMap = new Map();
  const channelOrder = [];
  for (const c of customers) {
    const dKey = c.sales_channel || NO_GROUP_KEY;
    if (!channelMap.has(dKey)) {
      channelMap.set(dKey, { name: c.sales_channel ? channelLabel(c.sales_channel) : noDirectionLabel, customers: [] });
      channelOrder.push(dKey);
    }
    channelMap.get(dKey).customers.push(c);
  }
  channelOrder.sort((a, b) => {
    if (a === NO_GROUP_KEY) return 1;
    if (b === NO_GROUP_KEY) return -1;
    return channelMap.get(a).name.localeCompare(channelMap.get(b).name);
  });

  return channelOrder.map((dKey, i) => {
    const channel = channelMap.get(dKey);
    const mgrMap = new Map();
    for (const c of channel.customers) {
      const mKey = c.assigned_manager_id ?? NO_GROUP_KEY;
      if (!mgrMap.has(mKey)) {
        mgrMap.set(mKey, { name: c.assigned_manager_id != null ? c.assigned_manager_name || `#${c.assigned_manager_id}` : unassignedLabel, count: 0 });
      }
      mgrMap.get(mKey).count += 1;
    }
    const managers = [...mgrMap.entries()].sort(([a, x], [b, y]) => {
      if (a === NO_GROUP_KEY) return 1;
      if (b === NO_GROUP_KEY) return -1;
      return x.name.localeCompare(y.name);
    });
    return {
      key: `d${i}`,
      name: channel.name,
      allIds: managers.map(([mKey]) => `${dKey}::${mKey}`),
      customerCount: channel.customers.length,
      leaves: managers.map(([mKey, m]) => ({ id: `${dKey}::${mKey}`, name: `${m.name} (${m.count})` })),
      children: null,
    };
  });
}

// Customer type (category) -> tier. Leaf ids are "category::tier"; a missing
// category is NO_GROUP_KEY. tiers is the ordered [{value,label}] list.
export function buildCategoryTierTree(customers, { categoryLabel, tiers, noCategoryLabel }) {
  const catMap = new Map();
  for (const c of customers) {
    const key = c.category || NO_GROUP_KEY;
    if (!catMap.has(key)) catMap.set(key, []);
    catMap.get(key).push(c);
  }
  const keys = [...catMap.keys()].sort((a, b) => {
    if (a === NO_GROUP_KEY) return 1;
    if (b === NO_GROUP_KEY) return -1;
    return categoryLabel(a).localeCompare(categoryLabel(b));
  });
  return keys.map((key, i) => {
    const list = catMap.get(key);
    const leaves = tiers
      .map((tier) => ({
        id: `${key}::${tier.value}`,
        name: `${tier.label} (${list.filter((c) => (c.customer_tier || "potential") === tier.value).length})`,
        n: list.filter((c) => (c.customer_tier || "potential") === tier.value).length,
      }))
      .filter((l) => l.n > 0)
      .map(({ id, name }) => ({ id, name }));
    return {
      key: `t${i}`,
      name: key === NO_GROUP_KEY ? noCategoryLabel : categoryLabel(key),
      allIds: leaves.map((l) => l.id),
      customerCount: list.length,
      leaves,
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
        <span class="route-plan-tree-count">${node.customerCount}<span class="route-plan-tree-unit"> ${countUnitLabel}</span></span>
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

// Hides/shows leaf rows and their ancestor group nodes to match a search
// query -- a leaf matches on its own name; a group matches if its own name
// matches OR any descendant leaf/group does, and auto-expands to reveal
// whichever child actually matched. Processes .route-plan-tree-node
// elements in reverse document order (innermost/deepest first) so a
// parent's "does any child still match" check always sees its children's
// already-resolved hidden state.
function applyTreeSearch(bodyEl, query) {
  const q = query.trim().toLowerCase();
  bodyEl.querySelectorAll(".route-plan-tree-row-leaf").forEach((row) => {
    const name = row.querySelector(".route-plan-tree-name")?.textContent.toLowerCase() || "";
    row.hidden = q.length > 0 && !name.includes(q);
  });
  [...bodyEl.querySelectorAll(".route-plan-tree-node")].reverse().forEach((nodeEl) => {
    if (!q) {
      nodeEl.hidden = false;
      return;
    }
    const headerRow = nodeEl.querySelector(":scope > .route-plan-tree-row");
    const ownName = headerRow?.querySelector(".route-plan-tree-name")?.textContent.toLowerCase() || "";
    const hasVisibleChild = Boolean(
      nodeEl.querySelector(".route-plan-tree-row-leaf:not([hidden]), .route-plan-tree-node:not([hidden])")
    );
    nodeEl.hidden = !ownName.includes(q) && !hasVisibleChild;
    if (!nodeEl.hidden && hasVisibleChild) {
      headerRow?.setAttribute("aria-expanded", "true");
      nodeEl.querySelector(":scope > .route-plan-tree-children")?.classList.add("expanded");
    }
  });
}

// A compact 44px icon button that opens this tree as a full-height bottom
// sheet -- for the Customers list's region filter, where there's no
// existing host sheet to render into (unlike Route Plans/Plan Day, which
// already have one with a Save/Done button of their own). searchPlaceholder
// is optional -- pass it to add a search box above the tree that filters
// leaves/groups by name as the caller types (Pricelist's Brand > Category >
// Product picker; every other caller so far has a short enough tree that a
// search box would just be another tap for nothing).
export function openTriStateTreeSheet(titleText, { tree, initialSelectedIds, countUnitLabel, totalLabel, onApply, searchPlaceholder }) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet filter-sheet">
      <h2>${escapeHtml(titleText)}</h2>
      ${
        searchPlaceholder
          ? `<input type="search" class="route-plan-tree-search" id="tree-sheet-search" placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(searchPlaceholder)}" />`
          : ""
      }
      <div id="tree-sheet-body"></div>
      <div class="sheet-actions">
        <button type="button" class="btn" id="tree-sheet-clear">${t("clear")}</button>
        <button type="button" class="btn btn-primary" id="tree-sheet-done">${t("show_results")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const bodyEl = overlay.querySelector("#tree-sheet-body");
  let selectedIds = renderTriStateTree(bodyEl, { tree, initialSelectedIds, countUnitLabel, totalLabel });

  const searchInput = overlay.querySelector("#tree-sheet-search");
  searchInput?.addEventListener("input", () => applyTreeSearch(bodyEl, searchInput.value));

  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector("#tree-sheet-clear").addEventListener("click", () => {
    selectedIds = renderTriStateTree(bodyEl, { tree, initialSelectedIds: [], countUnitLabel, totalLabel });
    if (searchInput?.value) applyTreeSearch(bodyEl, searchInput.value);
  });
  overlay.querySelector("#tree-sheet-done").addEventListener("click", () => {
    overlay.remove();
    onApply(selectedIds);
  });
}
