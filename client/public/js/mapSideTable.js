// Desktop Map side list as a table (docs/desktop-roadmap.md step 8): customer (channel and last visit under it), debt, planned today; tap a header
// to sort (tap again to reverse); "Only the visible area" keeps the rows to the pins on screen; a row click pans the map to the pin and
// opens its popup (map.js onPick). Phones never see it (.map-side-list is hidden below 1024 px). Slim (owner, 2026-10-29): the channel and
// the last visit sit under the name, a long name wraps to two lines instead of being cut, and the list folds into a thin rail (remembered).
import { escapeHtml, formatDayMonth, channelDisplayLabel } from "./util.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";

const SORT_KEY = "fieldvisits_map_side_sort";
const VISIBLE_KEY = "fieldvisits_map_visible_only";
const HIDDEN_KEY = "fieldvisits_map_list_hidden";
// a few thousand pins would make thousands of rows: the list stops here and says how to narrow it
const MAX_ROWS = 400;
const fill = (text, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), text);

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

function dayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function lastVisitText(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.round((dayStart(Date.now()) - dayStart(d)) / 86400000);
  if (days <= 0) return t("mst_today");
  if (days === 1) return t("yesterday");
  return formatDayMonth(d, { year: d.getFullYear() !== new Date().getFullYear() });
}

// three grid cells: customer (its sub line holds the channel and the last visit, so both headings sort from the first cell) | debt | today
const COLUMNS = [
  { key: "name", label: () => t("mst_customer"), cell: 0 },
  { key: "last", label: () => t("last_visit"), cell: 0 },
  { key: "debt", label: () => t("mst_debt"), end: true, cell: 1 },
  { key: "planned", label: () => t("mst_planned"), icon: "calendar", center: true, cell: 2 },
];
const thHtml = (c) =>
  `<button type="button" class="mst-th${c.end ? " mst-end" : ""}${c.center ? " mst-center" : ""}" data-sort="${c.key}"${c.icon ? ` aria-label="${escapeHtml(c.label())}" title="${escapeHtml(c.label())}"` : ""}>${c.icon ? icons[c.icon] : escapeHtml(c.label())}<span class="mst-arrow" aria-hidden="true"></span></button>`;

