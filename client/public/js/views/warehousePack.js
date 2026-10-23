// The warehouse manager's Pack screen (owner, 2026-10-23): "what do I put in the boxes now". Three tabs: Orders (one big card per order, tick the lines
// while picking, one big Packed button, a Problem button), By product (the pick list across all orders, short stock in red), Packed (what waits for the
// driver). Replaces the staging list + the prompt() for stock issues of the classic screen, which stays available for comparison.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { appBadgeHtml } from "../orderDetailSheet.js";
import { escapeHtml, formatAmd, showToast, activateDialog } from "../util.js";
import { formatAge } from "../opsShell.js";
import { compareProducts, normalizeUnitLabel } from "../productSort.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const PROBLEMS = ["out", "wrong", "damaged", "other"];
const TICKS_KEY = "fieldvisits_pack_ticks";

// The ticks live on the phone only (a picking aid): { orderId: [lineIndex...] }, forgotten for orders that are no longer in the list.
function loadTicks() {
  try {
    return JSON.parse(sessionStorage.getItem(TICKS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function saveTicks(ticks) {
  try {
    sessionStorage.setItem(TICKS_KEY, JSON.stringify(ticks));
  } catch {
    /* private mode: ticks last until the screen is left */
  }
}

// Product names usually start with the brand already ("Castrol Magnatec ..."): show the brand only when the name does not carry it.
export function lineLabel(i) {
  const brand = i.brand && !String(i.product_name).toLowerCase().startsWith(String(i.brand).toLowerCase()) ? `${i.brand} · ` : "";
  return `${brand}${i.product_name}${i.size ? ` · ${normalizeUnitLabel(i.size)}` : ""}`;
}

export async function renderWarehousePack(root, navigate, tab = "orders") {
  let active = ["orders", "product", "packed"].includes(tab) ? tab : "orders";
  const ticks = loadTicks();
  root.innerHTML = `
    <div class="ops-view">
      <h1 class="ops-title">${t("ops_tab_pack")}</h1>
      <div class="ops-tabs" role="tablist">
        ${[["orders", "ops_tab_orders"], ["product", "ops_tab_by_product"], ["packed", "ops_tab_packed"]]
          .map(([id, key]) => `<button type="button" role="tab" class="ops-tab ${id === active ? "ops-tab-active" : ""}" data-tab="${id}" aria-selected="${id === active}">${t(key)}<span class="ops-tab-count" data-count="${id}"></span></button>`)
          .join("")}
      </div>
      <p class="form-error" id="pack-error" hidden></p>
      <div id="pack-body" class="ops-stack"></div>
    </div>`;
  const body = root.querySelector("#pack-body");
  const errorEl = root.querySelector("#pack-error");
  const setCount = (id, n) => {
    const el = root.querySelector(`[data-count="${id}"]`);
    if (el) el.textContent = n ? String(n) : "";
  };
  root.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      active = btn.dataset.tab;
      root.querySelectorAll("[data-tab]").forEach((b) => {
        b.classList.toggle("ops-tab-active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      });
      load();
    })
  );

  let alive = true;
  let loadSeq = 0;

  async function load() {
    const seq = ++loadSeq;
    errorEl.hidden = true;
    if (!body.children.length) body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    try {
      if (active === "orders") await loadOrders(seq);
      else if (active === "product") await loadByProduct(seq);
      else await loadPacked(seq);
    } catch (err) {
      if (seq !== loadSeq || !alive) return;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      body.innerHTML = "";
    }
  }

  // ---- Orders -------------------------------------------------------------------------------------------------------
  async function loadOrders(seq) {
    const [orders, pick] = await Promise.all([api.getStagingList(), api.getPickList()]);
    if (seq !== loadSeq || !alive) return;
    setCount("orders", orders.length);
    const stock = new Map(pick.map((p) => [p.product_id, { have: p.stock_qty, need: p.total_quantity }]));
    // forget ticks of orders that left the list
    const ids = new Set(orders.map((o) => String(o.id)));
    for (const k of Object.keys(ticks)) if (!ids.has(k)) delete ticks[k];
    saveTicks(ticks);
    if (!orders.length) {
      body.innerHTML = `<p class="ops-empty">✓ ${t("ops_pack_empty")}</p>`;
      return;
    }
    body.innerHTML = orders.map((o) => orderCardHtml(o, stock)).join("");
    wireOrders(orders);
  }

  function orderCardHtml(o, stock) {
    const done = new Set(ticks[o.id] || []);
    const waitMin = o.confirmed_at ? minutesSince(o.confirmed_at) : null;
    return `
      <article class="ops-order" data-order="${o.id}">
        <header class="ops-order-head">
          <strong class="ops-order-customer">${escapeHtml(o.customer_name)}</strong>
          <span class="ops-order-badges">${appBadgeHtml(o)}${waitMin != null ? `<span class="badge ${waitMin > 240 ? "badge-danger" : "badge-neutral"}">${escapeHtml(fill("ops_waiting", { t: formatAge(waitMin) }))}</span>` : ""}</span>
        </header>
        <p class="muted ops-order-sub">${escapeHtml([o.order_code, o.address].filter(Boolean).join(" · "))}</p>
        <ul class="ops-lines">
          ${o.items
            .map((i, idx) => {
              const s = i.product_id ? stock.get(i.product_id) : null;
              const short = s && s.have != null && s.need > s.have;
              return `
            <li>
              <label class="ops-line ${done.has(idx) ? "ops-line-done" : ""}">
                <input type="checkbox" data-line="${idx}" ${done.has(idx) ? "checked" : ""} />
                <span class="ops-line-name">${escapeHtml(lineLabel(i))}${short ? `<small class="ops-short">${escapeHtml(fill("ops_only_in_stock", { n: s.have }))} · ${escapeHtml(fill("ops_need_total", { n: s.need }))}</small>` : ""}</span>
                <span class="ops-line-qty">× ${i.quantity}</span>
              </label>
            </li>`;
            })
            .join("")}
        </ul>
        <p class="ops-progress" data-progress>${escapeHtml(fill("ops_lines_checked", { a: done.size, b: o.items.length }))}</p>
        <div class="ops-actions">
          <button type="button" class="btn btn-primary ops-pack-btn" data-pack="${o.id}">${t("ops_pack_btn")}</button>
          <button type="button" class="btn ops-problem-btn" data-problem="${o.id}">${t("ops_problem_btn")}</button>
        </div>
      </article>`;
  }

  function wireOrders(orders) {
    const byId = new Map(orders.map((o) => [String(o.id), o]));
    body.querySelectorAll(".ops-order").forEach((card) => {
      const id = card.dataset.order;
      const order = byId.get(id);
      card.querySelectorAll("input[data-line]").forEach((cb) =>
        cb.addEventListener("change", () => {
          const set = new Set(ticks[id] || []);
          if (cb.checked) set.add(Number(cb.dataset.line));
          else set.delete(Number(cb.dataset.line));
          ticks[id] = [...set];
          saveTicks(ticks);
          cb.closest(".ops-line").classList.toggle("ops-line-done", cb.checked);
          card.querySelector("[data-progress]").textContent = fill("ops_lines_checked", { a: set.size, b: order.items.length });
        })
      );
      card.querySelector("[data-pack]").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.markOrderPacked(id);
          delete ticks[id];
          saveTicks(ticks);
          showToast(t("ops_packed_toast"));
          window.dispatchEvent(new Event("warehouse-changed"));
          await load();
        } catch (err) {
          showToast(err.message);
          btn.disabled = false;
        }
      });
      card.querySelector("[data-problem]").addEventListener("click", () => openProblemSheet(order));
    });
  }

  // "Problem": a reason (chips) + optional details; the order goes back to the sales rep with that note.
  function openProblemSheet(order) {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("ops_problem_title"))}">
        <h2>${t("ops_problem_title")}</h2>
        <p class="muted">${escapeHtml(order.customer_name)}${order.order_code ? ` · ${escapeHtml(order.order_code)}` : ""}</p>
        <div class="ops-reasons" role="group">
          ${PROBLEMS.map((p) => `<button type="button" class="btn ops-reason" data-reason="${p}" aria-pressed="false">${t(`ops_problem_${p}`)}</button>`).join("")}
        </div>
        <label class="ops-problem-note">${t("ops_problem_note")}<textarea rows="2" id="problem-note"></textarea></label>
        <p class="form-error" id="problem-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="problem-cancel">${t("cancel")}</button>
          <button type="button" class="btn btn-danger" id="problem-send" disabled>${t("ops_problem_send")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    let reason = null;
    const send = overlay.querySelector("#problem-send");
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    overlay.querySelector("#problem-cancel").addEventListener("click", close);
    overlay.querySelectorAll("[data-reason]").forEach((btn) =>
      btn.addEventListener("click", () => {
        reason = btn.dataset.reason;
        overlay.querySelectorAll("[data-reason]").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
          b.classList.toggle("btn-primary", b === btn);
        });
        send.disabled = false;
      })
    );
    send.addEventListener("click", async () => {
      const details = overlay.querySelector("#problem-note").value.trim();
      const err = overlay.querySelector("#problem-error");
      if (reason === "other" && !details) {
        err.textContent = t("ops_problem_other_needs_text");
        err.hidden = false;
        return;
      }
      send.disabled = true;
      try {
        await api.flagOrderStockIssue(order.id, details ? `${t(`ops_problem_${reason}`)}: ${details}` : t(`ops_problem_${reason}`));
        close();
        delete ticks[order.id];
        saveTicks(ticks);
        showToast(t("ops_problem_sent"));
        window.dispatchEvent(new Event("warehouse-changed"));
        await load();
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
        send.disabled = false;
      }
    });
  }

  // ---- By product ---------------------------------------------------------------------------------------------------
  async function loadByProduct(seq) {
    const rows = (await api.getPickList()).sort((a, b) =>
      compareProducts({ name: a.product_name, brand: a.brand, family: a.family, unit: a.size }, { name: b.product_name, brand: b.brand, family: b.family, unit: b.size })
    );
    if (seq !== loadSeq || !alive) return;
    setCount("product", rows.length);
    if (!rows.length) {
      body.innerHTML = `<p class="ops-empty">✓ ${t("ops_pack_empty")}</p>`;
      return;
    }
    body.innerHTML = `<div class="ops-products">${rows
      .map((r) => {
        const short = r.stock_qty != null && r.total_quantity > r.stock_qty;
        return `
        <div class="ops-product ${short ? "ops-product-short" : ""}">
          <div class="ops-product-name"><strong>${escapeHtml(r.product_name)}</strong><span class="muted">${escapeHtml([r.brand, r.size && normalizeUnitLabel(r.size)].filter(Boolean).join(" · "))} · ${escapeHtml(fill("ops_orders_n", { n: r.order_count }))}</span>${
          r.stock_qty != null ? `<small class="${short ? "ops-short" : "muted"}">${escapeHtml(t("ops_in_stock"))}: ${r.stock_qty}</small>` : ""
        }</div>
          <span class="ops-product-qty">× ${r.total_quantity}</span>
        </div>`;
      })
      .join("")}</div>`;
  }

  // ---- Packed (waiting for the driver) -------------------------------------------------------------------------------
  async function loadPacked(seq) {
    const rows = await api.getWarehousePackedList();
    if (seq !== loadSeq || !alive) return;
    setCount("packed", rows.length);
    if (!rows.length) {
      body.innerHTML = `<p class="ops-empty">${t("ops_packed_empty")}</p>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (o) => `
      <article class="ops-order ops-order-packed">
        <header class="ops-order-head"><strong class="ops-order-customer">${escapeHtml(o.customer_name)}</strong><span class="ops-order-badges">${appBadgeHtml(o)}<span class="badge badge-neutral">${escapeHtml(fill("ops_waiting", { t: formatAge(minutesSince(o.packed_at)) }))}</span></span></header>
        <p class="muted ops-order-sub">${escapeHtml([o.order_code, formatAmd(Number(o.total_amd))].filter(Boolean).join(" · "))}</p>
        <p class="${o.driver_name ? "ops-route-ok" : "ops-route-none"}">${o.driver_name ? escapeHtml(fill("ops_on_route", { driver: o.driver_name })) : t("ops_no_route")}</p>
      </article>`
      )
      .join("");
  }

  // The counts in the tab labels fill themselves as each tab loads; load the other two quietly once so they show from the start.
  await load();
  const quiet = async () => {
    try {
      const [orders, pick, packed] = await Promise.all([api.getStagingList(), api.getPickList(), api.getWarehousePackedList()]);
      if (!alive) return;
      setCount("orders", orders.length);
      setCount("product", pick.length);
      setCount("packed", packed.length);
    } catch {
      /* the counts are a nicety */
    }
  };
  quiet();
  const onChanged = () => load();
  window.addEventListener("orders-changed", onChanged);
  const timer = setInterval(() => !document.hidden && load(), 30000);
  return () => {
    alive = false;
    clearInterval(timer);
    window.removeEventListener("orders-changed", onChanged);
  };
}
