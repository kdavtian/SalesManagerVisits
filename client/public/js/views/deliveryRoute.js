import { api } from "../api.js";
import { escapeHtml, formatAmd, getCurrentPosition } from "../util.js";
import { t } from "../i18n.js";
import { state } from "../state.js";

const canPlan = () => state.user.role === "delivery_manager" || state.user.role === "admin";
const canDrive = () => state.user.role === "delivery_manager" || state.user.role === "admin";

function stopMarkerIcon(n) {
  return L.divIcon({
    className: "route-stop-marker",
    html: `<span>${n}</span>`,
    iconSize: [26, 26],
  });
}

function paintRouteMap(el, stops) {
  if (!stops.length) {
    el.innerHTML = `<p class="empty-state">${t("delivery_route_empty")}</p>`;
    return;
  }
  el.innerHTML = "";
  const map = L.map(el, { zoomControl: true, attributionControl: false }).setView([stops[0].lat, stops[0].lng], 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);
  const latlngs = [];
  stops.forEach((s, i) => {
    if (s.lat == null || s.lng == null) return;
    L.marker([s.lat, s.lng], { icon: stopMarkerIcon(i + 1) }).addTo(map).bindPopup(escapeHtml(s.customer_name));
    latlngs.push([s.lat, s.lng]);
  });
  if (latlngs.length > 1) {
    L.polyline(latlngs, { color: "#2563eb", weight: 3, opacity: 0.7 }).addTo(map);
    map.fitBounds(latlngs, { padding: [24, 24] });
  }
  setTimeout(() => map.invalidateSize(), 50);
}

