// "Company Methodology" (owner, 2026-11-03): how the company's numbers are worked out, in words anyone can read. Shown as a sheet from the
// Products page and as a section of the Documents page; more methods (policies) are added to METHODS later. The days-of-stock text
// describes server/src/products/demandModel.js -- change them together.
import { t } from "./i18n.js";
import { escapeHtml, activateDialog } from "./util.js";
import { icons } from "./icons.js";

// key -> { title key, intro key, step keys, closing keys }
export const METHODS = {
  stock_days: {
    title: "meth_stock_title",
    intro: "meth_stock_intro",
    steps: ["meth_stock_1", "meth_stock_2", "meth_stock_3", "meth_stock_4", "meth_stock_5", "meth_stock_6", "meth_stock_7"],
    notes: ["meth_stock_status", "meth_stock_source"],
  },
};

export function methodologyListHtml() {
  return Object.entries(METHODS)
    .map(([key, m]) => `<button type="button" class="card list-row methodology-row" data-method="${key}"><span class="list-row-body"><strong>${escapeHtml(t(m.title))}</strong><span class="muted list-row-meta">${escapeHtml(t(m.intro))}</span></span><span class="chevron">&#8250;</span></button>`)
    .join("");
}

export function wireMethodologyList(host) {
  host.querySelectorAll("[data-method]").forEach((b) => b.addEventListener("click", () => openMethodologySheet(b.dataset.method)));
}

export function openMethodologySheet(key = "stock_days") {
  const m = METHODS[key];
  if (!m) return;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet methodology-sheet">
    <button type="button" class="icon-btn sheet-close-x" data-action="close-sheet" aria-label="${t("close")}">${icons.close}</button>
    <p class="muted methodology-kicker">${escapeHtml(t("methodology_title"))}</p>
    <h2>${escapeHtml(t(m.title))}</h2>
    <p>${escapeHtml(t(m.intro))}</p>
    <ol class="methodology-steps">${m.steps.map((s) => `<li>${escapeHtml(t(s))}</li>`).join("")}</ol>
    ${m.notes.map((n) => `<p class="muted methodology-note">${escapeHtml(t(n))}</p>`).join("")}
    <div class="sheet-actions"><button type="button" class="btn" data-action="close-sheet">${t("done")}</button></div>
  </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelectorAll('[data-action="close-sheet"]').forEach((b) => b.addEventListener("click", () => overlay.remove()));
}
