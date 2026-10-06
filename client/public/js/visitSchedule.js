// Shared rendering for "when is this customer due a visit?" -- the answer
// from GET /api/customers/:id/visit-schedule, which joins one-off day plans,
// recurring Route Plans weekdays and the customer's own visit cadence. Used by
// the Map pin popup and the customer card's "Next visit" card.
import { t, getLang } from "./i18n.js";
import { escapeHtml, parseDateOnly } from "./util.js";

export function formatScheduleDate(dateOnly) {
  const d = parseDateOnly(dateOnly);
  if (!d) return String(dateOnly ?? "");
  return d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { weekday: "short", day: "numeric", month: "short" });
}

// "Mon, 13 Oct · weekly" per upcoming planned visit (the planner's name is
// added for viewers who can see several managers' plans).
export function plannedLinesHtml(schedule, { showManager = false, max = 3, compact = false } = {}) {
  const planned = (schedule?.planned ?? []).slice(0, max);
  if (!planned.length) return `<span class="muted">${t("visit_not_planned")}</span>`;
  return planned
    .map((p) => {
      const parts = [formatScheduleDate(p.date)];
      // Compact (map popup): a repeat glyph instead of the word, to keep the
      // narrow popup short; the customer card spells it out.
      if (p.source === "rule") parts.push(compact ? "↻" : t("visit_plan_weekly"));
      if (showManager && p.user_name) parts.push(p.user_name);
      return `<span class="visit-planned-line">${escapeHtml(parts.join(" · "))}</span>`;
    })
    .join("");
}

// "Due by Mon, 20 Oct (every 7 days)" / overdue / never visited.
export function cadenceLineHtml(schedule) {
  const c = schedule?.cadence;
  if (!c) return "";
  if (c.never_visited) return `<span class="badge badge-neutral">${t("never_visited")}</span>`;
  const every = c.frequency_days ? ` (${t("visit_every_n_days").replace("{n}", c.frequency_days)})` : "";
  if (c.overdue) return `<span class="badge badge-danger">${t("filter_overdue")}: ${escapeHtml(formatScheduleDate(c.due_by))}</span>${escapeHtml(every)}`;
  return `<span>${escapeHtml(formatScheduleDate(c.due_by))}</span>${escapeHtml(every)}`;
}

// The single "when is the next visit" row (map popup + customer card):
//   planned today (a Plan Day plan includes today) -> "Planned: today"
//   overdue                                        -> red "Visit overdue N days" chip + the missed date
//   otherwise                                      -> "Planned: Fri, 2 Oct"
// The date is the plan-aware one from the server (cadence + route weekday,
// see server/src/utils/visitDue.js), so it already skips a route day that
// falls inside the visit cadence.
export function nextVisitRowHtml(schedule) {
  const c = schedule?.cadence;
  if (!schedule || !c) return "";
  if (schedule.planned_today) {
    return `<div class="popup-fact"><span class="muted">${t("visit_planned_label")}</span><strong>${t("visit_planned_today")}</strong></div>`;
  }
  const firstPlanned = schedule.planned?.[0]?.date;
  const date = c.planned_date ?? firstPlanned;
  if (c.never_visited) {
    // "Last visit: Not visited yet" already says it; only add a planned date.
    if (!firstPlanned) return "";
    return `<div class="popup-fact"><span class="muted">${t("visit_planned_label")}</span><strong>${escapeHtml(formatScheduleDate(firstPlanned))}</strong></div>`;
  }
  if (c.overdue) {
    const label = t(c.overdue_days === 1 ? "visit_overdue_day" : "visit_overdue_days").replace("{n}", c.overdue_days);
    return `<div class="popup-fact popup-fact-overdue"><span class="badge badge-danger">${escapeHtml(label)}</span><strong>${escapeHtml(formatScheduleDate(date))}</strong></div>`;
  }
  if (!date) return "";
  return `<div class="popup-fact"><span class="muted">${t("visit_planned_label")}</span><strong>${escapeHtml(formatScheduleDate(date))}</strong></div>`;
}