export async function renderDelivery(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_delivery")}</h1></div>
      </div>
      ${
        canPlan()
          ? `<div class="segmented" id="delivery-tabs">
        <button type="button" class="chip chip-active" data-tab="my-route">${t("delivery_tab_my_route")}</button>
        <button type="button" class="chip" data-tab="plan">${t("delivery_tab_plan")}</button>
      </div>`
          : ""
      }
      <p class="form-error" id="delivery-error" hidden></p>
      <div id="delivery-content" style="margin-top:12px;"></div>
    </div>
  `;
  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const contentEl = container.querySelector("#delivery-content");
  const errorEl = container.querySelector("#delivery-error");
  let activeTab = "my-route";

  container.querySelector("#delivery-tabs")?.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll("#delivery-tabs [data-tab]").forEach((b) => b.classList.toggle("chip-active", b.dataset.tab === activeTab));
      load();
    });
  });

  async function load() {
    errorEl.hidden = true;
    contentEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (activeTab === "plan") await loadPlanner();
      else await loadMyRoute();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      contentEl.innerHTML = "";
    }
  }

  // --- My Route (driver view) ------------------------------------------
  async function loadMyRoute() {
    if (!canDrive()) {
      contentEl.innerHTML = `<p class="empty-state">${t("not_allowed")}</p>`;
      return;
    }
    const route = await api.getMyRoute();
    if (!route || !route.stops.length) {
      contentEl.innerHTML = `<p class="empty-state">${t("delivery_route_empty")}</p>`;
      return;
    }
    contentEl.innerHTML = `
      <div id="route-map" style="height:220px;border-radius:12px;overflow:hidden;margin-bottom:12px;"></div>
      <div class="card-list" id="route-stops-list"></div>
    `;
    paintRouteMap(contentEl.querySelector("#route-map"), route.stops);
    const listEl = contentEl.querySelector("#route-stops-list");
    listEl.innerHTML = route.stops
      .map(
        (s, i) => `
      <div class="card ${s.completed_at ? "route-stop-done" : ""}">
        <div class="order-detail-ids"><span>${t("order_id_label")}: ${escapeHtml(s.order_code || "")}</span></div>
        <strong>${i + 1}. ${escapeHtml(s.customer_name)}</strong>
        <p class="muted">${escapeHtml(s.address || "")}</p>
        <p><strong>${formatAmd(Number(s.total_amd))}</strong></p>
        ${
          s.completed_at
            ? `<span class="badge ${s.order_status === "delivered" ? "badge-success" : "badge-warning"}">${t(s.order_status === "delivered" ? "order_status_delivered" : "order_status_returned")}</span>`
            : `<button type="button" class="btn btn-primary btn-block" data-open-stop="${s.order_id}">${t("delivery_open_stop")}</button>`
        }
      </div>`
      )
      .join("");
    listEl.querySelectorAll("[data-open-stop]").forEach((btn) => {
      btn.addEventListener("click", () => openDeliverySheet(Number(btn.dataset.openStop), route.stops.find((s) => s.order_id === Number(btn.dataset.openStop))));
    });
  }

  // --- Planner (delivery_manager/admin) ---------------------------------
  // The planner auto-pools every packed_stock_out order not already on a
  // route -- no manual checkbox selection (spec section 4). The driver
  // picker plus a single "Plan/Refresh Route" action is all that's left.
  async function loadPlanner() {
    const [packedOrders, drivers] = await Promise.all([api.listPackedOrders(), api.listDrivers()]);
    contentEl.innerHTML = `
      <label class="form-label" for="plan-driver">${t("delivery_choose_driver")}</label>
      <select id="plan-driver">${drivers.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")}</select>
      <p class="muted" style="margin:10px 0 4px;">${t("delivery_waiting_orders_count")}: ${packedOrders.filter((o) => o.lat != null).length}</p>
      ${
        packedOrders.some((o) => o.lat == null)
          ? `<p class="muted">${packedOrders.filter((o) => o.lat == null).length} ${t("delivery_no_location")}</p>`
          : ""
      }
      <button type="button" class="btn btn-primary btn-block" id="plan-route-btn" style="margin-top:12px;" ${packedOrders.some((o) => o.lat != null) ? "" : "disabled"}>${t("delivery_plan_route_btn")}</button>
      <div id="planned-route-result" style="margin-top:16px;"></div>
    `;
    contentEl.querySelector("#plan-route-btn").addEventListener("click", async () => {
      const btn = contentEl.querySelector("#plan-route-btn");
      btn.disabled = true;
      btn.textContent = t("saving");
      try {
        let start = null;
        try {
          start = await getCurrentPosition();
        } catch {
          start = null;
        }
        const route = await api.planRoute({
          driver_id: Number(contentEl.querySelector("#plan-driver").value),
          start_lat: start?.lat,
          start_lng: start?.lng,
        });
        const resultEl = contentEl.querySelector("#planned-route-result");
        resultEl.innerHTML = `
          <h2 class="section-title">${t("delivery_route_planned")}</h2>
          ${route.used_osrm === false ? `<span class="badge badge-warning">${t("delivery_osrm_fallback_badge")}</span>` : ""}
          <div id="planned-route-map" style="height:220px;border-radius:12px;overflow:hidden;margin:8px 0 12px;"></div>
          <div class="card-list" id="planned-route-list"></div>
        `;
        paintRouteMap(resultEl.querySelector("#planned-route-map"), route.stops);
        renderReorderableList(resultEl.querySelector("#planned-route-list"), route);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = t("delivery_plan_route_btn");
      }
    });
  }

  // Drag-reorder using native HTML5 drag events -- simplest touch-friendly
  // approach without pulling in a library.
  function renderReorderableList(listEl, route) {
    listEl.innerHTML = route.stops
      .map(
        (s, i) => `
      <div class="card route-stop-draggable" draggable="true" data-order-id="${s.order_id}">
        <span class="route-stop-handle">☰ ${i + 1}</span>
        <strong>${escapeHtml(s.customer_name)}</strong>
        <span class="muted">${escapeHtml(s.address || "")}</span>
      </div>`
      )
      .join("");

    let draggedEl = null;
    listEl.querySelectorAll(".route-stop-draggable").forEach((row) => {
      row.addEventListener("dragstart", () => {
        draggedEl = row;
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", async () => {
        row.classList.remove("dragging");
        const orderIds = Array.from(listEl.querySelectorAll(".route-stop-draggable")).map((r) => Number(r.dataset.orderId));
        try {
          await api.reorderRouteStops(route.id, orderIds);
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!draggedEl || draggedEl === row) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY - rect.top > rect.height / 2;
        row.parentNode.insertBefore(draggedEl, after ? row.nextSibling : row);
      });
    });
  }

  // --- Delivery confirm sheet (driver) -----------------------------------
  async function openDeliverySheet(orderId, stop) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

    let snapshot;
    try {
      snapshot = await api.getOrderDebtSnapshot(orderId);
    } catch (err) {
      overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }

    const debtBefore = snapshot.debt_before_amd;
    let amountCollected = 0;

    function newBalanceHtml() {
      if (debtBefore == null) return `<p class="muted">${t("delivery_debt_unknown")}</p>`;
      const newBalance = debtBefore + snapshot.order_amount_amd - amountCollected;
      return `<p>${t("delivery_new_balance")}: <strong>${formatAmd(newBalance)}</strong></p>`;
    }

    overlay.querySelector(".sheet").innerHTML = `
      <h2>${escapeHtml(stop.customer_name)}</h2>
      <p class="muted">${escapeHtml(stop.address || "")}</p>
      <div class="card" style="margin:12px 0;">
        ${debtBefore != null ? `<p>${t("delivery_debt_before")}: <strong>${formatAmd(debtBefore)}</strong></p>` : ""}
        <p>${t("delivery_order_amount")}: <strong>${formatAmd(snapshot.order_amount_amd)}</strong></p>
        <label class="form-label" for="amount-collected-input">${t("delivery_amount_collected")}</label>
        <input type="number" id="amount-collected-input" min="0" step="1" value="0" inputmode="numeric" />
        <div class="segmented" id="payment-method-row">
          <button type="button" class="chip chip-active" data-method="cash">${t("payment_method_cash")}</button>
          <button type="button" class="chip" data-method="other">${t("payment_method_other")}</button>
        </div>
        <div id="new-balance-display">${newBalanceHtml()}</div>
      </div>
      <label class="form-label">${t("delivery_signature_label")}</label>
      <canvas id="signature-canvas" width="320" height="150" style="width:100%;touch-action:none;border:1px solid var(--border-color, #ccc);border-radius:8px;background:#fff;"></canvas>
      <button type="button" class="btn" id="signature-clear-btn" style="margin-top:6px;">${t("delivery_clear_signature")}</button>
      <p class="form-error" id="delivery-sheet-error" hidden></p>
      <div class="sheet-actions" style="margin-top:14px;">
        <button type="button" class="btn btn-danger" id="delivery-fail-btn">${t("delivery_failed_btn")}</button>
        <button type="button" class="btn btn-primary" id="delivery-confirm-btn">${t("delivery_confirm_btn")}</button>
      </div>
    `;

    const amountInput = overlay.querySelector("#amount-collected-input");
    amountInput.addEventListener("input", () => {
      amountCollected = Number(amountInput.value) || 0;
      overlay.querySelector("#new-balance-display").innerHTML = newBalanceHtml();
    });

    let paymentMethod = "cash";
    overlay.querySelectorAll("#payment-method-row [data-method]").forEach((btn) => {
      btn.addEventListener("click", () => {
        paymentMethod = btn.dataset.method;
        overlay.querySelectorAll("#payment-method-row [data-method]").forEach((b) => b.classList.toggle("chip-active", b === btn));
      });
    });

    // Minimal canvas signature pad -- pointer events cover mouse, touch and
    // pen with one listener set.
    const canvas = overlay.querySelector("#signature-canvas");
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111";
    let drawing = false;
    let hasSignature = false;
    function pos(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
    }
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      hasSignature = true;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    canvas.addEventListener("pointerup", () => (drawing = false));
    canvas.addEventListener("pointercancel", () => (drawing = false));
    overlay.querySelector("#signature-clear-btn").addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasSignature = false;
    });

    const sheetErrorEl = overlay.querySelector("#delivery-sheet-error");

    overlay.querySelector("#delivery-fail-btn").addEventListener("click", async () => {
      if (!confirm(t("delivery_confirm_fail_prompt"))) return;
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await api.failDelivery(orderId);
        overlay.remove();
        load();
      } catch (err) {
        sheetErrorEl.textContent = err.message;
        sheetErrorEl.hidden = false;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });

    overlay.querySelector("#delivery-confirm-btn").addEventListener("click", async () => {
      if (!hasSignature) {
        sheetErrorEl.textContent = t("delivery_signature_required");
        sheetErrorEl.hidden = false;
        return;
      }
      overlay.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const formData = new FormData();
        formData.append("signature", blob, "signature.png");
        formData.append("amount_collected_amd", String(amountCollected));
        formData.append("payment_method", paymentMethod);
        await api.confirmDelivery(orderId, formData);
        overlay.remove();
        load();
      } catch (err) {
        sheetErrorEl.textContent = err.message;
        sheetErrorEl.hidden = false;
        overlay.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
  }

  load();
}