export function createMapSideTable({ host, onPick, badgeOf, inView, onResize = () => {} }) {
  let entries = [];
  let debt = new Map();
  let planned = new Map();
  let activeId = null;
  let sort = readJson(SORT_KEY, { key: "name", dir: 1 });
  let visibleOnly = readJson(VISIBLE_KEY, false) === true;
  let hidden = readJson(HIDDEN_KEY, false) === true;

  host.classList.add("map-side-table");
  host.innerHTML = `
    <button type="button" class="mst-show icon-btn" aria-label="${escapeHtml(t("mst_show"))}" title="${escapeHtml(t("mst_show"))}">${icons.chevronRight}</button>
    <div class="mst-bar">
      <span class="mst-count muted" aria-live="polite"></span>
      <label class="mst-visible"><input type="checkbox" class="mst-visible-input" ${visibleOnly ? "checked" : ""} /><span>${escapeHtml(t("mst_visible"))}</span></label>
      <button type="button" class="mst-hide icon-btn" aria-label="${escapeHtml(t("mst_hide"))}" title="${escapeHtml(t("mst_hide"))}">${icons.chevronLeft}</button>
    </div>
    <div class="mst-head" role="row">${[0, 1, 2]
      .map((cell) => `<span class="mst-th-cell">${COLUMNS.filter((c) => c.cell === cell).map(thHtml).join('<span class="mst-th-sep" aria-hidden="true">·</span>')}</span>`)
      .join("")}</div>
    <div class="mst-body" role="rowgroup"></div>
    <p class="mst-more muted" hidden></p>`;
  const body = host.querySelector(".mst-body");
  const countEl = host.querySelector(".mst-count");
  const moreEl = host.querySelector(".mst-more");
  const setHidden = (on) => {
    hidden = on;
    host.classList.toggle("is-folded", on);
    writeJson(HIDDEN_KEY, on);
    onResize(); // the map gets the room: Leaflet must measure its box again
  };
  host.classList.toggle("is-folded", hidden);
  host.querySelector(".mst-hide").addEventListener("click", () => setHidden(true));
  host.querySelector(".mst-show").addEventListener("click", () => setHidden(false));

  host.querySelector(".mst-visible-input").addEventListener("change", (e) => {
    visibleOnly = e.target.checked;
    writeJson(VISIBLE_KEY, visibleOnly);
    render();
  });
  host.querySelectorAll(".mst-th").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      // tap the sorted column again to reverse it; a new column starts in its natural order (debt: biggest first)
      sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === "debt" ? -1 : 1 };
      writeJson(SORT_KEY, sort);
      render();
    })
  );
  body.addEventListener("click", (e) => {
    const row = e.target.closest(".mst-row");
    if (!row) return;
    setActive(Number(row.dataset.id));
    onPick(Number(row.dataset.id));
  });

  const sortValue = {
    name: ({ c }) => (c.name || "").toLocaleLowerCase(),
    debt: ({ c }) => debt.get(c.id) ?? 0,
    // never visited sorts as the oldest
    last: ({ c }) => (c.last_visit_at ? new Date(c.last_visit_at).getTime() : 0),
    // planned stops first in route order, the rest after
    planned: ({ c }) => (planned.has(c.id) ? planned.get(c.id).order ?? 0 : Infinity),
  };

  function rowHtml({ c, status }) {
    const badge = badgeOf(status);
    const d = debt.get(c.id);
    const p = planned.get(c.id);
    return `<button type="button" class="mst-row${c.id === activeId ? " is-active" : ""}" data-id="${c.id}" role="row">
      <span class="mst-name"><span class="mst-dot ${badge.cls}" title="${escapeHtml(badge.text)}" aria-label="${escapeHtml(badge.text)}"></span><span class="mst-name-lines"><span class="mst-name-text" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span><span class="mst-sub muted">${[c.sales_channel ? channelDisplayLabel(c.sales_channel) : "", c.last_visit_at ? lastVisitText(c.last_visit_at) : ""].filter(Boolean).map(escapeHtml).join(" · ")}</span></span></span>
      <span class="mst-end mst-debt">${d ? escapeHtml(Math.round(d).toLocaleString("en-US")) : ""}</span>
      <span class="mst-center">${p ? `<span class="mst-stop" style="background:${escapeHtml(p.color || "var(--accent)")}" title="${escapeHtml(fill(t("mst_planned_aria"), { n: p.order ?? "" }))}">${p.order ?? ""}</span>` : ""}</span>
    </button>`;
  }

  function render() {
    const shown = visibleOnly ? entries.filter(({ c }) => inView(c)) : entries;
    const value = sortValue[sort.key] ?? sortValue.name;
    const rows = [...shown].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb, "hy") : va - vb;
      return cmp * sort.dir || (a.c.name || "").localeCompare(b.c.name || "", "hy");
    });
    host.querySelectorAll(".mst-th").forEach((btn) => {
      const on = btn.dataset.sort === sort.key;
      btn.classList.toggle("is-sorted", on);
      btn.setAttribute("aria-sort", on ? (sort.dir > 0 ? "ascending" : "descending") : "none");
      btn.querySelector(".mst-arrow").textContent = on ? (sort.dir > 0 ? "↑" : "↓") : "";
    });
    countEl.textContent = fill(t("mst_count"), { n: rows.length.toLocaleString("en-US") });
    body.innerHTML = rows.length ? rows.slice(0, MAX_ROWS).map(rowHtml).join("") : `<p class="muted mst-empty">${escapeHtml(t("map_search_no_results"))}</p>`;
    moreEl.hidden = rows.length <= MAX_ROWS;
    if (!moreEl.hidden) moreEl.textContent = fill(t("mst_more"), { n: (rows.length - MAX_ROWS).toLocaleString("en-US") });
  }

  function setActive(id) {
    activeId = id;
    body.querySelectorAll(".mst-row.is-active").forEach((el) => el.classList.remove("is-active"));
    body.querySelector(`.mst-row[data-id="${id}"]`)?.classList.add("is-active");
  }

  return {
    setEntries(next) {
      entries = next;
      render();
    },
    setDebt(next) {
      debt = next;
      render();
    },
    setPlanned(next) {
      planned = next;
      render();
    },
    // the map moved: only matters while the list follows the visible area
    mapMoved() {
      if (visibleOnly) render();
    },
    setActive,
  };
}
