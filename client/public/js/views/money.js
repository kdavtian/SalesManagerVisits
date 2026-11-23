// The Cash screen (owner, 2026-11-23: "one Cash screen per role instead of six"; before that, 2026-10-26, this page was two big buttons).
// One page answers, for the person who opened it:
//   1. "Your turn"  what I have to do with cash now: count a hand-over that waits for me, hand over what is in my hands (to the person
//                   the route names), see what I handed over and is not counted yet, my open shortfall. Nothing to do = it says so.
//   2. "Where is the cash now"  (everybody who sees all payments) the company's cash by place: with the reps, handed over and waiting,
//                   with the director, received at the office today, not in the Excel yet. A tap opens exactly those payments.
//   3. the doors to the full lists (Payments, Cash hand-overs, Bank & cash desks, Cash expense), which stay the engines.
// Roles that never had Payments (warehouse, delivery) only get Cash expense, as before.
import { t } from "../i18n.js";
import { api } from "../api.js";
import { icons } from "../icons.js";
import { state } from "../state.js";
import { escapeHtml, formatAmd } from "../util.js";
import { canRecordBankPayments, seesPaymentsOnMoney } from "../shared/roles.js";
import { applyPaymentBadge } from "../badges.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(key));

// One row of a card: a label, an optional second line, the amount at the right, and where a tap goes (none = plain line).
function rowHtml({ label, sub = "", amd = null, href = "", tone = "", action = "" }) {
  const body = `<span class="cash-row-text"><span class="cash-row-label">${label}</span>${sub ? `<span class="cash-row-sub muted">${sub}</span>` : ""}</span>
    ${amd === null ? "" : `<strong class="cash-row-amd text-amount">${formatAmd(amd)}</strong>`}
    ${action ? `<span class="btn btn-primary btn-sm cash-row-action">${action}</span>` : href ? `<span class="chevron" aria-hidden="true">&#8250;</span>` : ""}`;
  const cls = `cash-row${tone ? ` cash-row-${tone}` : ""}${action ? " cash-row-act" : ""}`;
  return href ? `<button type="button" class="${cls}" data-go="${escapeHtml(href)}">${body}</button>` : `<div class="${cls}">${body}</div>`;
}

function turnHtml(o) {
  const rows = [];
  for (const h of o.to_confirm) {
    rows.push(
      rowHtml({
        // mine: I count it (the button). Somebody else's (admin and the CEO see all of them): it waits for its receiver, a tap opens it.
        label: escapeHtml(h.from_name),
        sub: escapeHtml(h.mine ? fill("cash_turn_count_sub", { n: h.n }) : fill("cash_turn_waits_for", { n: h.n, name: h.to_name })),
        amd: h.amd,
        href: `#/cash-handoffs/${h.id}`,
        action: h.mine ? t("cash_turn_count") : "",
      })
    );
  }
  if (o.me.amd > 0) {
    rows.push(
      rowHtml({
        label: t("cash_turn_with_me"),
        sub: escapeHtml(o.me.can_hand_over && o.me.next ? fill("cash_turn_give_to", { n: o.me.n, name: o.me.next.name }) : fill("cash_turn_payments_n", { n: o.me.n })),
        amd: o.me.amd,
        href: o.me.can_hand_over ? "#/cash-handoffs?handover=1" : "",
        action: o.me.can_hand_over ? t("cash_turn_hand_over") : "",
      })
    );
  }
  for (const w of o.me.waiting) {
    rows.push(rowHtml({ label: escapeHtml(fill("cash_turn_waiting", { name: w.to_name })), sub: t("cash_turn_waiting_sub"), amd: w.amd, href: `#/cash-handoffs/${w.id}` }));
  }
  if (o.me.shortfall_amd > 0) rows.push(rowHtml({ label: t("cash_turn_shortfall"), amd: o.me.shortfall_amd, href: "#/cash-handoffs", tone: "danger" }));
  if (!rows.length) rows.push(`<p class="cash-none" role="status">✓ ${t("cash_turn_none")}</p>`);
  return `<section class="card cash-card" id="cash-turn"><h2 class="cash-card-title">${t("cash_turn_title")}</h2>${rows.join("")}</section>`;
}

