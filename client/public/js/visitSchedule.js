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
