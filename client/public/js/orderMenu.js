// The order menu: how do you want to start this order? Opened by a long press on "New order" (customer card) and
// automatically after "Submit check-in and create order". Four ways: New order, Order usual (the customer's usual
// basket), Repeat last order, and Repeat order (pick one of the last orders, look at its lines, copy it). Each one just
// opens the order screen with the right start (?usual=1 / ?from=<order>) -- the order screen pre-fills the cart.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { activateDialog, escapeHtml, formatAmd, formatDateDMY } from "./util.js";
import { loadReorderProfile, usualOrderHash, reorderHash, usualEstimateAmd } from "./reorder.js";

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

  let profile = null;
  let usualAmount = 0;
  let orders = null; // null = still loading, [] = none
  let view = "menu"; // "menu" | "pick" | { order }

  const option = (id, icon, title, sub, disabled = false) => `
    <button type="button" class="om-option" data-om="${id}" ${disabled ? "disabled" : ""}>
      <span class="om-icon">${icon}</span>
      <span class="om-text"><strong>${escapeHtml(title)}</strong><span class="muted">${escapeHtml(sub)}</span></span>
    </button>`;
  const closeX = `<button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}">${icons.close}</button>`;
  const orderSub = (o) => `${formatDateDMY(o.date)} · ${itemsWord(o.lines.length)}`;

  function paint() {
    if (view === "menu") {
      const last = orders?.[0];
      const hasUsual = Boolean(profile?.items?.length);
      sheet.innerHTML = `
        ${closeX}
        <h2>${t("om_title")}</h2>
        <p class="muted">${escapeHtml(customer.name)}</p>
        <div class="om-options">
          ${option("new", icons.cart, t("om_new"), t("om_new_sub"))}
          ${hasUsual ? option("usual", icons.repeat, t("om_usual"), `${itemsWord(profile.items.length)}${usualAmount ? ` · ~${formatAmd(usualAmount)}` : ""}`) : ""}
          ${last ? option("last", icons.history, t("om_repeat_last"), orderSub(last)) : ""}
          ${orders?.length ? option("pick", icons.note, t("om_repeat_pick"), t("om_repeat_pick_sub")) : ""}
          ${orders === null ? `<p class="muted om-loading">${t("loading")}</p>` : ""}
        </div>`;
    } else if (view === "pick") {
      sheet.innerHTML = `
        ${closeX}
        <h2>${t("om_pick_title")}</h2>
        <div class="om-options">
          ${orders.map((o, i) => option(`o${i}`, icons.note, formatDateDMY(o.date), `${itemsWord(o.lines.length)} · ${o.lines.slice(0, 2).map((l) => l.name).join(", ")}${o.lines.length > 2 ? "…" : ""}`)).join("")}
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
        if (id === "last") return go(reorderHash(customerId, orders[0].key));
        if (id === "pick") view = "pick";
        else if (id === "back") view = "menu";
        else if (id === "copy") return go(reorderHash(customerId, view.order.key));
        else if (/^o\d+$/.test(id)) view = { order: orders[Number(id.slice(1))] };
        paint();
      })
    );
  }

  paint();
  // The options that need data appear as soon as it arrives; "New order" works at once.
  loadReorderProfile(customerId).then(async (p) => {
    profile = p;
    if (p?.items?.length) usualAmount = await usualEstimateAmd(p.items, customer.customer_tier);
    if (view === "menu") paint();
  });
  api
    .getRecentOrders(customerId)
    .then((r) => (orders = r.orders ?? []))
    .catch(() => (orders = []))
    .then(() => view === "menu" && paint());
}
