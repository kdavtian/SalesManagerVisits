// Settings > Sales > "Potential product lines" (owner, 2026-11-17): the catalogue of the volume potential (server
// customers/volumePotential.js). Management renames a line, changes its Castrol hint, its order, switches it off, or adds one. A line's key
// never changes, so what customers already have stays theirs.
import { api } from "../api.js";
import { getLang, t } from "../i18n.js";
import { escapeHtml, showToast } from "../util.js";
import { clearVolumeCatalogue } from "../volumePotential.js";

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
    ${row(null)}
    <h3 class="settings-subsection-title" id="pla-skus-title">${escapeHtml(t("pla_skus_title"))}</h3>
    <div id="pla-skus"></div>`;
  renderSkus(container.querySelector("#pla-skus"), lines, false);
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
      clearVolumeCatalogue();
      showToast(t("saved"));
      renderPotentialLinesSection(container);
    } catch (err) {
      showToast(err.message);
    }
    btn.disabled = false;
  });
}

// Products sold in the last 12 months that the rules could not place on a line (phase 2): management picks the line, "not a potential line",
// or the litres of one unit. "Show all" lists the placed ones too, to correct one.
const REASONS = ["car_or_truck_unclear", "transmission_unclear", "transmission_several", "no_catalogue_line", "no_size", "ev_unclear", "family_other", "no_rule"];
async function renderSkus(box, lines, all) {
  box.innerHTML = `<p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`;
  let data;
  try {
    data = await api.getPotentialSkus(all);
  } catch (err) {
    box.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const name = (l) => (getLang() === "hy" ? l.name_hy : l.name_en);
  const c = data.counts;
  const options = (s) =>
    `<option value="">${escapeHtml(t("pla_sku_pick"))}</option><option value="none"${s.status === "not_a_line" ? " selected" : ""}>${escapeHtml(t("pla_sku_none"))}</option>` +
    lines.map((l) => `<option value="${l.id}"${s.line_id === l.id && s.status !== "not_a_line" ? " selected" : ""}>${escapeHtml(name(l))}</option>`).join("");
  box.innerHTML = `
    <p class="muted pla-intro">${escapeHtml(t("pla_skus_intro").replace("{n}", c.unmapped).replace("{auto}", c.auto + c.manual))}</p>
    <label class="pla-active"><input type="checkbox" id="pla-skus-all"${all ? " checked" : ""} /> ${escapeHtml(t("pla_skus_all"))}</label>
    ${data.skus.length > 1 ? `<div class="card pla-bulk" id="pla-bulk">
      <label class="pla-active"><input type="checkbox" id="pla-pick-all" /> ${escapeHtml(t("pla_bulk_all"))}</label>
      <div class="pla-bulk-row"><select id="pla-bulk-line" aria-label="${escapeHtml(t("pla_sku_line"))}">${options({})}</select>
      <button type="button" class="btn btn-primary" id="pla-bulk-go" disabled>${escapeHtml(t("pla_bulk_place").replace("{n}", "0"))}</button></div>
    </div>` : ""}
    ${data.skus.length ? "" : `<p class="muted">${escapeHtml(t("pla_skus_none_left"))}</p>`}
    ${data.skus
      .map(
        (s) => `<form class="card pla-item pla-sku" data-key="${escapeHtml(s.sku_key)}">
      <label class="pla-pick"><input type="checkbox" class="pla-pick-one" aria-label="${escapeHtml(t("pla_bulk_pick"))}" /><span class="pla-sum-name">${escapeHtml([s.brand, s.name].filter(Boolean).join(" "))}</span></label>
      <div class="muted pla-sum-meta">${escapeHtml([s.family, s.size ? `${s.size} ${t("vp_l")}` : t("pla_sku_no_size"), `${Math.round(s.qty_12m)} ${t("pla_sku_units")}`, s.status === "unmapped" && REASONS.includes(s.reason) ? t(`pla_why_${s.reason}`) : t(`pla_st_${s.status}`)].filter(Boolean).join(" · "))}</div>
      <div class="pla-grid">
        <label>${escapeHtml(t("pla_sku_line"))}<select name="line">${options(s)}</select></label>
        <label>${escapeHtml(t("pla_sku_litres"))}<input name="litres" type="number" inputmode="decimal" step="0.001" min="0" value="${s.manual_litres ?? ""}" placeholder="${s.size ?? ""}" /></label>
      </div>
      <div class="pla-actions"><span></span><button type="submit" class="btn btn-primary">${escapeHtml(t("save"))}</button></div>
    </form>`
      )
      .join("")}`;
  box.querySelector("#pla-skus-all").addEventListener("change", (e) => renderSkus(box, lines, e.target.checked));
  // bulk (owner, 2026-11-18): tick several, pick one line or "not a potential line", place them all; litres set by hand stay
  const picks = () => [...box.querySelectorAll(".pla-pick-one:checked")].map((c) => c.closest(".pla-sku").dataset.key);
  const go = box.querySelector("#pla-bulk-go");
  const sync = () => {
    if (!go) return;
    const n = picks().length;
    go.textContent = t("pla_bulk_place").replace("{n}", n);
    go.disabled = !n || !box.querySelector("#pla-bulk-line").value;
  };
  // a property, not addEventListener: the box is drawn again after every save, and one handler must stay
  box.onchange = (e) => {
    if (e.target.id === "pla-pick-all") box.querySelectorAll(".pla-pick-one").forEach((c) => (c.checked = e.target.checked));
    if (e.target.matches(".pla-pick-one, #pla-pick-all, #pla-bulk-line")) sync();
  };
  go?.addEventListener("click", async () => {
    const line = box.querySelector("#pla-bulk-line").value;
    const keys = picks();
    if (!keys.length || !line) return;
    go.disabled = true;
    try {
      const r = await api.savePotentialSkusBulk({ keys, ...(line === "none" ? { not_a_line: true } : { line_id: Number(line) }) });
      showToast(t("pla_bulk_done").replace("{n}", r.saved));
      renderSkus(box, lines, all);
    } catch (err) {
      showToast(err.message);
      sync();
    }
  });
  box.querySelectorAll(".pla-sku").forEach((form) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = form.elements.line.value;
      const litres = form.elements.litres.value;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api.savePotentialSku(form.dataset.key, { line_id: line && line !== "none" ? Number(line) : null, not_a_line: line === "none", litres_per_unit: litres === "" ? null : Number(litres) });
        showToast(t("saved"));
        renderSkus(box, lines, all);
      } catch (err) {
        showToast(err.message);
        btn.disabled = false;
      }
    })
  );
}
