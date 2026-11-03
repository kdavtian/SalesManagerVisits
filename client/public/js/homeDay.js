// The rep's Home "today" card (owner, 2026-11-03): ONE list of today's visits with a progress bar to the mandatory share (75 % of the planned
// customers, per DAY), "today X of Y needed" and the month so far. Replaces the old trio next-visit card / collapsed plan / week bar.
// Tapping a customer's name opens the map with that pin selected; so does a long press; the chevron opens the customer card.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { escapeHtml } from "./util.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const LONG_PRESS_MS = 500;
const SUGGESTED = 5;

// customers: the rep's assigned customers (id, name, visited_today, overdue); day: GET /visit-plans/my-day
export function paintMyDay(slot, day, customers, navigate) {
  const byId = new Map(customers.map((c) => [c.id, c]));
  const hasPlan = day.planned > 0;
  const rows = hasPlan
    ? day.customer_ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((c) => ({ ...c, done: day.done_ids.includes(c.id) || !!c.visited_today }))
    : customers
        .filter((c) => !c.visited_today && c.customer_tier !== "competitor")
        .sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0))
        .slice(0, SUGGESTED)
        .map((c) => ({ ...c, done: false }));
  const total = day.planned;
  const done = day.done;
  const need = Math.max(0, day.required - done);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const target = Math.min(100, day.pct);
  const reached = hasPlan && need === 0;
  const firstPending = rows.find((r) => !r.done);
  const title = t(hasPlan ? "my_day_title" : "my_day_suggested");
  slot.innerHTML = `
    <section class="card my-day ${reached ? "my-day-reached" : ""}" aria-label="${escapeHtml(title)}">
      <header class="my-day-head">
        <h2 class="section-title section-title-inline">${title}</h2>
        ${hasPlan ? `<span class="my-day-count">${done}<small>/${total}</small></span>` : ""}
      </header>
      ${
        hasPlan
          ? `<div class="my-day-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
              <span class="my-day-bar-fill" style="width:${pct}%"></span><span class="my-day-bar-target" style="left:${target}%" aria-hidden="true"></span>
            </div>
            <p class="my-day-line ${reached ? "my-day-line-ok" : ""}">${escapeHtml(reached ? fill("my_day_reached", { pct: day.pct }) : fill("my_day_need", { need, required: day.required, total, pct: day.pct }))}</p>`
          : `<p class="muted my-day-line">${t(rows.length ? "my_day_no_plan" : "my_day_nothing")}</p>`
      }
      ${
        rows.length
          ? `<div class="my-day-list">${rows
              .map(
                (c) => `<div class="my-day-row ${c.done ? "is-done" : ""}">
                  <span class="my-day-tick ${c.done ? "my-day-tick-done" : ""}" aria-hidden="true">${c.done ? icons.checkCircle : ""}</span>
                  <button type="button" class="my-day-name" data-map="${c.id}">${escapeHtml(c.name)}${c.overdue && !c.done ? ` <span class="dot dot-danger" aria-hidden="true"></span>` : ""}</button>
                  ${c === firstPending ? `<button type="button" class="btn btn-primary btn-sm my-day-checkin" data-checkin="${c.id}">${t("check_in")}</button>` : ""}
                  <button type="button" class="icon-btn my-day-open" data-open="${c.id}" aria-label="${escapeHtml(t("view_customer"))}">&#8250;</button>
                </div>`
              )
              .join("")}</div>`
          : ""
      }
      <p class="muted my-day-month">${escapeHtml(fill("my_day_month", { visits: day.month.visits }) + (day.month.plan_days ? fill("my_day_month_days", { met: day.month.days_met, days: day.month.plan_days }) : ""))}</p>
    </section>`;
  const toMap = (id) => navigate(`#/map?customer=${id}`);
  slot.querySelectorAll("[data-map]").forEach((btn) => {
    let timer = null;
    let fired = false;
    const cancel = () => clearTimeout(timer);
    btn.addEventListener("pointerdown", () => {
      fired = false;
      timer = setTimeout(() => {
        fired = true;
        toMap(btn.dataset.map);
      }, LONG_PRESS_MS);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, cancel));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (!fired) toMap(btn.dataset.map);
      fired = false;
    });
  });
  slot.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => navigate(`#/customers/${b.dataset.open}`)));
  slot.querySelectorAll("[data-checkin]").forEach((b) => b.addEventListener("click", () => navigate(`#/checkin/${b.dataset.checkin}`)));
}

export async function renderMyDay(slot, customers, navigate) {
  try {
    const day = await api.getMyDay();
    if (slot.isConnected) paintMyDay(slot, day, customers, navigate);
  } catch {
    slot.innerHTML = "";
  }
}
