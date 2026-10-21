// Settings -> "KAD OS orders" (admin/CEO) and "Campaigns" (admin/CEO/sales director): the supplier side of the KAD OS link.
// KAD OS is the free ERP our wholesale customers run; they order from us inside it. Here the owner sets the perks an app order gets
// (discount, queue priority, delivery promise, progress levels), links each customer's KAD account, and runs campaigns / bundles.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY, showToast } from "../util.js";
import { getProductCatalog } from "../productCatalog.js";
import { searchProducts } from "../productSearch.js";

const debounce = (fn, ms = 250) => {
  let h;
  return (...a) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
};

const hintIcon = (id) =>
  `<span role="button" tabindex="0" class="settings-inline-hint-icon" id="${id}" aria-expanded="false" aria-label="${t("more_info")}">!</span>`;

// "!" next to a heading shows / hides the explanation under it (secondary text lives behind the "!", owner's rule).
function wireHint(root, btnId, textId) {
  const btn = root.querySelector(`#${btnId}`);
  const text = root.querySelector(`#${textId}`);
  if (!btn || !text) return;
  const toggle = (e) => {
    e.stopPropagation();
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    text.hidden = open;
  };
  btn.addEventListener("click", toggle);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(e);
    }
  });
}

const toggleHtml = (id, on, label) =>
  `<button type="button" class="toggle-switch" id="${id}" role="switch" aria-checked="${on}" aria-label="${escapeHtml(label)}"><span class="toggle-thumb"></span></button>`;

function numberField(key, value, { min, max, step = 1, unit, before = "" }) {
  return `<label class="kos-num">${before ? `<span class="muted">${escapeHtml(before)}</span>` : ""}<input type="number" inputmode="decimal" data-key="${key}" value="${value}" min="${min}" max="${max}" step="${step}" /><span class="muted">${escapeHtml(unit)}</span></label>`;
}

