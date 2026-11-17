// Customer volume potential (owner, 2026-11-17): the "Volume potential" part of the combined «Պոտենցիալ» card (potential.js), its edit
// sheet and its history. The workshop profile, the services it does and its monthly potential per product line (litres; grease in kg). The
// TOTAL is the customer's whole monthly need (customers.expected_volume_l, the funnel's number): one number, edited here or at check-in.
// The section is folded and loads its data only when opened (the card itself stays as fast as before); a save without signal waits in
// the offline queue (offlineQueue.js "volume_potential").
import { api } from "./api.js";
import { t, getLang } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, formatDateTime, openInfoPopup, showToast, labelColon } from "./util.js";
import { enqueueVolumePotential } from "./offlineQueue.js";

export const VOLUME_STALE_DAYS = 90;
const SOURCES = ["rep_estimate", "customer_stated", "invoice"];
const CONFIDENCE = ["low", "med", "high"];
const GROUP_ORDER = ["pcmo", "hdeo", "transmission", "ev", "coolant", "brake", "grease", "other"];
const nf = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });

// { lines, services, vehicles, brands }: read again after 10 minutes, or at once after a change in Settings (clearVolumeCatalogue)
let catalogue = null;
let catalogueAt = 0;
async function loadCatalogue() {
  if (!catalogue || Date.now() - catalogueAt > 10 * 60 * 1000) {
    catalogue = await api.getPotentialLines();
    catalogueAt = Date.now();
  }
  return catalogue;
}
export function clearVolumeCatalogue() {
  catalogue = null;
}
export const volumeAgeDays = (customer, now = Date.now()) => {
  const at = customer.volume_potential_at ? new Date(customer.volume_potential_at).getTime() : NaN;
  return Number.isFinite(at) ? Math.floor((now - at) / 86400000) : null;
};
export const volumeIsStale = (customer) => {
  const age = volumeAgeDays(customer);
  return age === null || age >= VOLUME_STALE_DAYS;
};
const lineName = (l) => (getLang() === "hy" ? l.name_hy : l.name_en);

// ---- the section on the card ---------------------------------------------------------------------------------------------------------
// The folded head: the total and a quiet "update" badge when the record is over 90 days old or was never filled; at a check-in an
// optional "Update potential" chip instead (never required).
export function volumeSectionHtml(customer, { checkin = false } = {}) {
  const stale = volumeIsStale(customer);
  const total = customer.expected_volume_l != null ? `${nf(customer.expected_volume_l)} ${t("vp_l_month")}` : t("vp_not_filled");
  return `<div class="vp-section" data-vp>
      <button type="button" class="vp-head" data-vp-toggle aria-expanded="false">
        <span class="vp-head-title">${escapeHtml(t("vp_title"))}</span>
        ${customer.expected_volume_l != null ? `<span class="vp-head-total muted">${escapeHtml(total)}</span>` : ""}
        ${stale && !checkin ? `<span class="badge badge-warning vp-stale">${escapeHtml(t(customer.volume_potential_at ? "vp_stale" : "vp_never"))}</span>` : ""}
        <span class="vp-chev" aria-hidden="true"></span>
      </button>
      ${checkin && stale ? `<button type="button" class="map-filter-chip vp-update-chip" data-vp-edit>${icons.pencil}<span>${escapeHtml(t("vp_update_chip"))}</span></button>` : ""}
      <div class="vp-body" hidden></div>
    </div>`;
}

// Customers whose section is open: it stays open when the card is drawn again (after a save, a tab switch).
const openFor = new Set();

