// Settings > Sales > "Potential product lines" (owner, 2026-11-17): the catalogue of the volume potential (server
// customers/volumePotential.js). Management renames a line, changes its Castrol hint, its order, switches it off, or adds one. A line's key
// never changes, so what customers already have stays theirs.
import { api } from "../api.js";
import { getLang, t } from "../i18n.js";
import { escapeHtml, showToast } from "../util.js";

export async function renderPotentialLinesSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`;
  let lines;
  try {
    ({ lines } = await api.getPotentialLines(true));
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  // each line folds to one row (name, Castrol hint, unit; "off" when switched off) and opens to edit; the new-line form is open
  const row = (l) => (l ? `
    <details class="card pla-item${l.active === false ? " pla-off" : ""}">
      <summary class="pla-sum"><span class="pla-sum-name">${escapeHtml(getLang() === "hy" ? l.name_hy : l.name_en)}</span><span class="muted pla-sum-meta">${escapeHtml([l.castrol_hint, t(l.unit === "kg" ? "vp_kg" : "vp_l"), l.active === false ? t("pla_off") : ""].filter(Boolean).join(" · "))}</span></summary>
      ${form(l)}
    </details>` : `<div class="card pla-item">${form(null)}</div>`);
  const form = (l) => `
    <form class="pla-row" data-id="${l?.id ?? ""}">
      <div class="pla-grid">
        <label>${escapeHtml(t("pla_name_hy"))}<input name="name_hy" maxlength="80" required value="${escapeHtml(l?.name_hy ?? "")}" /></label>
        <label>${escapeHtml(t("pla_name_en"))}<input name="name_en" maxlength="80" required value="${escapeHtml(l?.name_en ?? "")}" /></label>
        <label>${escapeHtml(t("pla_hint"))}<input name="castrol_hint" maxlength="80" value="${escapeHtml(l?.castrol_hint ?? "")}" /></label>
        <label>${escapeHtml(t("pla_unit"))}<select name="unit"><option value="L"${l?.unit === "kg" ? "" : " selected"}>${escapeHtml(t("vp_l"))}</option><option value="kg"${l?.unit === "kg" ? " selected" : ""}>${escapeHtml(t("vp_kg"))}</option></select></label>
        <label>${escapeHtml(t("pla_order"))}<input name="sort_order" type="number" inputmode="numeric" step="1" value="${l?.sort_order ?? 999}" /></label>
        ${l ? "" : `<label>${escapeHtml(t("pla_group"))}<select name="group_key">${["pcmo", "hdeo", "transmission", "ev", "coolant", "brake", "grease", "other"].map((g) => `<option value="${g}">${escapeHtml(t(`vp_group_${g}`))}</option>`).join("")}</select></label>`}
      </div>
      <div class="pla-actions">
        <label class="pla-active"><input type="checkbox" name="active"${l?.active === false ? "" : " checked"} /> ${escapeHtml(t("pla_active"))}</label>
        <button type="submit" class="btn btn-primary">${escapeHtml(t(l ? "save" : "pla_add"))}</button>
      </div>
    </form>`;
  container.innerHTML = `<p class="muted pla-intro">${escapeHtml(t("pla_intro"))}</p>
    <div class="pla-list">${lines.map(row).join("")}</div>
    <h3 class="settings-subsection-title">${escapeHtml(t("pla_new"))}</h3>
    ${row(null)}`;
  if (container.dataset.plaWired) return;
  container.dataset.plaWired = "1"; // drawn again after a save: one listener
  container.addEventListener("submit", async (e) => {
    const formEl = e.target.closest(".pla-row");
    if (!formEl) return;
    e.preventDefault();
    const f = new FormData(formEl);
    const body = {
      name_hy: f.get("name_hy"),
      name_en: f.get("name_en"),
      castrol_hint: f.get("castrol_hint"),
      unit: f.get("unit"),
      sort_order: Number(f.get("sort_order")) || 0,
      active: f.get("active") === "on",
      ...(formEl.dataset.id ? {} : { group_key: f.get("group_key") }),
    };
    const btn = formEl.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.savePotentialLine(formEl.dataset.id ? Number(formEl.dataset.id) : null, body);
      showToast(t("saved"));
      renderPotentialLinesSection(container);
    } catch (err) {
      showToast(err.message);
    }
    btn.disabled = false;
  });
}
