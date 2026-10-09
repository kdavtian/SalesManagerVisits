// Fuel allowance report: per rep, per day, the kilometres driven between the
// day's check-ins (home legs when the day starts/ends outside Yerevan) and the
// fuel money they are worth. Tap a rep to see the days, tap a day to see the
// exact route with times. Owner roles (admin/CEO) also set consumption, home
// address, the monthly fuel price and can correct a day.
import { api } from "../api.js";
import { t, getLang } from "../i18n.js";
import { escapeHtml, formatAmd, downloadFromUrl, activateDialog } from "../util.js";
import { icons } from "../icons.js";

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const km = (v) => `${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 0 })} ${t("fuel_km_unit")}`;
const liters = (v) => (v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${t("fuel_liters_unit")}`);
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", minute: "2-digit" });
function dayLabel(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = d.toLocaleDateString(getLang() === "hy" ? "hy-AM" : "en-GB", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export async function renderFuelReport(root, navigate) {
  let month = currentMonth();
  let data = null;
  let refined = false;
  let retried = false;
  const openReps = new Set();
  const openDays = new Set();

  root.innerHTML = `
    <div class="detail-view fuel-view">
      <div class="detail-header report-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="detail-header-title"><h1>${t("report_fuel_allowance_name")}</h1></div>
      </div>
      <div class="fuel-controls">
        <input type="month" id="fuel-month" value="${month}" aria-label="${t("fuel_month")}" />
        <button type="button" class="icon-btn" id="fuel-settings-btn" aria-label="${t("fuel_settings")}" title="${t("fuel_settings")}" hidden>${icons.settings ?? "⚙"}</button>
        <button type="button" class="icon-btn" id="fuel-csv-btn" aria-label="${t("fuel_download_csv")}" title="${t("fuel_download_csv")}">${icons.download}</button>
      </div>
      <div id="fuel-body"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>`;
  const container = root.querySelector(".fuel-view");
  const body = container.querySelector("#fuel-body");
  container.querySelector("#back-btn").addEventListener("click", () => navigate("#/reports"));
  container.querySelector("#fuel-month").addEventListener("change", (e) => {
    month = e.target.value || currentMonth();
    refined = false;
    retried = false;
    load();
  });
  container.querySelector("#fuel-csv-btn").addEventListener("click", async () => {
    try {
      await downloadFromUrl(`/api/fuel/report.csv?month=${month}`, `fuel-${month}.csv`);
    } catch (err) {
      body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
    }
  });
  container.querySelector("#fuel-settings-btn").addEventListener("click", () => openSettings());

  async function load({ quiet = false } = {}) {
    if (!quiet) body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      data = await api.fuelReport(month);
      container.querySelector("#fuel-settings-btn").hidden = !data.can_manage;
      paint();
      // The first load of a month can use estimated distances while the
      // routing engine answers; ask once more shortly after for real ones.
      if (data.estimated_days > 0 && !refined) {
        refined = true;
        setTimeout(() => {
          retried = true;
          if (container.isConnected) load({ quiet: true });
        }, 6000);
      }
    } catch (err) {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function paint() {
    const scroll = window.scrollY;
    const t0 = data.totals;
    const needPrice = data.price_amd_per_l == null;
    body.innerHTML = `
      <div class="stat-grid fuel-stats">
        <div class="stat-card"><span class="stat-value">${km(t0.km)}</span><span class="stat-label">${t("fuel_total_km")}</span></div>
        <div class="stat-card"><span class="stat-value">${liters(t0.liters)}</span><span class="stat-label">${t("fuel_total_liters")}</span></div>
        <div class="stat-card fuel-stat-wide"><span class="stat-value">${t0.amount == null ? "—" : formatAmd(t0.amount)}</span><span class="stat-label">${t("fuel_total_amount")}${data.price_amd_per_l ? ` · ${data.price_amd_per_l} ${t("amd")}/${t("fuel_liters_unit")}` : ""}</span></div>
      </div>
      ${needPrice ? `<p class="fuel-note fuel-note-warn">${t("fuel_price_missing")}</p>` : ""}
      ${data.estimated_days > 0 ? `<p class="fuel-note">${refined && retried ? t("fuel_estimated_note") : t("fuel_refining")}</p>` : ""}
      <div class="card-list fuel-reps">${data.reps.map(repHtml).join("") || `<p class="empty-state">${t("no_data")}</p>`}</div>
      <p class="muted fuel-formula">${t("fuel_formula")}</p>`;
    window.scrollTo(0, scroll);
  }

  function repHtml(rep) {
    const open = openReps.has(rep.user_id);
    const chips = [
      rep.fuel_l_per_100km == null ? `<span class="badge badge-warning">${t("fuel_no_consumption")}</span>` : `<span class="badge badge-neutral">${rep.fuel_l_per_100km} ${t("fuel_liters_unit")}/100${t("fuel_km_unit")}</span>`,
      rep.totals.missing_home_days ? `<span class="badge badge-warning">${t("fuel_home_missing")}</span>` : "",
      rep.totals.estimated_days ? `<span class="badge badge-neutral">${t("fuel_estimated")}</span>` : "",
    ].join("");
    return `
      <div class="card fuel-rep ${open ? "is-open" : ""}">
        <button type="button" class="fuel-rep-head" data-rep="${rep.user_id}" aria-expanded="${open}">
          <span class="fuel-rep-main"><strong>${escapeHtml(rep.name_hy || rep.name)}</strong><span class="muted">${rep.totals.days} ${t("fuel_days_unit")} · ${km(rep.totals.km)}</span></span>
          <span class="fuel-rep-amount">${rep.totals.amount == null ? "" : formatAmd(rep.totals.amount)}</span>
          <span class="fuel-chevron" aria-hidden="true">${icons.chevronDown}</span>
        </button>
        <div class="fuel-rep-chips">${chips}</div>
        ${open ? `<div class="fuel-days">${rep.days.map((d) => dayHtml(rep, d)).join("") || `<p class="muted">${t("fuel_no_visits")}</p>`}</div>` : ""}
      </div>`;
  }

  function dayHtml(rep, d) {
    const key = `${rep.user_id}:${d.date}`;
    const open = openDays.has(key);
    return `
      <div class="fuel-day ${open ? "is-open" : ""}">
        <button type="button" class="fuel-day-head" data-day="${key}" aria-expanded="${open}">
          <span class="fuel-day-date">${dayLabel(d.date)}</span>
          <span class="fuel-day-km">${km(d.km)}${d.override ? ` <span class="badge badge-info">${t("fuel_adjusted")}</span>` : d.estimated ? ` <span class="badge badge-neutral">${t("fuel_estimated")}</span>` : ""}</span>
          <span class="fuel-day-amount">${d.amount == null ? "" : formatAmd(d.amount)}</span>
        </button>
        ${open ? routeHtml(rep, d) : ""}
      </div>`;
  }

  function routeHtml(rep, d) {
    const stops = d.route
      .map((p) => {
        const title = p.type === "home" ? `${t("fuel_home")}${p.name ? ` · ${escapeHtml(p.name)}` : ""}` : escapeHtml(p.name);
        return `
        <li class="fuel-stop fuel-stop-${p.type}">
          <span class="fuel-time">${p.time ? timeOf(p.time) : ""}</span>
          <span class="fuel-dot" aria-hidden="true"></span>
          <span class="fuel-stop-body"><strong>${title}</strong>${p.km_from_prev != null ? `<span class="fuel-leg">+ ${km(p.km_from_prev)}</span>` : ""}</span>
        </li>`;
      })
      .join("");
    const skipped = d.skipped.map((s) => `<li class="fuel-skipped"><span class="fuel-time">${timeOf(s.time)}</span> ${escapeHtml(s.name)} — ${t("fuel_not_counted")}</li>`).join("");
    const merged = d.merged.map((m) => `<li class="fuel-skipped"><span class="fuel-time">${timeOf(m.time)}</span> ${escapeHtml(m.name)} — ${t("fuel_same_place")}</li>`).join("");
    const manage = data.can_manage
      ? `<div class="fuel-day-actions"><button type="button" class="btn" data-adjust="${rep.user_id}:${d.date}">${t("fuel_adjust_km")}</button>${d.override ? `<button type="button" class="btn" data-reset="${rep.user_id}:${d.date}">${t("fuel_reset")}</button>` : ""}</div>`
      : "";
    return `
      <div class="fuel-route">
        ${d.missing_home ? `<p class="fuel-note fuel-note-warn">${t("fuel_home_missing")}</p>` : ""}
        ${d.override ? `<p class="fuel-note">${t("fuel_computed_km").replace("{km}", d.computed_km)}${d.override.note ? ` · ${escapeHtml(d.override.note)}` : ""}</p>` : ""}
        <ol class="fuel-stops">${stops || `<li class="muted">${t("fuel_no_visits")}</li>`}</ol>
        ${skipped || merged ? `<ul class="fuel-skipped-list">${skipped}${merged}</ul>` : ""}
        ${manage}
      </div>`;
  }

  body.addEventListener("click", async (e) => {
    const repBtn = e.target.closest("[data-rep]");
    if (repBtn) {
      const id = Number(repBtn.dataset.rep);
      if (openReps.has(id)) openReps.delete(id);
      else openReps.add(id);
      return paint();
    }
    const dayBtn = e.target.closest("[data-day]");
    if (dayBtn) {
      const key = dayBtn.dataset.day;
      if (openDays.has(key)) openDays.delete(key);
      else openDays.add(key);
      return paint();
    }
    const adjust = e.target.closest("[data-adjust]");
    if (adjust) return openAdjust(...adjust.dataset.adjust.split(":"));
    const reset = e.target.closest("[data-reset]");
    if (reset) {
      const [uid, date] = reset.dataset.reset.split(":");
      await api.setFuelOverride({ user_id: Number(uid), day: date, km: null });
      load({ quiet: true });
    }
  });

  function sheet(html) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet fuel-sheet" role="dialog" aria-modal="true"><form class="fuel-form" onsubmit="return false">${html}</form></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    return overlay;
  }

  function openAdjust(uid, date) {
    const rep = data.reps.find((r) => r.user_id === Number(uid));
    const day = rep?.days.find((d) => d.date === date);
    if (!day) return;
    const overlay = sheet(`
      <h2>${t("fuel_adjust_km")}</h2>
      <p class="muted">${escapeHtml(rep.name_hy || rep.name)} · ${dayLabel(date)} · ${t("fuel_computed_km").replace("{km}", day.computed_km)}</p>
      <label>${t("fuel_total_km")}<input type="number" id="adj-km" min="0" max="2000" step="0.1" value="${day.km}" inputmode="decimal" /></label>
      <label>${t("fuel_adjust_note")}<input type="text" id="adj-note" maxlength="300" value="${escapeHtml(day.override?.note ?? "")}" /></label>
      <p class="form-error" id="adj-error" hidden></p>
      <div class="sheet-actions"><button type="button" class="btn" data-close>${t("cancel")}</button><button type="button" class="btn btn-primary" id="adj-save">${t("save")}</button></div>`);
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#adj-save").addEventListener("click", async () => {
      try {
        await api.setFuelOverride({ user_id: Number(uid), day: date, km: Number(overlay.querySelector("#adj-km").value), note: overlay.querySelector("#adj-note").value || null });
        overlay.remove();
        load({ quiet: true });
      } catch (err) {
        const el = overlay.querySelector("#adj-error");
        el.textContent = err.message;
        el.hidden = false;
      }
    });
  }

  async function openSettings() {
    let s;
    try {
      s = await api.fuelSettings(month);
    } catch (err) {
      return body.insertAdjacentHTML("afterbegin", `<p class="form-error">${escapeHtml(err.message)}</p>`);
    }
    const overlay = sheet(`
      <h2>${t("fuel_settings")}</h2>
      <section class="fuel-price-box">
        <label>${t("fuel_price_label")} · ${month}<input type="number" id="fuel-price" min="1" step="1" inputmode="decimal" value="${s.price_amd_per_l ?? ""}" /></label>
        <button type="button" class="btn btn-primary" id="fuel-price-save">${t("save")}</button>
      </section>
      <div class="fuel-settings-reps">
        ${s.reps
          .map(
            (r) => `
          <div class="card fuel-rep-settings" data-user="${r.id}">
            <strong>${escapeHtml(r.name_hy || r.name)}</strong>
            <label>${t("fuel_consumption")}<input type="number" class="fs-cons" min="1" max="60" step="0.1" inputmode="decimal" value="${r.fuel_l_per_100km ?? ""}" /></label>
            <label>${t("fuel_home_address")}<input type="text" class="fs-home" maxlength="300" value="${escapeHtml(r.home_address ?? "")}" placeholder="${t("fuel_home_placeholder")}" /></label>
            <input type="hidden" class="fs-lat" value="${r.home_lat ?? ""}" /><input type="hidden" class="fs-lng" value="${r.home_lng ?? ""}" />
            <div class="fuel-home-status muted">${r.home_lat != null ? `📍 ${t("fuel_home_saved")}` : t("fuel_home_missing")}</div>
            <div class="fuel-search-results"></div>
            <div class="sheet-actions"><button type="button" class="btn fs-search">${t("fuel_home_search")}</button><button type="button" class="btn btn-primary fs-save">${t("save")}</button></div>
            <p class="form-error fs-error" hidden></p>
          </div>`
          )
          .join("")}
      </div>
      <div class="sheet-actions"><button type="button" class="btn" data-close>${t("close")}</button></div>`);
    overlay.querySelector("[data-close]").addEventListener("click", () => {
      overlay.remove();
      load({ quiet: true });
    });
    overlay.querySelector("#fuel-price-save").addEventListener("click", async () => {
      try {
        await api.setFuelPrice(month, Number(overlay.querySelector("#fuel-price").value));
        overlay.querySelector("#fuel-price-save").textContent = `✓ ${t("fuel_saved")}`;
      } catch (err) {
        overlay.querySelector("#fuel-price-save").textContent = err.message;
      }
    });
    overlay.querySelectorAll(".fuel-rep-settings").forEach((card) => {
      const lat = card.querySelector(".fs-lat");
      const lng = card.querySelector(".fs-lng");
      const home = card.querySelector(".fs-home");
      const results = card.querySelector(".fuel-search-results");
      const err = card.querySelector(".fs-error");
      home.addEventListener("input", () => {
        // Editing the text invalidates the old pin until an address is picked again.
        lat.value = "";
        lng.value = "";
        card.querySelector(".fuel-home-status").textContent = t("fuel_home_pick");
      });
      card.querySelector(".fs-search").addEventListener("click", async () => {
        results.innerHTML = `<p class="muted">${t("loading")}</p>`;
        try {
          const found = await api.searchAddress(home.value);
          results.innerHTML = found.length
            ? found.map((f, i) => `<button type="button" class="fuel-result" data-i="${i}">${escapeHtml(f.address)}</button>`).join("")
            : `<p class="muted">${t("fuel_search_none")}</p>`;
          results.querySelectorAll(".fuel-result").forEach((btn) =>
            btn.addEventListener("click", () => {
              const f = found[Number(btn.dataset.i)];
              home.value = f.address;
              lat.value = f.lat;
              lng.value = f.lng;
              results.innerHTML = "";
              card.querySelector(".fuel-home-status").textContent = `📍 ${t("fuel_home_picked")}`;
            })
          );
        } catch (e2) {
          results.innerHTML = `<p class="form-error">${escapeHtml(e2.message)}</p>`;
        }
      });
      card.querySelector(".fs-save").addEventListener("click", async () => {
        err.hidden = true;
        try {
          await api.setFuelUser(Number(card.dataset.user), {
            fuel_l_per_100km: card.querySelector(".fs-cons").value === "" ? null : Number(card.querySelector(".fs-cons").value),
            home_address: home.value || null,
            home_lat: lat.value === "" ? null : Number(lat.value),
            home_lng: lng.value === "" ? null : Number(lng.value),
          });
          card.querySelector(".fuel-home-status").textContent = lat.value ? `📍 ${t("fuel_home_saved")}` : t("fuel_home_missing");
          card.querySelector(".fs-save").textContent = `✓ ${t("fuel_saved")}`;
        } catch (e3) {
          err.textContent = e3.message;
          err.hidden = false;
        }
      });
    });
  }

  await load();
}