// Wires a volumeSectionHtml() block inside `root`. `reload` re-reads the customer after a save.
export function wireVolumeSection(root, customer, { reload } = {}) {
  const box = root.querySelector("[data-vp]");
  if (!box) return;
  const head = box.querySelector("[data-vp-toggle]");
  const body = box.querySelector(".vp-body");
  let loaded = null;
  const paintBody = async () => {
    body.innerHTML = `<p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`;
    try {
      const [data, cat] = await Promise.all([api.getVolumePotential(customer.id), loadCatalogue()]);
      loaded = data;
      body.innerHTML = summaryHtml(data, cat);
    } catch (err) {
      loaded = null;
      body.innerHTML = `<p class="${err instanceof TypeError ? "muted" : "form-error"}">${escapeHtml(err instanceof TypeError ? t("vp_offline_body") : err.message)}</p>`;
      return;
    }
    body.querySelector("[data-vp-edit-open]")?.addEventListener("click", () => openVolumePotentialSheet(customer, { data: loaded, onSaved: reload }));
    body.querySelector("[data-vp-history]")?.addEventListener("click", () => openVolumeHistory(customer.id));
  };
  const setOpen = (open) => {
    head.setAttribute("aria-expanded", String(open));
    box.classList.toggle("vp-open", open);
    body.hidden = !open;
    if (open) openFor.add(customer.id);
    else openFor.delete(customer.id);
    if (open && !loaded) paintBody();
  };
  head.addEventListener("click", () => setOpen(head.getAttribute("aria-expanded") !== "true"));
  if (openFor.has(customer.id)) setOpen(true);
  box.querySelector("[data-vp-edit]")?.addEventListener("click", () => openVolumePotentialSheet(customer, { onSaved: reload }));
}

function summaryHtml(data, cat) {
  const p = data.profile;
  const rows = [];
  const row = (label, value) => rows.push(`<div class="vp-row"><span>${escapeHtml(label)}</span><span class="vp-num">${escapeHtml(value)}</span></div>`);
  row(t("vp_total"), data.total_l != null ? `${nf(data.total_l)} ${t("vp_l_month")}` : "—");
  const byId = new Map(cat.lines.map((l) => [l.id, l]));
  const sum = data.lines.reduce((s, l) => s + (byId.get(l.line_id)?.unit === "kg" ? 0 : Number(l.amount)), 0);
  if (data.lines.length) row(t("vp_lines_sum"), `${nf(sum)} ${t("vp_l_month")}`);
  if (p?.cars_per_month != null) row(t("vp_cars"), nf(p.cars_per_month));
  if (p?.bays != null) row(t("vp_bays"), nf(p.bays));
  const done = Object.entries(p?.services ?? {}).filter(([, v]) => v.does).map(([k]) => t(`vp_svc_${k}`));
  const lines = data.lines
    .map((l) => ({ ...l, line: byId.get(l.line_id) }))
    .filter((l) => l.line)
    .sort((a, b) => a.line.sort_order - b.line.sort_order)
    .map((l) => `<div class="vp-row"><span>${escapeHtml(lineName(l.line))}</span><span class="vp-num">${nf(l.amount)} ${escapeHtml(l.line.unit === "kg" ? t("vp_kg") : t("vp_l"))}${l.our_share_pct != null ? ` · ${l.our_share_pct}%` : ""}</span></div>`)
    .join("");
  const brands = (p?.brands ?? []).map((b) => (b === "other" && p.brands_other ? p.brands_other : t(`vp_brand_${b}`))).join(", ");
  return `<div class="vp-rows">${rows.join("")}</div>
    ${lines ? `<div class="vp-rows vp-lines">${lines}</div>` : ""}
    ${done.length ? `<div class="vp-line-text"><span class="muted">${escapeHtml(t("vp_services"))}${labelColon()}</span>${escapeHtml(done.join(", "))}</div>` : ""}
    ${brands ? `<div class="vp-line-text"><span class="muted">${escapeHtml(t("vp_brands"))}${labelColon()}</span>${escapeHtml(brands)}</div>` : ""}
    ${p ? `<div class="vp-meta muted">${escapeHtml([p.source ? t(`vp_src_${p.source}`) : "", p.confidence ? t(`vp_conf_${p.confidence}`) : "", p.updated_by_name ?? "", formatDateTime(p.updated_at)].filter(Boolean).join(" · "))}</div>` : `<p class="muted">${escapeHtml(t("vp_empty"))}</p>`}
    <div class="vp-actions">
      <button type="button" class="btn btn-primary" data-vp-edit-open>${escapeHtml(t(p ? "vp_edit" : "vp_fill"))}</button>
      ${p ? `<button type="button" class="pl-link" data-vp-history>${escapeHtml(t("pl_history"))}</button>` : ""}
    </div>`;
}

