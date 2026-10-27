// Settings > Sales & customers (owner, 2026-10-27):
//  - "Signature & document texts": what the customer reads before signing (orders received / payment / both) and the warning
//    printed on every blank; [order no], [payment amount], [updated debt balance] are filled in by the app.
//  - "Visit frequency by customer type": a default per channel, potential level, competitor and tier. A customer follows the most
//    frequent of the defaults that apply to it, unless its own frequency was set on its card.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, showToast } from "../util.js";

const TEXT_KEYS = ["sign_order", "sign_payment", "sign_order_payment", "pdf_warning"];

function flashSaved(el) {
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 1500);
}

export async function renderDocumentTextsSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let s;
  try {
    s = await api.getSettings();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  container.innerHTML = `
    <p class="muted settings-hint">${t("doc_texts_hint")}</p>
    <form class="card settings-list-group doc-texts-form" id="doc-texts-form">
      ${TEXT_KEYS.map(
        (k) => `<label class="settings-list-group-item doc-text-field">
          <span class="settings-row-label">${t(`doc_text_${k}`)}</span>
          <textarea name="${k}" rows="${k === "pdf_warning" ? 4 : 3}" maxlength="600">${escapeHtml(s.document_texts?.[k] ?? "")}</textarea>
          <button type="button" class="btn-link doc-text-reset" data-reset="${k}">${t("doc_text_reset")}</button>
        </label>`
      ).join("")}
      <div class="settings-list-group-item">
        <p class="form-success" id="doc-texts-saved" role="status" hidden>${t("saved")}</p>
        <button type="submit" class="btn btn-primary btn-block">${t("save")}</button>
      </div>
    </form>`;
  const form = container.querySelector("#doc-texts-form");
  // Each box is as tall as its text: the whole sentence is readable on a phone without scrolling inside it.
  const fit = (ta) => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  form.querySelectorAll("textarea").forEach((ta) => {
    ta.addEventListener("input", () => fit(ta));
    requestAnimationFrame(() => fit(ta));
  });
  form.querySelectorAll("[data-reset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const ta = form.elements[btn.dataset.reset];
      ta.value = s.document_text_defaults?.[btn.dataset.reset] ?? "";
      fit(ta);
    })
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const patch = Object.fromEntries(TEXT_KEYS.map((k) => [k, form.elements[k].value]));
      const res = await api.updateSettings({ document_texts: patch });
      TEXT_KEYS.forEach((k) => (form.elements[k].value = res.document_texts?.[k] ?? form.elements[k].value));
      flashSaved(container.querySelector("#doc-texts-saved"));
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

// Grouped as the owner listed them: channels, potential levels, competitors, tiers.
const TYPE_GROUPS = [
  ["visit_type_group_channels", [["cvo", "CVO"], ["pco", "PCO"], ["oem", "OEM"], ["sm", "SM"], ["cas", "CAS"], ["kf", "KF"]]],
  ["visit_type_group_potential", [["potential_1", "pl_level_1"], ["potential_2", "pl_level_2"], ["potential_3", "pl_level_3"], ["potential_4", "pl_level_4"], ["competitor", "tier_competitor"]]],
  ["visit_type_group_tiers", [["bronze", "tier_bronze"], ["silver", "tier_silver"], ["gold", "tier_gold"]]],
];

export async function renderVisitFrequencyTypesSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let s;
  try {
    s = await api.getSettings();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  const values = s.visit_frequency_by_type ?? {};
  const general = s.default_visit_frequency_days;
  const label = (code) => (/^[A-Z]+$/.test(code) ? code : t(code));
  container.innerHTML = `
    <p class="muted settings-hint">${t("visit_types_hint").replace("{n}", general)}</p>
    <form id="visit-types-form">
      ${TYPE_GROUPS.map(
        ([groupKey, rows]) => `
        <h3 class="settings-subsection-title">${t(groupKey)}</h3>
        <div class="card settings-list-group">
          ${rows
            .map(
              ([key, code]) => `<label class="settings-list-group-item arrival-field visit-type-row">
                <span class="settings-row-label">${escapeHtml(label(code))}</span>
                <span class="arrival-input"><input type="number" inputmode="numeric" name="${key}" min="1" max="365" step="1" value="${values[key] ?? ""}" placeholder="–" aria-label="${escapeHtml(label(code))}" /><span class="muted">${t("visit_types_unit")}</span></span>
              </label>`
            )
            .join("")}
        </div>`
      ).join("")}
      <p class="form-success" id="visit-types-saved" role="status" hidden>${t("saved")}</p>
      <div class="visit-types-save"><button type="submit" class="btn btn-primary btn-block">${t("save")}</button></div>
    </form>`;
  const form = container.querySelector("#visit-types-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = {};
    for (const [, rows] of TYPE_GROUPS) for (const [key] of rows) patch[key] = form.elements[key].value === "" ? null : Number(form.elements[key].value);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.updateSettings({ visit_frequency_by_type: patch });
      flashSaved(container.querySelector("#visit-types-saved"));
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}
