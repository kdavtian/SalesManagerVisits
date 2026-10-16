// The order menu: how do you want to start this order? Opened by a long press on "New order" (customer card) and
// automatically after "Submit check-in and create order". Four ways: New order, Order usual (the customer's usual
// basket), Repeat last order, and Repeat order (pick one of the last orders, look at its lines, copy it).
// The menu itself is static -- it opens instantly and loads NOTHING. Each choice just opens the order screen with the
// right start (?usual=1 / ?from=last / ?from=<order>) and that screen pre-fills the cart; only "Repeat order" fetches
// the last orders, and only after it is tapped.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, formatDateDMY } from "./util.js";
import { usualOrderHash, reorderHash } from "./reorder.js";

export function openOrderMenu({ customer, navigate, checkinId = null }) {
  const customerId = customer.id;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet om-sheet" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const sheet = overlay.querySelector(".sheet");
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const withCheckin = (hash) => (checkinId ? `${hash}${hash.includes("?") ? "&" : "?"}checkin=${checkinId}` : hash);
  const go = (hash) => {
    close();
    navigate(withCheckin(hash));
  };
  const itemsWord = (n) => `${n} ${t(n === 1 ? "item" : "items")}`;

  let orders = null; // null = not asked / still loading, [] = none (only the "Repeat order" picker asks)
  let view = "menu"; // "menu" | "pick" | { order }

  const option = (id, icon, title, sub, disabled = false) => `
    <button type="button" class="om-option" data-om="${id}" ${disabled ? "disabled" : ""}>
      <span class="om-icon">${icon}</span>
      <span class="om-text"><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(sub)}</span></span>
    </button>`;
  const closeX = `<button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>`;

  function paint() {
    if (view === "menu") {
      sheet.innerHTML = `
        ${closeX}
        <h2>${t("om_title")}</h2>
        <p class="muted">${escapeHtml(customer.name)}</p>
        <div class="om-options">
          ${option("new", icons.cart, t("om_new"), t("om_new_sub"))}
          ${option("usual", icons.repeat, t("om_usual"), t("om_usual_sub"))}
          ${option("last", icons.history, t("om_repeat_last"), t("om_repeat_last_sub"))}
          ${option("pick", icons.note, t("om_repeat_pick"), t("om_repeat_pick_sub"))}
        </div>`;
    } else if (view === "pick") {
      sheet.innerHTML = `
        ${closeX}
        <h2>${t("om_pick_title")}</h2>
        <div class="om-options">
          ${orders === null ? `<p class="muted om-loading">${t("loading")}</p>` : orders.length ? "" : `<p class="muted">${t("om_no_orders")}</p>`}
          ${(orders ?? []).map((o, i) => option(`o${i}`, icons.note, formatDateDMY(o.date), `${itemsWord(o.lines.length)} · ${o.lines.slice(0, 2).map((l) => l.name).join(", ")}${o.lines.length > 2 ? "…" : ""}`)).join("")}
        </div>
        <div class="sheet-actions"><button type="button" class="btn" data-om="back">${t("back")}</button></div>`;
    } else {
      const o = view.order;
      sheet.innerHTML = `
        ${closeX}
        <h2>${formatDateDMY(o.date)}</h2>
        <p class="muted">${itemsWord(o.lines.length)}</p>
        <div class="om-lines">${o.lines.map((l) => `<div class="om-line"><span>${escapeHtml(l.name)}</span><strong>× ${l.qty}</strong></div>`).join("")}</div>
        <div class="sheet-actions">
          <button type="button" class="btn" data-om="pick">${t("back")}</button>
          <button type="button" class="btn btn-primary" data-om="copy">${t("om_copy")}</button>
        </div>`;
    }
    sheet.querySelector("[data-close]")?.addEventListener("click", close);
    sheet.querySelectorAll("[data-om]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.om;
        if (id === "new") return go(`#/orders/new/${customerId}`);
        if (id === "usual") return go(usualOrderHash(customerId));
        if (id === "last") return go(reorderHash(customerId, "last"));
        if (id === "pick") {
          view = "pick";
          if (orders === null) loadOrders();
        } else if (id === "back") view = "menu";
        else if (id === "copy") return go(reorderHash(customerId, view.order.key));
        else if (/^o\d+$/.test(id)) view = { order: orders[Number(id.slice(1))] };
        paint();
      })
    );
  }

  function loadOrders() {
    api
      .getRecentOrders(customerId)
      .then((r) => (orders = r.orders ?? []))
      .catch(() => (orders = []))
      .then(() => view === "pick" && paint());
  }

  paint();
}