// ---- the edit sheet --------------------------------------------------------------------------------------------------------------------
export async function openVolumePotentialSheet(customer, { data = null, onSaved } = {}) {
  let cat;
  try {
    [cat, data] = await Promise.all([loadCatalogue(), data ? Promise.resolve(data) : api.getVolumePotential(customer.id)]);
  } catch (err) {
    showToast(err.message);
    return;
  }
  const p = data.profile ?? {};
  const services = { ...(p.services ?? {}) };
  const vehicles = new Set(p.vehicle_mix ?? []);
  const brands = new Set(data.profile ? p.brands ?? [] : data.brands_from_visits ?? []);
  const amounts = new Map(data.lines.map((l) => [l.line_id, l]));
  let source = p.source ?? null;
  let confidence = p.confidence ?? null;

  const chips = (name, keys, selected, label) =>
    `<div class="vp-chips" role="group" data-chips="${name}">${keys
      .map((k) => `<button type="button" class="map-filter-chip${selected.has(k) ? " chip-active" : ""}" data-k="${k}" aria-pressed="${selected.has(k)}">${escapeHtml(t(`${label}${k}`))}</button>`)
      .join("")}</div>`;
  const radios = (name, keys, value, label) =>
    `<div class="vp-chips" role="radiogroup" data-radio="${name}">${keys
      .map((k) => `<button type="button" class="map-filter-chip${value === k ? " chip-active" : ""}" data-k="${k}" role="radio" aria-checked="${value === k}">${escapeHtml(t(`${label}${k}`))}</button>`)
      .join("")}</div>`;
  const serviceRow = (s) => {
    const v = services[s.key] ?? {};
    return `<div class="vp-svc" data-svc="${s.key}">
        <button type="button" class="vp-svc-main${v.does ? " vp-on" : ""}" data-svc-does aria-pressed="${Boolean(v.does)}"><span class="pl-reason-box" aria-hidden="true"></span><span>${escapeHtml(t(`vp_svc_${s.key}`))}</span></button>
        <div class="vp-svc-extra"${v.does && (s.buys || s.machine) ? "" : " hidden"}>
          ${s.buys ? `<button type="button" class="map-filter-chip${v.buys === true ? " chip-active" : ""}" data-svc-buys aria-pressed="${v.buys === true}">${escapeHtml(t("vp_buys_from_us"))}</button>` : ""}
          ${s.machine ? `<button type="button" class="map-filter-chip${v.machine === true ? " chip-active" : ""}" data-svc-machine aria-pressed="${v.machine === true}">${escapeHtml(t("vp_has_machine"))}</button>` : ""}
        </div>
      </div>`;
  };
  const groups = GROUP_ORDER.map((g) => [g, cat.lines.filter((l) => (GROUP_ORDER.includes(l.group_key) ? l.group_key : "other") === g)]).filter(([, ls]) => ls.length);
  const lineRow = (l) => {
    const a = amounts.get(l.id);
    return `<div class="vp-line" data-line="${l.id}">
        <span class="vp-line-name">${escapeHtml(lineName(l))}${l.castrol_hint ? `<small class="muted">${escapeHtml(l.castrol_hint)}</small>` : ""}</span>
        <input class="vp-amount" type="number" inputmode="decimal" min="0" step="any" aria-label="${escapeHtml(`${lineName(l)}, ${l.unit === "kg" ? t("vp_kg_month") : t("vp_l_month")}`)}" placeholder="${escapeHtml(l.unit === "kg" ? t("vp_kg") : t("vp_l"))}" value="${a ? Number(a.amount) : ""}" />
        <input class="vp-share" type="number" inputmode="numeric" min="0" max="100" step="1" aria-label="${escapeHtml(`${lineName(l)}, ${t("vp_share")}`)}" placeholder="%" value="${a?.our_share_pct ?? ""}" />
      </div>`;
  };

  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet vp-sheet">
      <div class="vp-sheet-head"><h2>${escapeHtml(t("vp_title"))}</h2><button type="button" class="icon-btn vp-info" data-vp-info aria-label="${escapeHtml(t("vp_info_label"))}">!</button></div>
      <p class="muted vp-sheet-sub">${escapeHtml(customer.name ?? "")}</p>
      <form id="vp-form" novalidate>
        <section class="vp-sec">
          <h3 class="pl-section-title">${escapeHtml(t("vp_workshop"))}</h3>
          <div class="vp-grid2">
            <label>${escapeHtml(t("vp_cars"))}<input name="cars_per_month" type="number" inputmode="numeric" min="0" step="1" value="${p.cars_per_month ?? ""}" /></label>
            <label>${escapeHtml(t("vp_bays"))}<input name="bays" type="number" inputmode="numeric" min="0" step="1" value="${p.bays ?? ""}" /></label>
          </div>
          <div class="pl-section-title vp-sub">${escapeHtml(t("vp_vehicles"))}</div>
          ${chips("vehicles", cat.vehicles, vehicles, "vp_veh_")}
          <div class="pl-section-title vp-sub">${escapeHtml(t("vp_brands"))}${!data.profile && brands.size ? ` <small class="muted">${escapeHtml(t("vp_brands_prefilled"))}</small>` : ""}</div>
          ${chips("brands", cat.brands, brands, "vp_brand_")}
          <input name="brands_other" class="vp-other" maxlength="120" placeholder="${escapeHtml(t("vp_brands_other"))}" value="${escapeHtml(p.brands_other ?? "")}"${brands.has("other") ? "" : " hidden"} />
        </section>
        <section class="vp-sec">
          <h3 class="pl-section-title">${escapeHtml(t("vp_services"))}</h3>
          <div class="vp-svcs">${cat.services.map(serviceRow).join("")}</div>
        </section>
        <section class="vp-sec">
          <h3 class="pl-section-title">${escapeHtml(t("vp_volumes"))}</h3>
          <label class="vp-total">${escapeHtml(t("vp_total"))}<input name="total_l" type="number" inputmode="decimal" min="0" step="any" value="${data.total_l ?? ""}" /></label>
          <div class="vp-line vp-line-head muted"><span>${escapeHtml(t("vp_line"))}</span><span>${escapeHtml(t("vp_per_month"))}</span><span>${escapeHtml(t("vp_share_short"))}</span></div>
          ${groups.map(([g, ls]) => `<div class="vp-group"><div class="vp-group-name">${escapeHtml(t(`vp_group_${g}`))}</div>${ls.map(lineRow).join("")}</div>`).join("")}
          <p class="vp-sum muted" aria-live="polite"></p>
        </section>
        <section class="vp-sec">
          <h3 class="pl-section-title">${escapeHtml(t("vp_source"))}</h3>
          ${radios("source", SOURCES, source, "vp_src_")}
          <div class="pl-section-title vp-sub">${escapeHtml(t("vp_confidence"))}</div>
          ${radios("confidence", CONFIDENCE, confidence, "vp_conf_")}
        </section>
        <p class="form-error" id="vp-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="vp-cancel">${escapeHtml(t("cancel"))}</button>
          <button type="submit" class="btn btn-primary">${escapeHtml(t("pl_save"))}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#vp-cancel").addEventListener("click", close);
  overlay.querySelector("[data-vp-info]").addEventListener("click", () => openInfoPopup(t("vp_info")));
  const form = overlay.querySelector("#vp-form");
  const otherEl = form.querySelector('[name="brands_other"]');

  // chips: multi-select (vehicles, brands) and single choice that can be cleared (source, confidence)
  form.querySelectorAll("[data-chips]").forEach((group) =>
    group.addEventListener("click", (e) => {
      const b = e.target.closest("[data-k]");
      if (!b) return;
      const set = group.dataset.chips === "vehicles" ? vehicles : brands;
      if (set.has(b.dataset.k)) set.delete(b.dataset.k);
      else set.add(b.dataset.k);
      b.classList.toggle("chip-active", set.has(b.dataset.k));
      b.setAttribute("aria-pressed", String(set.has(b.dataset.k)));
      if (group.dataset.chips === "brands") otherEl.hidden = !brands.has("other");
    })
  );
  form.querySelectorAll("[data-radio]").forEach((group) =>
    group.addEventListener("click", (e) => {
      const b = e.target.closest("[data-k]");
      if (!b) return;
      const next = b.classList.contains("chip-active") ? null : b.dataset.k;
      if (group.dataset.radio === "source") source = next;
      else confidence = next;
      group.querySelectorAll("[data-k]").forEach((x) => {
        x.classList.toggle("chip-active", x.dataset.k === next);
        x.setAttribute("aria-checked", String(x.dataset.k === next));
      });
    })
  );
  form.querySelector(".vp-svcs").addEventListener("click", (e) => {
    const row = e.target.closest("[data-svc]");
    if (!row) return;
    const key = row.dataset.svc;
    const def = cat.services.find((s) => s.key === key);
    const v = (services[key] ??= { does: false });
    if (e.target.closest("[data-svc-does]")) {
      v.does = !v.does;
      const main = row.querySelector("[data-svc-does]");
      main.classList.toggle("vp-on", v.does);
      main.setAttribute("aria-pressed", String(v.does));
      row.querySelector(".vp-svc-extra").hidden = !(v.does && (def.buys || def.machine));
    } else if (e.target.closest("[data-svc-buys]")) {
      v.buys = v.buys === true ? false : true;
      const b = row.querySelector("[data-svc-buys]");
      b.classList.toggle("chip-active", v.buys);
      b.setAttribute("aria-pressed", String(v.buys));
    } else if (e.target.closest("[data-svc-machine]")) {
      v.machine = v.machine === true ? false : true;
      const b = row.querySelector("[data-svc-machine]");
      b.classList.toggle("chip-active", v.machine);
      b.setAttribute("aria-pressed", String(v.machine));
    }
  });

  // the sum of the lines (litres) against the total: a soft warning above 15 % apart, never a block
  const sumEl = form.querySelector(".vp-sum");
  const kgLines = new Set(cat.lines.filter((l) => l.unit === "kg").map((l) => l.id));
  const paintSum = () => {
    const total = Number(form.querySelector('[name="total_l"]').value);
    let sum = 0;
    form.querySelectorAll("[data-line]").forEach((r) => {
      if (!kgLines.has(Number(r.dataset.line))) sum += Number(r.querySelector(".vp-amount").value) || 0;
    });
    if (!sum) {
      sumEl.textContent = "";
      sumEl.classList.remove("vp-warn");
      return;
    }
    const off = total > 0 && Math.abs(sum - total) / total > 0.15;
    sumEl.textContent = off ? t("vp_sum_warn").replace("{sum}", nf(sum)).replace("{total}", nf(total)) : t("vp_sum").replace("{sum}", nf(sum));
    sumEl.classList.toggle("vp-warn", off);
  };
  form.addEventListener("input", paintSum);
  paintSum();

  const errorEl = overlay.querySelector("#vp-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      cars_per_month: f.get("cars_per_month") === "" ? null : Number(f.get("cars_per_month")),
      bays: f.get("bays") === "" ? null : Number(f.get("bays")),
      vehicle_mix: [...vehicles],
      brands: [...brands],
      brands_other: brands.has("other") ? String(f.get("brands_other") ?? "").trim() : "",
      services,
      lines: [...form.querySelectorAll("[data-line]")]
        .map((r) => ({ line_id: Number(r.dataset.line), amount: r.querySelector(".vp-amount").value, our_share_pct: r.querySelector(".vp-share").value }))
        .filter((l) => l.amount !== "" && Number(l.amount) > 0)
        .map((l) => ({ line_id: l.line_id, amount: Number(l.amount), our_share_pct: l.our_share_pct === "" ? null : Math.round(Number(l.our_share_pct)) })),
      total_l: f.get("total_l") === "" ? null : Number(f.get("total_l")),
      source,
      confidence,
      client_ref: crypto.randomUUID(),
      captured_at: new Date().toISOString(),
    };
    const bad = body.lines.find((l) => l.our_share_pct != null && (l.our_share_pct < 0 || l.our_share_pct > 100));
    if (bad || (body.cars_per_month != null && !(body.cars_per_month >= 0)) || (body.bays != null && !(body.bays >= 0))) {
      errorEl.textContent = t("vp_bad_number");
      errorEl.hidden = false;
      return;
    }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (!navigator.onLine) throw new TypeError("offline");
      await api.saveVolumePotential(customer.id, body);
      close();
      showToast(t("vp_saved"));
      onSaved?.();
    } catch (err) {
      // no signal: the save waits on the phone and is sent when the signal is back (a newer save of the same customer replaces it)
      if (err instanceof TypeError) {
        await enqueueVolumePotential({ customerId: customer.id, customerName: customer.name, body });
        close();
        showToast(t("vp_saved_offline"));
        return;
      }
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}

