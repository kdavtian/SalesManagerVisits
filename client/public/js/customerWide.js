// The customer card on a wide desktop window (>= 1400 px; docs/desktop-roadmap.md, step 3): the same card the phone shows,
// rearranged into three columns -- left: facts, a small map, the stat tiles, the actions, the products; middle: the whole visit
// history; right: tasks, next visit, orders (app + Excel in one list), payments and files. Nothing here runs on a phone or
// inside the narrow customer panel docked beside the Customers table: the card keeps its own layout there. A window
// dragged below the width puts every block back where the phone layout has it.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml, formatAmd, formatDateDMY, formatDayMonth, parseDateOnly } from "./util.js";
import { loadWithCache } from "./listCache.js";
import { paymentsSource, photosSource } from "./customerCardData.js";
import { isWide } from "./deskTable.js";

const ORDER_ROWS = 8;
const PAYMENT_ROWS = 6;
const PHOTO_THUMBS = 8;

// The card is drawn into the page (not the 560 px customer panel) and the window is wide enough.
export const wideCard = (container) => isWide() && !container.closest(".customer-panel");

/**
 * container: the card's .customer-detail-view (already painted).
 * ctx: { customer, erpOrders, navigate, openPayments(), openFiles(), openErpOrder(row), openAppOrder(id) }
 */
export function layoutCustomerWide(container, ctx) {
  if (container.closest(".customer-panel")) return;
  const media = window.matchMedia?.("(min-width: 1400px)");
  let moved = null; // [{ node, parent, next }] in the order they were moved, to put them back
  let extras = [];

  const apply = () => {
    if (!container.isConnected) {
      media?.removeEventListener?.("change", apply);
      return;
    }
    if (wideCard(container) && !moved) build();
    else if (!wideCard(container) && moved) restore();
  };

  function build() {
    const pick = (sel) => container.querySelector(sel);
    const left = [pick("#open-visit-slot"), pick(".detail-facts-card"), "MAP", pick("#pending-request-slot"), pick(".detail-stat-grid"), pick(".detail-actions-grid"), pick(".product-chips-heading"), pick("#product-chips-card"), pick("#potential-slot")];
    const mid = [pick("#visit-history-anchor"), pick("#checkin-history")];
    const right = [pick("#customer-tasks-slot"), pick(".next-visit-card"), "ORDERS", "PAYMENTS", "FILES", pick("#customer-docs-slot")];
    moved = [];
    extras = [];
    const grid = document.createElement("div");
    grid.className = "cd-wide";
    const col = (cls, nodes) => {
      const el = document.createElement("div");
      el.className = `cd-wcol ${cls}`;
      for (const n of nodes) {
        if (!n) continue;
        if (typeof n === "string") {
          const panel = makePanel(n);
          if (panel) el.appendChild(panel);
          continue;
        }
        moved.push({ node: n, parent: n.parentNode, next: n.nextSibling });
        el.appendChild(n);
      }
      return el;
    };
    grid.append(col("cd-wcol-left", left), col("cd-wcol-mid", mid), col("cd-wcol-right", right));
    container.appendChild(grid);
    container.classList.add("cd-three");
    extras.push(grid);
  }

  function restore() {
    for (let i = moved.length - 1; i >= 0; i--) {
      const { node, parent, next } = moved[i];
      if (next && next.parentNode === parent) parent.insertBefore(node, next);
      else parent.appendChild(node);
    }
    extras.forEach((el) => el.remove());
    container.classList.remove("cd-three");
    moved = null;
    extras = [];
  }

  function makePanel(kind) {
    if (kind === "MAP") return mapPanel(ctx);
    if (kind === "ORDERS") return ordersPanel(ctx);
    if (kind === "PAYMENTS") return paymentsPanel(ctx);
    if (kind === "FILES") return filesPanel(ctx);
    return null;
  }

  apply();
  media?.addEventListener?.("change", apply);
}

