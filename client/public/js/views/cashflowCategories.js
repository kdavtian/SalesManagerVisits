// Cashflow categories (owner, 2026-11-07): the IN / OUT / Transfer -> category -> subcategory tree, managed by the admin / CEO.
// Add a category (with which way its money goes and its cash flow section) or a subcategory under it, rename, note, move a subcategory to
// another category, remove -- a category that has rows (or subcategories) asks where they go first. The Excel's own names keep working:
// a renamed or removed name is remembered by the server (cash_category_aliases) and its new Excel rows land where it was moved.
// Server: server/src/money/routes/cashflow.js (/categories).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { activateDialog, escapeHtml, showToast } from "../util.js";
import { icons } from "../icons.js";

const DIRECTIONS = ["in", "out", "both", "transfer"];
const SECTIONS = ["operating", "investing", "financing", "owner", "internal"];
const SYSTEM = new Set(["oil order", "salary"]); // used by the app itself: kept, not renamed or removed

function sheet(html, klass = "") {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet ${klass}">${html}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (ev) => ev.target === overlay && overlay.remove());
  return overlay;
}

/** Opens the manager; `onChanged()` runs after every change (the Cashflow screen reloads its lists). */
export async function openCashCategoryManager({ onChanged } = {}) {
  const overlay = sheet(`<p class="loading-state" role="status">${t("loading")}</p>`, "ccm-sheet");
  const body = overlay.querySelector(".sheet");
  let cats = [];

  async function load() {
    cats = (await api.getCashMeta({})).categories;
    paint();
  }

  const leafRow = (c) => `<button type="button" class="ccm-row ccm-sub" data-id="${c.id}">
      <span class="ccm-name">${escapeHtml(c.name)}${c.active === false ? ` <span class="badge badge-neutral">${t("ccm_off")}</span>` : ""}${c.note ? `<small class="muted ccm-note">${escapeHtml(c.note)}</small>` : ""}</span>
      <span class="muted ccm-n">${c.n || 0}</span>
    </button>`;

  function paint() {
    const groups = cats.filter((c) => c.is_group);
    const unsorted = cats.filter((c) => !c.is_group && !c.parent_id);
    const section = (dir) => {
      const list = groups.filter((g) => g.direction === dir);
      if (!list.length) return "";
      return `<h3 class="ccm-dir">${t(`ccm_dir_${dir}`)}</h3>${list
        .map((g) => {
          const subs = cats.filter((c) => String(c.parent_id) === String(g.id));
          return `<div class="card ccm-group">
            <button type="button" class="ccm-row ccm-head" data-id="${g.id}">
              <span class="ccm-name"><strong>${escapeHtml(g.name)}</strong> <span class="badge badge-neutral">${t(`ccm_sec_${g.section}`)}</span>${g.note ? `<small class="muted ccm-note">${escapeHtml(g.note)}</small>` : ""}</span>
              <span class="muted ccm-n">${subs.reduce((a, c) => a + (c.n || 0), g.n || 0)}</span>
            </button>
            ${subs.map(leafRow).join("")}
            <button type="button" class="ccm-add-sub" data-add-sub="${g.id}">+ ${t("ccm_add_sub")}</button>
          </div>`;
        })
        .join("")}`;
    };
    body.innerHTML = `
      <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>
      <h2>${t("ccm_title")} <button type="button" class="settings-hint-icon" id="ccm-hint-btn" aria-label="${t("more_info")}" aria-expanded="false">!</button></h2>
      <p class="muted ccm-hint" id="ccm-hint" hidden>${t("ccm_hint")}</p>
      ${DIRECTIONS.map(section).join("")}
      ${unsorted.length ? `<h3 class="ccm-dir">${t("cf_unsorted")}</h3><div class="card ccm-group">${unsorted.map(leafRow).join("")}</div>` : ""}
      <div class="sheet-actions"><button type="button" class="btn btn-primary" id="ccm-add-group">+ ${t("ccm_add_group")}</button></div>`;
    body.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    body.querySelector("#ccm-hint-btn").addEventListener("click", (e) => {
      const hint = body.querySelector("#ccm-hint");
      hint.hidden = !hint.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!hint.hidden));
    });
    body.querySelector("#ccm-add-group").addEventListener("click", () => editSheet(null, { group: true }));
    body.querySelectorAll("[data-add-sub]").forEach((b) => b.addEventListener("click", () => editSheet(null, { parentId: Number(b.dataset.addSub) })));
    body.querySelectorAll(".ccm-row[data-id]").forEach((b) => b.addEventListener("click", () => editSheet(cats.find((c) => String(c.id) === b.dataset.id))));
  }

  // add / edit one category; remove it from here too
  function editSheet(cat, { group = false, parentId = null } = {}) {
    const isGroup = cat ? cat.is_group : group;
    const system = cat && SYSTEM.has(cat.name.toLowerCase());
    const groups = cats.filter((c) => c.is_group);
    const ed = sheet(`
      <h2>${t(cat ? "ccm_edit" : isGroup ? "ccm_add_group" : "ccm_add_sub")}</h2>
      <form id="ccm-form" autocomplete="off">
        <label>${t("ccm_name")}<input name="name" required maxlength="60" value="${escapeHtml(cat?.name ?? "")}" ${system ? "readonly" : ""} /></label>
        ${system ? `<p class="muted ccm-note">${t("ccm_system")}</p>` : ""}
        ${
          isGroup
            ? `<div class="pa-two">
                <label>${t("ccm_direction")}<select name="direction">${DIRECTIONS.map((d) => `<option value="${d}" ${(cat?.direction ?? "out") === d ? "selected" : ""}>${t(`ccm_dir_${d}`)}</option>`).join("")}</select></label>
                <label>${t("ccm_section")}<select name="section">${SECTIONS.map((x) => `<option value="${x}" ${(cat?.section ?? "operating") === x ? "selected" : ""}>${t(`ccm_sec_${x}`)}</option>`).join("")}</select></label>
              </div>`
            : `<label>${t("ccm_parent")}<select name="parent_id">${groups.map((g) => `<option value="${g.id}" ${String(cat?.parent_id ?? parentId) === String(g.id) ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}</select></label>`
        }
        <label>${t("ccm_note")}<input name="note" maxlength="500" value="${escapeHtml(cat?.note ?? "")}" /></label>
        <div id="ccm-remove" hidden>
          <label>${t("ccm_move_to")}<select name="move_to"><option value="">${t("ccm_pick")}</option>${cats
            .filter((c) => cat && c.id !== cat.id && String(c.parent_id) !== String(cat.id) && (!isGroup || c.is_group))
            .map((c) => `<option value="${c.id}">${escapeHtml(c.parent_id ? `${groups.find((g) => g.id === c.parent_id)?.name ?? ""} › ${c.name}` : c.name)}</option>`)
            .join("")}</select></label>
          <p class="muted ccm-note">${t("ccm_move_hint").replace("{n}", String(cat?.n ?? 0))}</p>
        </div>
        <p class="form-error" id="ccm-error" hidden></p>
        <div class="sheet-actions">
          ${cat && !system ? `<button type="button" class="btn btn-danger" id="ccm-del">${t("ccm_remove")}</button>` : ""}
          <button type="button" class="btn" id="ccm-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>`);
    const form = ed.querySelector("#ccm-form");
    const errEl = ed.querySelector("#ccm-error");
    const fail = (m) => ((errEl.textContent = m), (errEl.hidden = false));
    ed.querySelector("#ccm-cancel").addEventListener("click", () => ed.remove());
    const done = async () => {
      ed.remove();
      await load();
      onChanged?.();
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(form);
      try {
        if (cat) {
          await api.updateCashCategory(cat.id, {
            ...(system ? {} : { name: String(d.get("name")).trim() }),
            note: String(d.get("note") || "").trim() || null,
            ...(isGroup ? { direction: d.get("direction"), section: d.get("section") } : { parent_id: Number(d.get("parent_id")) }),
          });
        } else {
          await api.addCashCategory({
            name: String(d.get("name")).trim(),
            note: String(d.get("note") || "").trim() || null,
            ...(isGroup ? { is_group: true, direction: d.get("direction"), section: d.get("section") } : { parent_id: Number(d.get("parent_id")) }),
          });
        }
        await done();
        showToast(t("saved"));
      } catch (err) {
        fail(err.message);
      }
    });
    // remove: the first tap shows where the rows go (when there are any), the second removes
    ed.querySelector("#ccm-del")?.addEventListener("click", async () => {
      const box = ed.querySelector("#ccm-remove");
      const needsTarget = (cat.n || 0) > 0 || cats.some((c) => String(c.parent_id) === String(cat.id));
      if (needsTarget && box.hidden) {
        box.hidden = false;
        return;
      }
      const moveTo = form.elements.move_to.value;
      if (needsTarget && !moveTo) return fail(t("ccm_pick_needed"));
      try {
        await api.deleteCashCategory(cat.id, moveTo ? Number(moveTo) : null);
        await done();
        showToast(t("ccm_removed"));
      } catch (err) {
        fail(err.message);
      }
    });
  }

  try {
    await load();
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}