function companyHtml(c) {
  if (!c) return "";
  const people = (place) =>
    c[place].people
      .slice(0, 4)
      .map((p) => `${escapeHtml(p.name)} ${formatAmd(p.amd)}`)
      .join(" · ") + (c[place].people.length > 4 ? ` · +${c[place].people.length - 4}` : "");
  const place = (key) => rowHtml({ label: t(`cash_now_${key}`), sub: c[key].amd ? people(key) : "", amd: c[key].amd, href: c[key].n ? `#/payments?status=all&place=${key}` : "", tone: c[key].amd ? "" : "zero" });
  const rows = [
    place("with_rep"),
    place("on_the_way"),
    place("with_director"),
    rowHtml({ label: t("cash_now_office_today"), sub: c.office_today.n ? escapeHtml(fill("cash_turn_payments_n", { n: c.office_today.n })) : "", amd: c.office_today.amd, href: c.office_today.n ? "#/payments?status=all&received=today" : "", tone: c.office_today.n ? "ok" : "zero" }),
    rowHtml({ label: t("cash_now_not_in_excel"), sub: c.not_in_excel.n ? escapeHtml(fill("cash_turn_payments_n", { n: c.not_in_excel.n })) : "", amd: c.not_in_excel.amd, href: c.not_in_excel.n ? "#/payments?status=excel_missing" : "", tone: c.not_in_excel.n ? "" : "zero" }),
  ];
  if (c.shortfalls_open.amd > 0) rows.push(rowHtml({ label: t("cash_now_shortfalls"), amd: c.shortfalls_open.amd, href: "#/cash-handoffs", tone: "danger" }));
  if (c.to_check) rows.push(rowHtml({ label: fill("cash_now_to_check", { n: c.to_check }), href: "#/bank-desk" }));
  return `<section class="card cash-card" id="cash-now"><h2 class="cash-card-title">${t("cash_now_title")}</h2>${rows.join("")}</section>`;
}

export function renderMoney(root, navigate) {
  const showPayments = seesPaymentsOnMoney(state.user.role);
  const door = (id, icon, cls, label, badgeId = "") =>
    `<button type="button" class="money-action" id="${id}">
       <span class="quick-action-icon ${cls}">${icon}${badgeId ? `<span class="nav-badge count-badge" id="${badgeId}" hidden></span>` : ""}</span>
       <span class="money-action-label">${label}</span>
       <span class="chevron" aria-hidden="true">&#8250;</span>
     </button>`;
  root.innerHTML = `
    <div class="detail-view money-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("qa_money")}</h1></div>
      </div>
      ${showPayments ? `<div id="cash-overview"><p class="loading-state" role="status">${t("loading")}</p></div>` : ""}
      <div class="money-actions">
        ${showPayments ? door("money-payments", icons.payment, "quick-action-icon-payments", t("qa_payments"), "qa-payments-badge") : ""}
        ${showPayments ? door("money-handoffs", icons.wallet, "quick-action-icon-payments", t("cash_handoffs_open")) : ""}
        ${canRecordBankPayments(state.user.role) ? door("money-bank", icons.wallet, "quick-action-icon-payments", t("qa_bank_desk"), "qa-bank-badge") : ""}
        ${door("money-expenses", icons.wallet, "quick-action-icon-cash", t("qa_cash_expense"))}
      </div>
    </div>`;
  // Back = one step back in history (the Home screen), like every other page.
  root.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  root.querySelector("#money-payments")?.addEventListener("click", () => navigate("#/payments"));
  root.querySelector("#money-handoffs")?.addEventListener("click", () => navigate("#/cash-handoffs"));
  root.querySelector("#money-expenses").addEventListener("click", () => navigate("#/expenses"));
  applyPaymentBadge();

  const overviewEl = root.querySelector("#cash-overview");
  let lastJson = "";
  async function loadOverview() {
    if (!overviewEl) return;
    let o;
    try {
      o = await api.getCashOverview();
    } catch (err) {
      // an older server has no overview yet: the doors below still work, the page just has no summary
      if (!lastJson) overviewEl.innerHTML = err.status === 404 ? "" : `<p class="form-error" style="position:static;">${escapeHtml(err.message)}</p>`;
      return;
    }
    const json = JSON.stringify(o);
    if (json === lastJson) return; // nothing changed: nothing redrawn
    lastJson = json;
    overviewEl.innerHTML = turnHtml(o) + companyHtml(o.company);
    overviewEl.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.go)));
  }
  loadOverview();

  // Bank & cash desks: what waits in "To check" (accountant, admin, CEO)
  const bank = root.querySelector("#money-bank");
  if (bank) {
    bank.addEventListener("click", () => navigate("#/bank-desk"));
    api.getPay2Setup().then(
      (s) => {
        const badge = root.querySelector("#qa-bank-badge");
        if (badge && s.unspecified) Object.assign(badge, { textContent: String(s.unspecified), hidden: false });
      },
      () => {}
    );
  }
  // back from a hand-over or the Payments list: the numbers are read again (no flash: redrawn only when they changed)
  const cleanup = () => {};
  cleanup.onRestore = loadOverview;
  return cleanup;
}