// ---- the history ---------------------------------------------------------------------------------------------------------------------
export async function openVolumeHistory(customerId) {
  const overlay = openInfoPopup(`<h2>${escapeHtml(t("pl_history"))}</h2><p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`);
  const body = overlay.querySelector(".info-popup-body");
  try {
    const [rows, cat] = await Promise.all([api.getVolumePotentialHistory(customerId), loadCatalogue()]);
    const byId = new Map(cat.lines.map((l) => [l.id, l]));
    const sumOf = (s) => (s?.lines ?? []).reduce((a, l) => a + (byId.get(l.line_id)?.unit === "kg" ? 0 : Number(l.amount)), 0);
    body.innerHTML = `<h2>${escapeHtml(t("pl_history"))}</h2>${
      rows.length
        ? rows
            .map((h) => {
              const total = (s) => (s?.total_l != null ? nf(s.total_l) : "—");
              const changes = [];
              if (total(h.before) !== total(h.after)) changes.push(`${t("vp_total")}${labelColon()}${total(h.before)} → ${total(h.after)}`);
              if (sumOf(h.before) !== sumOf(h.after)) changes.push(`${t("vp_lines_sum")}${labelColon()}${nf(sumOf(h.before))} → ${nf(sumOf(h.after))}`);
              const svc = (s) => Object.entries(s?.profile?.services ?? {}).filter(([, v]) => v.does).length;
              if (svc(h.before) !== svc(h.after)) changes.push(`${t("vp_services")}${labelColon()}${svc(h.before)} → ${svc(h.after)}`);
              return `<div class="pl-hist"><div class="pl-hist-date">${escapeHtml(formatDateTime(h.changed_at))}${h.changed_by_name ? ` · ${escapeHtml(h.changed_by_name)}` : ""}</div>${
                changes.length ? changes.map((c) => `<div>${escapeHtml(c)}</div>`).join("") : `<div class="muted">${escapeHtml(t(h.before ? "vp_hist_details" : "vp_hist_first"))}</div>`
              }</div>`;
            })
            .join("")
        : `<p class="muted">${escapeHtml(t("pl_history_empty"))}</p>`
    }`;
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}
