// Product detail card: photos (front / back / other, one main), prices (by
// role), internal costs (management only), description, approvals and
// specifications. Product managers can add/change photos and edit the
// details; everyone else just reads.
import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog } from "../util.js";
import { t } from "../i18n.js";
import { state, canManageProducts, seesProductCosts } from "../state.js";
import { icons } from "../icons.js";

const KIND_LABEL = { front: "photo_front", back: "photo_back", other: "photo_other" };

function priceRow(label, value, { strong = false } = {}) {
  if (value == null || value === "" || Number(value) <= 0) return "";
  return `<div class="pd-row"><span class="muted">${label}</span><span class="pd-amount ${strong ? "pd-amount-strong" : ""}">${formatAmd(Number(value))}</span></div>`;
}

export async function renderProductDetail(root, navigate, productId) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let product;
  try {
    product = await api.getProduct(productId);
  } catch (err) {
    container.innerHTML = `
      <div class="detail-header"><button class="icon-btn" id="back-btn" aria-label="${t("back")}">${icons.chevronUp}</button></div>
      <p class="form-error">${escapeHtml(err.status === 404 ? t("product_not_found") : err.message)}</p>`;
    container.querySelector("#back-btn").addEventListener("click", () => navigate("#/pricelist"));
    return;
  }

  const manage = canManageProducts();
  const costs = seesProductCosts();
  let activeImageId = product.images[0]?.id ?? null;

  function render() {
    const p = product;
    const images = p.images;
    const active = images.find((i) => i.id === activeImageId) ?? images[0] ?? null;
    activeImageId = active?.id ?? null;
    const specs = Array.isArray(p.specs) ? p.specs : [];
    const approvals = Array.isArray(p.approvals) ? p.approvals : [];
    const hasSpecial = p.effective_special_amd != null;
    const margin =
      costs && Number(p.net_cost_amd) > 0 && Number(p.silver_price_amd) > 0
        ? Math.round(((Number(p.silver_price_amd) - Number(p.net_cost_amd)) / Number(p.silver_price_amd)) * 1000) / 10
        : null;

    container.innerHTML = `
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("product_details_title")}</h1></div>
        ${manage ? `<div class="detail-header-actions"><button type="button" class="icon-btn" id="edit-details-btn" aria-label="${t("edit_details")}" title="${t("edit_details")}">${icons.pencil}</button></div>` : ""}
      </div>

      <div class="pd-gallery">
        <button type="button" class="pd-main-image ${active ? "" : "pd-main-image-empty"}" id="pd-main-image" ${active ? "" : "disabled"} aria-label="${t("product_photos")}">
          ${active ? `<img src="${active.url}" alt="${escapeHtml(p.name)}" />` : `<span class="pd-no-photo">${icons.box}</span>`}
        </button>
        ${
          images.length > 1 || manage
            ? `<div class="pd-thumbs">
                ${images
                  .map(
                    (i) => `<button type="button" class="pd-thumb ${i.id === activeImageId ? "pd-thumb-active" : ""}" data-image-id="${i.id}" aria-label="${t(KIND_LABEL[i.kind])}">
                      <img src="${i.url}" alt="" loading="lazy" />
                      ${i.is_main ? `<span class="pd-thumb-badge">${t("photo_main")}</span>` : ""}
                    </button>`
                  )
                  .join("")}
                ${manage ? `<button type="button" class="pd-thumb pd-thumb-add" id="pd-add-photo" aria-label="${t("add_photo")}">${icons.plus}</button>` : ""}
              </div>`
            : ""
        }
        ${
          manage && active
            ? `<div class="pd-photo-actions">
                <span class="badge badge-neutral">${t(KIND_LABEL[active.kind])}</span>
                ${active.is_main ? "" : `<button type="button" class="btn btn-sm" id="pd-make-main">${t("set_main_photo")}</button>`}
                <button type="button" class="btn btn-sm btn-danger" id="pd-delete-photo">${t("delete_photo")}</button>
              </div>`
            : ""
        }
      </div>

      <div class="pd-title-block">
        <h2>${escapeHtml(p.name)}</h2>
        <p class="muted">${[p.brand, p.family, p.unit, p.sku].filter(Boolean).map(escapeHtml).join(" · ")}</p>
        ${p.is_commercial ? `<span class="badge badge-info">${t("commercial_oil")}</span>` : ""}
        ${p.active ? "" : `<span class="badge badge-neutral">${t("inactive")}</span>`}
      </div>

      <div class="card pd-card">
        <h3 class="pd-card-title">${t("product_prices")}</h3>
        ${hasSpecial ? `<div class="pd-row"><span class="muted">${t("price_special_period")}</span><span class="pd-amount pd-amount-strong">${formatAmd(p.effective_special_amd)}</span></div>
          <p class="muted pd-note">${t("valid_through")} ${escapeHtml(p.special_valid_to)}</p>` : ""}
        ${priceRow(t("col_bronze"), p.bronze_price_amd ?? p.unit_price_amd)}
        ${priceRow(t("col_silver"), p.silver_price_amd, { strong: true })}
        ${costs ? priceRow(t("col_gold"), p.gold_price_amd) : ""}
        ${priceRow(t("price_retail"), p.effective_retail_amd)}
      </div>

      ${
        costs
          ? `<div class="card pd-card">
              <h3 class="pd-card-title">${t("product_costs")}</h3>
              ${priceRow(t("landing_cost"), p.landing_cost_amd)}
              ${priceRow(t("net_cost"), p.net_cost_amd)}
              ${margin != null ? `<div class="pd-row"><span class="muted">${t("col_silver")} / ${t("net_cost")}</span><span class="pd-amount">${margin}%</span></div>` : ""}
            </div>`
          : ""
      }

      ${
        p.description || approvals.length || specs.length
          ? `<div class="card pd-card">
              ${p.description ? `<h3 class="pd-card-title">${t("product_description")}</h3><p class="pd-text">${escapeHtml(p.description)}</p>` : ""}
              ${
                approvals.length
                  ? `<h3 class="pd-card-title">${t("product_approvals")}</h3><div class="pd-chips">${approvals.map((a) => `<span class="badge badge-neutral product-chip">${escapeHtml(a)}</span>`).join("")}</div>`
                  : ""
              }
              ${
                specs.length
                  ? `<h3 class="pd-card-title">${t("product_specs")}</h3>
                     <div class="pd-specs">${specs.map((s) => `<div class="pd-row"><span class="muted">${escapeHtml(s.label)}</span><span class="pd-spec-value">${escapeHtml(s.value)}</span></div>`).join("")}</div>`
                  : ""
              }
            </div>`
          : manage
            ? `<p class="muted pd-empty">${t("no_details_yet")}</p>`
            : ""
      }
    `;

    container.querySelector("#back-btn").addEventListener("click", () => history.length > 1 ? history.back() : navigate("#/pricelist"));
    container.querySelectorAll("[data-image-id]").forEach((btn) =>
      btn.addEventListener("click", () => {
        activeImageId = Number(btn.dataset.imageId);
        render();
      })
    );
    container.querySelector("#pd-main-image")?.addEventListener("click", () => active && openLightbox(active.url));
    if (manage) {
      container.querySelector("#edit-details-btn")?.addEventListener("click", openEditSheet);
      container.querySelector("#pd-add-photo")?.addEventListener("click", openPhotoSheet);
      container.querySelector("#pd-make-main")?.addEventListener("click", async () => {
        const res = await api.updateProductPhoto(p.id, active.id, { is_main: true });
        product.images = res.images;
        render();
      });
      container.querySelector("#pd-delete-photo")?.addEventListener("click", async () => {
        const res = await api.deleteProductPhoto(p.id, active.id);
        product.images = res.images;
        activeImageId = res.images[0]?.id ?? null;
        render();
      });
    }
  }

  function openLightbox(url) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay pd-lightbox";
    overlay.innerHTML = `<button type="button" class="icon-btn sheet-close-x pd-lightbox-close" aria-label="${t("close")}">${icons.close}</button><img src="${url}" alt="" />`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", () => overlay.remove());
  }

  function openPhotoSheet() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("add_photo")}</h2>
        <form id="photo-form">
          <fieldset>
            <label class="radio-row"><input type="radio" name="kind" value="front" checked /> ${t("photo_front")}</label>
            <label class="radio-row"><input type="radio" name="kind" value="back" /> ${t("photo_back")}</label>
            <label class="radio-row"><input type="radio" name="kind" value="other" /> ${t("photo_other")}</label>
          </fieldset>
          <input type="file" id="photo-file" accept="image/jpeg,image/png,image/webp" required />
          <p class="form-error" id="photo-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="photo-cancel">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("save")}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.querySelector("#photo-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#photo-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = overlay.querySelector("#photo-file").files[0];
      if (!file) return;
      const form = new FormData();
      form.append("kind", overlay.querySelector('input[name="kind"]:checked').value);
      form.append("image", file);
      const errorEl = overlay.querySelector("#photo-error");
      try {
        const res = await api.uploadProductPhoto(product.id, form);
        product.images = res.images;
        activeImageId = res.id;
        overlay.remove();
        render();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  function openEditSheet() {
    let approvals = [...(product.approvals ?? [])];
    let specs = (product.specs ?? []).map((s) => ({ ...s }));
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet pd-edit-sheet">
        <div class="pd-edit-scroll">
          <h2>${t("edit_details")}</h2>
          <label class="field-label" for="pd-desc">${t("product_description")}</label>
          <textarea id="pd-desc" rows="4" maxlength="4000">${escapeHtml(product.description ?? "")}</textarea>
          <label class="radio-row"><input type="checkbox" id="pd-commercial" ${product.is_commercial ? "checked" : ""} /> ${t("commercial_oil")}</label>

          <h3 class="pd-card-title">${t("product_approvals")}</h3>
          <div class="pd-chips" id="pd-approvals"></div>
          <div class="pd-inline-add">
            <input type="text" id="pd-approval-input" maxlength="120" placeholder="${t("add_approval")}" />
            <button type="button" class="btn btn-sm" id="pd-approval-add">${t("add")}</button>
          </div>

          <h3 class="pd-card-title">${t("product_specs")}</h3>
          <div id="pd-specs"></div>
          <button type="button" class="btn btn-sm" id="pd-spec-add">${t("add_spec")}</button>
          <p class="form-error" id="pd-error" hidden></p>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pd-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="pd-save">${t("save")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#pd-cancel").addEventListener("click", () => overlay.remove());

    const approvalsEl = overlay.querySelector("#pd-approvals");
    const specsEl = overlay.querySelector("#pd-specs");
    const paintApprovals = () => {
      approvalsEl.innerHTML = approvals
        .map((a, i) => `<span class="badge badge-neutral product-chip">${escapeHtml(a)} <button type="button" class="pd-chip-x" data-remove-approval="${i}" aria-label="${t("delete")}">×</button></span>`)
        .join("");
    };
    const paintSpecs = () => {
      specsEl.innerHTML = specs
        .map(
          (s, i) => `<div class="pd-spec-edit" data-spec="${i}">
            <input type="text" data-field="label" maxlength="60" placeholder="${t("spec_label")}" value="${escapeHtml(s.label)}" />
            <input type="text" data-field="value" maxlength="160" placeholder="${t("spec_value")}" value="${escapeHtml(s.value)}" />
            <button type="button" class="icon-btn icon-btn-danger" data-remove-spec="${i}" aria-label="${t("delete")}">${icons.trash}</button>
          </div>`
        )
        .join("");
    };
    paintApprovals();
    paintSpecs();

    approvalsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-approval]");
      if (!btn) return;
      approvals.splice(Number(btn.dataset.removeApproval), 1);
      paintApprovals();
    });
    const addApproval = () => {
      const input = overlay.querySelector("#pd-approval-input");
      const v = input.value.trim();
      if (v && !approvals.includes(v)) approvals.push(v);
      input.value = "";
      paintApprovals();
    };
    overlay.querySelector("#pd-approval-add").addEventListener("click", addApproval);
    overlay.querySelector("#pd-approval-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addApproval();
      }
    });
    specsEl.addEventListener("input", (e) => {
      const row = e.target.closest("[data-spec]");
      if (row && e.target.dataset.field) specs[Number(row.dataset.spec)][e.target.dataset.field] = e.target.value;
    });
    specsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-spec]");
      if (!btn) return;
      specs.splice(Number(btn.dataset.removeSpec), 1);
      paintSpecs();
    });
    overlay.querySelector("#pd-spec-add").addEventListener("click", () => {
      specs.push({ label: "", value: "" });
      paintSpecs();
      specsEl.querySelector(`[data-spec="${specs.length - 1}"] input`)?.focus();
    });

    overlay.querySelector("#pd-save").addEventListener("click", async () => {
      const errorEl = overlay.querySelector("#pd-error");
      try {
        const updated = await api.updateProduct(product.id, {
          description: overlay.querySelector("#pd-desc").value.trim() || null,
          is_commercial: overlay.querySelector("#pd-commercial").checked,
          approvals,
          specs: specs.filter((s) => s.label.trim()),
        });
        Object.assign(product, {
          description: updated.description,
          is_commercial: updated.is_commercial,
          approvals: updated.approvals,
          specs: updated.specs,
        });
        overlay.remove();
        render();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    });
  }

  render();
  void state;
}