function panelShell(cls, title, linkLabel) {
  const el = document.createElement("section");
  el.className = `cd-panel ${cls}`;
  el.innerHTML = `
    <div class="cd-panel-head">
      <h2 class="section-title section-title-inline">${escapeHtml(title)}</h2>
      ${linkLabel ? `<button type="button" class="cd-panel-link" data-panel-all>${escapeHtml(linkLabel)}</button>` : ""}
    </div>
    <div class="card cd-panel-body"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  return el;
}

/* ---------- Orders: the app's orders Excel does not have yet + the Excel orders of the last 3 months ---------- */
function ordersPanel({ customer, erpOrders, navigate, openErpOrder, openAppOrder }) {
  const el = panelShell("cd-panel-orders", t("all_orders"), t("view_all"));
  el.querySelector("[data-panel-all]").addEventListener("click", () => navigate(`#/customers/${customer.id}/orders`));
  const body = el.querySelector(".cd-panel-body");
  const excel = (Array.isArray(erpOrders) ? erpOrders : []).map((o) => ({ kind: "erp", date: o.order_date, code: o.order_id, amount: o.total_amd, row: o }));
  const paint = (appRows) => {
    if (!body.isConnected && !el.isConnected) return;
    const rows = [...appRows, ...excel].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, ORDER_ROWS);
    if (!rows.length) {
      body.innerHTML = `<p class="muted cd-panel-empty">${t("no_orders_found")}</p>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r, i) => `<button type="button" class="cd-row" data-order-row="${i}">
          <span class="cd-row-date">${escapeHtml(dayText(r.date))}</span>
          <span class="cd-row-main"><span class="cd-row-code">${escapeHtml(r.code || "")}</span>${r.badge || ""}</span>
          <span class="cd-row-amount">${formatAmd(Number(r.amount) || 0)}</span>
        </button>`
      )
      .join("");
    body.querySelectorAll("[data-order-row]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const r = rows[Number(btn.dataset.orderRow)];
        if (r.kind === "erp") openErpOrder(r.row);
        else openAppOrder(r.id);
      })
    );
  };
  paint([]);
  api
    .listOrders({ customer_id: customer.id }, { fresh: true })
    .then(async (result) => {
      const open = (result.rows ?? []).filter((o) => !o.erp_matched_order_id && !o.cancelled_at && !o.delivered_from_erp);
      if (!open.length) return;
      const { orderStatusMeta } = await import("./orderDetailSheet.js");
      paint(
        open.map((o) => {
          const meta = orderStatusMeta(o);
          return { kind: "app", id: o.id, date: o.created_at, code: o.order_code || `#${o.id}`, amount: o.total_amd, badge: `<span class="badge ${meta.cls}">${escapeHtml(t(meta.key))}</span>` };
        })
      );
    })
    .catch(() => {});
  return el;
}

/* ---------- Payments received: Excel Cashflow + app payments (the same list the debt tile opens) ---------- */
function paymentsPanel({ customer, openPayments }) {
  const el = panelShell("cd-panel-payments", t("payments_received_title"), t("view_all"));
  el.querySelector("[data-panel-all]").addEventListener("click", () => openPayments());
  const body = el.querySelector(".cd-panel-body");
  const source = paymentsSource(customer.id);
  loadWithCache(source.key, source.fetch, (data) => {
    const rows = data?.rows ?? [];
    if (!rows.length) {
      body.innerHTML = `<p class="muted cd-panel-empty">${t("payments_received_empty")}</p>`;
      return;
    }
    body.innerHTML =
      rows
        .slice(0, PAYMENT_ROWS)
        .map(
          (r) => `<button type="button" class="cd-row" data-payment-row>
            <span class="cd-row-date">${escapeHtml(dayText(r.date))}</span>
            <span class="cd-row-main">${
              r.source === "excel"
                ? `<span class="badge badge-neutral">${t("payments_source_excel")}</span>`
                : `<span class="badge ${r.status === "approved" ? "badge-success" : "badge-warning"}">${t("payments_source_app")}</span>`
            }</span>
            <span class="cd-row-amount">${formatAmd(r.amount_amd)}</span>
          </button>`
        )
        .join("") + `<div class="cd-row cd-row-total"><span>${t("total")}</span><span></span><span class="cd-row-amount">${formatAmd(data.total_amd)}</span></div>`;
    body.querySelectorAll("[data-payment-row]").forEach((b) => b.addEventListener("click", () => openPayments()));
  }).catch((err) => {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  });
  return el;
}