// ---- perks + accounts --------------------------------------------------------------------------------------------------
export async function renderKadOsPerksSection(container) {
  container.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
  let data;
  try {
    data = await api.getKadOsSettings();
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  let { settings: s, links } = data;

  const save = async (patch, okEl) => {
    try {
      const res = await api.saveKadOsSettings(patch);
      s = res.settings;
      if (okEl) {
        okEl.hidden = false;
        setTimeout(() => (okEl.hidden = true), 1500);
      }
      return true;
    } catch (err) {
      showToast(err.message);
      return false;
    }
  };

  function paint() {
    container.innerHTML = `
      <h3 class="settings-subsection-title">${t("kos_perks_title")} ${hintIcon("kos-perks-hint-btn")}</h3>
      <p class="muted settings-hint" id="kos-perks-hint-text" hidden>${t("kos_perks_hint")}</p>
      <div class="card settings-list-group" id="kos-perks">
        <div class="settings-list-group-item kos-row">
          <div class="kos-row-top"><span class="settings-row-label">${t("kos_discount_label")} ${hintIcon("kos-d-hint")}</span>${toggleHtml("kos-discount-on", s.discount_enabled, t("kos_discount_label"))}</div>
          <p class="muted settings-hint" id="kos-d-text" hidden>${t("kos_discount_help")}</p>
          <div class="kos-row-fields" ${s.discount_enabled ? "" : "hidden"}>${numberField("discount_pct", s.discount_pct, { min: 0, max: 10, step: 0.5, unit: t("kos_discount_unit") })}</div>
        </div>
        <div class="settings-list-group-item kos-row">
          <div class="kos-row-top"><span class="settings-row-label">${t("kos_priority_label")} ${hintIcon("kos-p-hint")}</span>${toggleHtml("kos-priority-on", s.priority_enabled, t("kos_priority_label"))}</div>
          <p class="muted settings-hint" id="kos-p-text" hidden>${t("kos_priority_help")}</p>
        </div>
        <div class="settings-list-group-item kos-row">
          <div class="kos-row-top"><span class="settings-row-label">${t("kos_chase_label")} ${hintIcon("kos-c2-hint")}</span>${toggleHtml("kos-chase-on", s.chase_enabled, t("kos_chase_label"))}</div>
          <p class="muted settings-hint" id="kos-c2-text" hidden>${t("kos_chase_help")}</p>
          <div class="kos-row-fields" ${s.chase_enabled ? "" : "hidden"}>${numberField("chase_confirm_hours", s.chase_confirm_hours, { min: 1, max: 48, unit: t("kos_chase_unit") })}</div>
        </div>
        <div class="settings-list-group-item kos-row">
          <div class="kos-row-top"><span class="settings-row-label">${t("kos_promise_label")} ${hintIcon("kos-t-hint")}</span>${toggleHtml("kos-promise-on", s.promise_enabled, t("kos_promise_label"))}</div>
          <p class="muted settings-hint" id="kos-t-text" hidden>${t("kos_promise_help")}</p>
          <div class="kos-row-fields" ${s.promise_enabled ? "" : "hidden"}>
            ${numberField("promise_working_days", s.promise_working_days, { min: 0, max: 10, unit: t("kos_promise_days") })}
            ${numberField("promise_cutoff_hour", s.promise_cutoff_hour, { min: 0, max: 23, unit: ":00", before: t("kos_promise_cutoff") })}
          </div>
        </div>
        <div class="settings-list-group-item kos-row">
          <div class="kos-row-top"><span class="settings-row-label">${t("kos_progress_label")}</span>${toggleHtml("kos-progress-on", s.progress_enabled, t("kos_progress_label"))}</div>
          <div class="kos-row-fields" ${s.progress_enabled ? "" : "hidden"}>
            <span class="muted">${t("kos_levels_label")}</span>
            <span class="kos-levels">${s.levels.map((n, i) => `<input type="number" inputmode="numeric" data-level="${i}" value="${n}" min="1" max="100" aria-label="${i + 1}" />`).join("")}</span>
          </div>
        </div>
        <p class="form-success kos-saved" id="kos-saved" role="status" hidden>${t("saved")}</p>
      </div>

      <h3 class="settings-subsection-title">${t("kos_accounts_title")} ${hintIcon("kos-a-hint")}</h3>
      <p class="muted settings-hint" id="kos-a-text" hidden>${t("kos_accounts_hint")}</p>
      <div class="card-list" id="kos-links">${linksHtml()}</div>
      <div class="team-add-btn-wrap"><button type="button" class="btn btn-block" id="kos-link-add">${t("kos_link_add")}</button></div>
    `;
    wireHint(container, "kos-perks-hint-btn", "kos-perks-hint-text");
    wireHint(container, "kos-d-hint", "kos-d-text");
    wireHint(container, "kos-p-hint", "kos-p-text");
    wireHint(container, "kos-t-hint", "kos-t-text");
    wireHint(container, "kos-c2-hint", "kos-c2-text");
    wireHint(container, "kos-a-hint", "kos-a-text");
    const saved = container.querySelector("#kos-saved");

    for (const [id, key] of [["kos-discount-on", "discount_enabled"], ["kos-priority-on", "priority_enabled"], ["kos-promise-on", "promise_enabled"], ["kos-progress-on", "progress_enabled"], ["kos-chase-on", "chase_enabled"]]) {
      container.querySelector(`#${id}`).addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const next = btn.getAttribute("aria-checked") !== "true";
        if (await save({ [key]: next }, saved)) paint();
        else btn.disabled = false;
      });
    }
    container.querySelectorAll("input[data-key]").forEach((input) => {
      input.addEventListener("change", async () => {
        const ok = await save({ [input.dataset.key]: Number(input.value) }, saved);
        if (!ok) input.value = s[input.dataset.key];
      });
    });
    container.querySelectorAll("input[data-level]").forEach((input) => {
      input.addEventListener("change", async () => {
        const levels = [...container.querySelectorAll("input[data-level]")].map((i) => Number(i.value));
        const ok = await save({ levels }, saved);
        if (!ok) container.querySelectorAll("input[data-level]").forEach((i, idx) => (i.value = s.levels[idx]));
      });
    });
    container.querySelector("#kos-link-add").addEventListener("click", () => openLinkSheet());
    container.querySelectorAll("[data-unlink]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await api.unlinkKadOsAccount(btn.dataset.unlink);
          links = res.links;
          showToast(t("kos_unlink_done"));
          paint();
        } catch (err) {
          showToast(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  function linksHtml() {
    if (!links.length) return `<p class="empty-state">${t("kos_accounts_empty")}</p>`;
    return links
      .map(
        (l) => `
      <div class="card user-row">
        <div class="user-row-top"><div><strong>${escapeHtml(l.customer_name)}</strong><span class="muted"> ${escapeHtml(l.erp_customer_id ?? "")}</span></div></div>
        <div class="user-row-meta">
          <span class="muted">${escapeHtml(l.user_name)} · ${t("kos_app_orders_n").replace("{n}", String(l.app_orders))}</span>
          <span class="user-row-actions"><button class="btn-link btn-link-danger" data-unlink="${l.user_id}">${t("kos_unlink")}</button></span>
        </div>
      </div>`
      )
      .join("");
  }

  async function openLinkSheet() {
    const [users] = await Promise.all([api.listUsers()]);
    const eligible = users.filter((u) => u.role !== "admin" && u.role !== "ceo" && (u.status ?? "active") === "active");
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("kos_link_add")}</h2>
        <label>${t("kos_link_user")}
          <select id="kos-user"><option value="">${t("kos_link_user_pick")}</option>${eligible.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} · ${escapeHtml(u.email)}</option>`).join("")}</select>
        </label>
        <label>${t("kos_link_customer")}<input type="search" id="kos-cust-q" autocomplete="off" /></label>
        <div id="kos-cust-results" class="card-list kos-pick-list"></div>
        <p class="form-error" id="kos-link-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" data-action="close">${t("cancel")}</button>
          <button type="button" class="btn btn-primary" id="kos-link-save">${t("kos_link_save")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector('[data-action="close"]').addEventListener("click", () => overlay.remove());
    const errEl = overlay.querySelector("#kos-link-error");
    const showErr = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = false;
      errEl.scrollIntoView({ block: "nearest" });
    };
    let pickedId = null;
    const results = overlay.querySelector("#kos-cust-results");
    const search = debounce(async (q) => {
      if (q.trim().length < 2) {
        results.innerHTML = "";
        return;
      }
      try {
        const rows = await api.listCustomers({ search: q.trim(), limit: 20 });
        results.innerHTML = rows
          .filter((c) => c.erp_customer_id)
          .map((c) => `<button type="button" class="card list-row kos-pick${pickedId === c.id ? " is-picked" : ""}" data-pick="${c.id}"><strong>${escapeHtml(c.name)}</strong><span class="muted"> ${escapeHtml(c.erp_customer_id)}</span></button>`)
          .join("");
        results.querySelectorAll("[data-pick]").forEach((b) =>
          b.addEventListener("click", () => {
            pickedId = Number(b.dataset.pick);
            results.querySelectorAll(".kos-pick").forEach((x) => x.classList.toggle("is-picked", x === b));
          })
        );
      } catch (err) {
        results.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      }
    });
    overlay.querySelector("#kos-cust-q").addEventListener("input", (e) => search(e.target.value));
    overlay.querySelector("#kos-link-save").addEventListener("click", async () => {
      errEl.hidden = true;
      const userId = Number(overlay.querySelector("#kos-user").value);
      if (!userId) return showErr(t("kos_link_user_pick"));
      if (!pickedId) return showErr(t("kos_link_customer_pick"));
      try {
        const res = await api.linkKadOsAccount(userId, pickedId);
        links = res.links;
        overlay.remove();
        paint();
      } catch (err) {
        showErr(err.message);
      }
    });
  }

  paint();
}

// ---- campaigns ---------------------------------------------------------------------------------------------------------
const STATE_BADGE = { running: "badge-success", scheduled: "badge-info", paused: "badge-warning", ended: "badge-neutral" };
// Campaign days are Yerevan calendar days (UTC+4, no DST): the stored instants are Yerevan midnights.
const yerevanDay = (iso) => formatDateDMY(new Date(new Date(iso).getTime() + 4 * 3600 * 1000).toISOString());

export async function renderKadOsCampaignsSection(container) {
  container.innerHTML = `
    <h3 class="settings-subsection-title">${t("kos_campaigns_title")} ${hintIcon("kos-c-hint")}</h3>
    <p class="muted settings-hint" id="kos-c-text" hidden>${t("kos_campaigns_hint")}</p>
    <div id="kos-campaign-list" class="card-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    <div class="team-add-btn-wrap"><button type="button" class="btn btn-block" id="kos-campaign-new">${t("kos_campaign_new")}</button></div>`;
  wireHint(container, "kos-c-hint", "kos-c-text");
  const listEl = container.querySelector("#kos-campaign-list");
  container.querySelector("#kos-campaign-new").addEventListener("click", () => openCampaignSheet(load));

  async function load() {
    let rows;
    try {
      rows = (await api.listCampaigns()).campaigns;
    } catch (err) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    listEl.innerHTML = rows.length ? rows.map(cardHtml).join("") : `<p class="empty-state">${t("kos_campaigns_empty")}</p>`;
    listEl.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const id = btn.dataset.id;
        try {
          if (btn.dataset.act === "delete") await api.deleteCampaign(id);
          else if (btn.dataset.act === "pause") await api.updateCampaign(id, { paused: true });
          else if (btn.dataset.act === "resume") await api.updateCampaign(id, { paused: false });
          else if (btn.dataset.act === "end") await api.updateCampaign(id, { end_now: true });
          await load();
        } catch (err) {
          showToast(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  function cardHtml(c) {
    const who = c.audience === "all" ? t("kos_campaign_all") : `${t("kos_campaign_selected")}: ${c.customers.length}`;
    const live = c.state === "running" || c.state === "scheduled" || c.state === "paused";
    return `
      <div class="card user-row">
        <div class="user-row-top">
          <div><strong>${escapeHtml(c.title)}</strong><span class="muted"> ${t(c.kind === "bundle" ? "kos_campaign_kind_bundle" : "kos_campaign_kind_discount")} · ${Number(c.percent)}%</span></div>
          <span class="badge ${STATE_BADGE[c.state] ?? "badge-neutral"}">${t(`kos_campaign_state_${c.state}`)}</span>
        </div>
        <div class="kos-camp-lines muted">
          <div>${yerevanDay(c.starts_at)} → ${yerevanDay(new Date(c.ends_at).getTime() - 1)} · ${escapeHtml(who)}</div>
          <div>${c.products.map((p) => `${escapeHtml(p.brand ? p.brand + " " : "")}${escapeHtml(p.name)}${p.min_qty > 1 ? ` (${t("kos_campaign_min_qty")} ${p.min_qty})` : ""}`).join(" · ")}</div>
          <div>${t("kos_campaign_result").replace("{n}", String(c.orders_count)).replace("{sales}", formatAmd(c.sales_amd)).replace("{disc}", formatAmd(c.discount_amd))}</div>
        </div>
        <div class="user-row-meta">
          <span></span>
          <span class="user-row-actions">
            ${live ? (c.paused ? `<button class="btn-link" data-act="resume" data-id="${c.id}">${t("kos_campaign_resume")}</button>` : `<button class="btn-link" data-act="pause" data-id="${c.id}">${t("kos_campaign_pause")}</button>`) : ""}
            ${live ? `<button class="btn-link btn-link-danger" data-act="end" data-id="${c.id}">${t("kos_campaign_end")}</button>` : ""}
            ${c.orders_count === 0 ? `<button class="btn-link btn-link-danger" data-act="delete" data-id="${c.id}">${t("kos_campaign_delete")}</button>` : ""}
          </span>
        </div>
      </div>`;
  }

  await load();
}

async function openCampaignSheet(onSaved) {
  const catalog = await getProductCatalog();
  const today = new Date().toISOString().slice(0, 10);
  const draft = { kind: "discount", audience: "all", products: [], customers: [] };
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet kos-camp-sheet">
      <h2>${t("kos_campaign_new")}</h2>
      <div class="wizard-form">
        <label>${t("kos_campaign_title")}<input id="kc-title" type="text" maxlength="80" /></label>
        <label>${t("kos_campaign_note")}<input id="kc-note" type="text" maxlength="300" /></label>
        <div class="kos-seg" role="group" aria-label="${t("kos_campaign_kind")}">
          <button type="button" class="kos-seg-btn is-on" data-kind="discount">${t("kos_campaign_kind_discount")}</button>
          <button type="button" class="kos-seg-btn" data-kind="bundle">${t("kos_campaign_kind_bundle")}</button>
        </div>
        <p class="muted" id="kc-kind-help">${t("kos_campaign_kind_discount_help")}</p>
        <label>${t("kos_campaign_percent")}<input id="kc-percent" type="number" inputmode="decimal" min="1" max="50" step="0.5" /></label>
        <div class="kos-dates">
          <label>${t("kos_campaign_from")}<input id="kc-from" type="date" value="${today}" /></label>
          <label>${t("kos_campaign_to")}<input id="kc-to" type="date" value="${today}" /></label>
        </div>
        <div class="kos-seg" role="group" aria-label="${t("kos_campaign_audience")}">
          <button type="button" class="kos-seg-btn is-on" data-aud="all">${t("kos_campaign_all")}</button>
          <button type="button" class="kos-seg-btn" data-aud="selected">${t("kos_campaign_selected")}</button>
        </div>
        <div id="kc-customers" hidden>
          <input id="kc-cust-q" type="search" autocomplete="off" placeholder="${escapeHtml(t("kos_campaign_customer_add"))}" />
          <div id="kc-cust-results" class="card-list kos-pick-list"></div>
          <div id="kc-cust-chosen" class="kos-chips"></div>
        </div>
        <p class="kos-label">${t("kos_campaign_products")}</p>
        <input id="kc-prod-q" type="search" autocomplete="off" placeholder="${escapeHtml(t("kos_campaign_product_add"))}" />
        <div id="kc-prod-results" class="card-list kos-pick-list"></div>
        <div id="kc-prod-chosen" class="card-list"></div>
      </div>
      <p class="form-error" id="kc-error" role="alert" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="close">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="kc-create">${t("kos_campaign_create")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  overlay.querySelector('[data-action="close"]').addEventListener("click", () => overlay.remove());
  const $ = (sel) => overlay.querySelector(sel);
  const errEl = $("#kc-error");
  const fail = (msg, fieldSel) => {
    errEl.textContent = msg;
    errEl.hidden = false;
    errEl.scrollIntoView({ block: "nearest" });
    const f = fieldSel && $(fieldSel);
    if (f) f.focus({ preventScroll: true });
  };

  overlay.addEventListener("input", () => (errEl.hidden = true));
  overlay.querySelectorAll("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => {
      draft.kind = b.dataset.kind;
      overlay.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("is-on", x === b));
      $("#kc-kind-help").textContent = t(draft.kind === "bundle" ? "kos_campaign_kind_bundle_help" : "kos_campaign_kind_discount_help");
    })
  );
  overlay.querySelectorAll("[data-aud]").forEach((b) =>
    b.addEventListener("click", () => {
      draft.audience = b.dataset.aud;
      overlay.querySelectorAll("[data-aud]").forEach((x) => x.classList.toggle("is-on", x === b));
      $("#kc-customers").hidden = draft.audience !== "selected";
    })
  );

  // products
  const renderProducts = () => {
    $("#kc-prod-chosen").innerHTML = draft.products
      .map(
        (p, i) => `<div class="card kos-prod-row"><span>${escapeHtml(p.brand ? p.brand + " " : "")}${escapeHtml(p.name)}${p.unit ? ` · ${escapeHtml(p.unit)}` : ""}</span>
          <label class="kos-minqty"><span class="muted">${t("kos_campaign_min_qty")}</span><input type="number" inputmode="numeric" min="1" value="${p.min_qty}" data-minqty="${i}" /></label>
          <button type="button" class="icon-btn" data-rm-prod="${i}" aria-label="${t("remove")}">&times;</button></div>`
      )
      .join("");
    $("#kc-prod-chosen").querySelectorAll("[data-minqty]").forEach((inp) => inp.addEventListener("input", () => (draft.products[Number(inp.dataset.minqty)].min_qty = Math.max(1, Math.floor(Number(inp.value) || 1)))));
    $("#kc-prod-chosen").querySelectorAll("[data-rm-prod]").forEach((b) =>
      b.addEventListener("click", () => {
        draft.products.splice(Number(b.dataset.rmProd), 1);
        renderProducts();
      })
    );
  };
  $("#kc-prod-q").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim();
      const taken = new Set(draft.products.map((p) => p.product_id));
      const found = q.length < 2 ? [] : searchProducts(catalog, q).filter((p) => !taken.has(p.id)).slice(0, 8);
      $("#kc-prod-results").innerHTML = found
        .map((p) => `<button type="button" class="card list-row kos-pick" data-add-prod="${p.id}"><strong>${escapeHtml(p.brand ? p.brand + " " : "")}${escapeHtml(p.name)}</strong><span class="muted"> ${escapeHtml(p.unit ?? "")}</span></button>`)
        .join("");
      $("#kc-prod-results").querySelectorAll("[data-add-prod]").forEach((b) =>
        b.addEventListener("click", () => {
          const p = catalog.find((x) => x.id === Number(b.dataset.addProd));
          draft.products.push({ product_id: p.id, name: p.name, brand: p.brand, unit: p.unit, min_qty: 1 });
          $("#kc-prod-q").value = "";
          $("#kc-prod-results").innerHTML = "";
          renderProducts();
        })
      );
    })
  );

  // customers
  const renderCustomers = () => {
    $("#kc-cust-chosen").innerHTML = draft.customers
      .map((c, i) => `<span class="kos-chip">${escapeHtml(c.name)}<button type="button" data-rm-cust="${i}" aria-label="${t("remove")}">&times;</button></span>`)
      .join("");
    $("#kc-cust-chosen").querySelectorAll("[data-rm-cust]").forEach((b) =>
      b.addEventListener("click", () => {
        draft.customers.splice(Number(b.dataset.rmCust), 1);
        renderCustomers();
      })
    );
  };
  $("#kc-cust-q").addEventListener(
    "input",
    debounce(async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) {
        $("#kc-cust-results").innerHTML = "";
        return;
      }
      try {
        const rows = await api.listCustomers({ search: q, limit: 12 });
        const taken = new Set(draft.customers.map((c) => c.id));
        $("#kc-cust-results").innerHTML = rows
          .filter((c) => !taken.has(c.id))
          .map((c) => `<button type="button" class="card list-row kos-pick" data-add-cust="${c.id}" data-name="${escapeHtml(c.name)}"><strong>${escapeHtml(c.name)}</strong><span class="muted"> ${escapeHtml(c.erp_customer_id ?? "")}</span></button>`)
          .join("");
        $("#kc-cust-results").querySelectorAll("[data-add-cust]").forEach((b) =>
          b.addEventListener("click", () => {
            draft.customers.push({ id: Number(b.dataset.addCust), name: b.dataset.name });
            $("#kc-cust-q").value = "";
            $("#kc-cust-results").innerHTML = "";
            renderCustomers();
          })
        );
      } catch (err) {
        $("#kc-cust-results").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      }
    })
  );

  $("#kc-create").addEventListener("click", async () => {
    errEl.hidden = true;
    const title = $("#kc-title").value.trim();
    const percent = Number($("#kc-percent").value);
    const from = $("#kc-from").value;
    const to = $("#kc-to").value;
    if (!title) return fail(t("kos_campaign_need_title"), "#kc-title");
    if (!(percent >= 1 && percent <= 50)) return fail(t("kos_campaign_need_percent"), "#kc-percent");
    if (!from || !to || to < from) return fail(t("kos_campaign_need_dates"), "#kc-to");
    if (!draft.products.length) return fail(t("kos_campaign_need_products"), "#kc-prod-q");
    if (draft.kind === "bundle" && draft.products.length < 2) return fail(t("kos_campaign_need_bundle"), "#kc-prod-q");
    if (draft.audience === "selected" && !draft.customers.length) return fail(t("kos_campaign_need_customers"), "#kc-cust-q");
    const btn = $("#kc-create");
    btn.disabled = true;
    try {
      await api.createCampaign({
        title,
        note: $("#kc-note").value.trim() || null,
        kind: draft.kind,
        percent,
        starts_on: from,
        ends_on: to,
        audience: draft.audience,
        customer_ids: draft.audience === "selected" ? draft.customers.map((c) => c.id) : undefined,
        products: draft.products.map((p) => ({ product_id: p.product_id, min_qty: p.min_qty })),
      });
      overlay.remove();
      showToast(t("kos_campaign_created"));
      onSaved();
    } catch (err) {
      btn.disabled = false;
      fail(err.message);
    }
  });
}