/* ---------- Files: visit photos and documents as thumbnails ---------- */
function filesPanel({ customer, openFiles }) {
  const el = panelShell("cd-panel-files", t("customer_files"), t("view_all"));
  el.querySelector("[data-panel-all]").addEventListener("click", () => openFiles());
  const body = el.querySelector(".cd-panel-body");
  const source = photosSource(customer.id);
  Promise.all([loadOnce(source), api.customerFiles(customer.id).catch(() => [])])
    .then(async ([photos, files]) => {
      photos = Array.isArray(photos) ? photos : [];
      files = Array.isArray(files) ? files : [];
      if (!photos.length && !files.length) {
        body.innerHTML = `<p class="muted cd-panel-empty">${t("no_photos_yet")}</p>`;
        return;
      }
      body.innerHTML = `<div class="cd-thumbs">
        ${files
          .slice(0, 4)
          .map(
            (f, i) =>
              `<button type="button" class="cd-thumb" data-file="${i}" title="${escapeHtml(formatDateDMY(f.created_at))}">${
                f.mime === "application/pdf" ? `<span class="files-blank-pdf">PDF</span>` : `<img src="${api.fileUrl(f, { thumb: true })}" alt="" loading="lazy" decoding="async" />`
              }</button>`
          )
          .join("")}
        ${photos
          .slice(0, PHOTO_THUMBS)
          .map((p, i) => `<button type="button" class="cd-thumb" data-photo="${i}"><img src="${api.checkinPhotoThumbUrl(p.id)}" alt="" loading="lazy" decoding="async" /></button>`)
          .join("")}
      </div>
      <p class="muted cd-thumbs-count">${t("files_photos")}: ${photos.length} · ${t("files_documents")}: ${files.length}</p>`;
      const urls = photos.map((p) => api.checkinPhotoByIdUrl(p.id));
      body.querySelectorAll("[data-photo]").forEach((b) =>
        b.addEventListener("click", async () => (await import("./photoLightbox.js")).openPhotoLightbox(urls, Number(b.dataset.photo)))
      );
      body.querySelectorAll("[data-file]").forEach((b) => b.addEventListener("click", async () => (await import("./fileViewer.js")).openFileViewer(files, Number(b.dataset.file))));
    })
    .catch((err) => {
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    });
  return el;
}

// One answer from a listCache source: the saved copy when there is one (the fresh copy refreshes it for next time).
function loadOnce(source) {
  return new Promise((resolve, reject) => {
    let done = false;
    loadWithCache(source.key, source.fetch, (data) => {
      if (done) return;
      done = true;
      resolve(data);
    }).catch((err) => !done && reject(err));
  });
}

/* ---------- A small map under the facts: this customer's pin and the customers around it ---------- */
function mapPanel({ customer, navigate }) {
  const lat = Number(customer.lat);
  const lng = Number(customer.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return null;
  const el = document.createElement("div");
  el.className = "card cd-mini-map";
  el.innerHTML = `<div class="cd-mini-map-canvas" role="img" aria-label="${escapeHtml(t("show_on_map"))}"></div>
    <button type="button" class="cd-mini-map-open">${icons.pin}<span>${escapeHtml(t("show_on_map"))}</span></button>`;
  el.querySelector(".cd-mini-map-open").addEventListener("click", () => navigate(`#/map?customer=${customer.id}`));
  // drawn once the card is on screen and idle: the map script is only fetched on a wide window
  const draw = async () => {
    const canvas = el.querySelector(".cd-mini-map-canvas");
    if (!canvas.isConnected) return;
    try {
      const { ensureLeaflet } = await import("./leafletLoader.js");
      await ensureLeaflet();
    } catch {
      el.remove();
      return;
    }
    if (!canvas.isConnected) return;
    const L = window.L;
    const map = L.map(canvas, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false, attributionControl: true, rotate: false, rotateControl: false, touchRotate: false, compassBearing: false }).setView([lat, lng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc", attribution: "© OpenStreetMap" }).addTo(map);
    map.attributionControl?.setPrefix(false);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0a84ff";
    const d = 0.008;
    try {
      const near = await api.listCustomers({ min_lat: lat - d, max_lat: lat + d, min_lng: lng - d * 1.3, max_lng: lng + d * 1.3 });
      for (const c of near) {
        if (c.id === customer.id || c.lat == null || c.lng == null) continue;
        L.circleMarker([Number(c.lat), Number(c.lng)], { radius: 5, weight: 1.5, color: "#ffffff", fillColor: "#8e8e93", fillOpacity: 0.9, className: "cd-mini-map-near" })
          .bindTooltip(String(c.name || ""), { direction: "top" })
          .addTo(map);
      }
    } catch {
      /* the customer's own pin is enough */
    }
    L.circleMarker([lat, lng], { radius: 9, weight: 3, color: "#ffffff", fillColor: accent, fillOpacity: 1, className: "cd-mini-map-self" }).addTo(map);
    // the grid may still be settling when the map is created
    setTimeout(() => canvas.isConnected && map.invalidateSize(), 150);
  };
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 300)))(draw);
  return el;
}

// "27 Oct" (the year only when it is not this year), the way the card's tiles write dates. An Excel order or payment has a plain
// date; an app order a timestamp, shown as the viewer's own calendar day.
function dayText(value) {
  if (!value) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value).slice(0, 10)) && !String(value).includes("T") ? parseDateOnly(String(value).slice(0, 10)) : new Date(value);
  if (!d || Number.isNaN(d.getTime())) return "";
  return formatDayMonth(d, { year: d.getFullYear() !== new Date().getFullYear() });
}
