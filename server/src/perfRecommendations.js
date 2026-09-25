import { STATUS } from "./perfCalc.js";

// Deterministic, rule-based recommendations derived purely from the same
// kpiProgress numbers every dashboard already shows -- no separate math, no
// LLM call, no hidden state. Each rule either fires or it doesn't; same
// inputs always produce the same output, which is what lets a CEO trust a
// recommendation instead of treating it as a guess.
//
// Severity ordering (used to sort the "Needs Attention" list): high before
// medium before info, so the worst channel-KPI combinations surface first.
const SEVERITY_RANK = { high: 0, medium: 1, info: 2 };

function statusSeverity(status) {
  if (status === STATUS.AT_RISK) return "high";
  if (status === STATUS.SLIGHTLY_BEHIND) return "medium";
  return null;
}

// One KPI's recommendations: a pace warning when behind, plus a
// forecast-miss warning when the run-rate projection won't reach target
// even though current pace status hasn't crossed into "at risk" yet (an
// early signal, not a duplicate of the pace rule).
//
// Each entry is {severity, kpi, kind, value} -- a kind tag plus the one raw
// number (or null) the client needs, never a formatted sentence. This used
// to build the final English sentence here, server-side, with a plain JS
// template string -- which meant there was no way for anyone viewing the
// (otherwise fully Armenian) Team Performance page in Armenian to ever see
// these messages translated, since the server has no notion of the
// requesting user's language. Rendering now happens client-side through
// the same t()/formatAmd() layer every other number on this page already
// goes through (see teamPerformance.js's recommendationText).
function recommendationsForKpi(kpiKey, kpi) {
  const out = [];

  const severity = statusSeverity(kpi.status);
  if (severity && kpi.required_daily_rate !== null) {
    if (kpi.required_daily_rate > 0) {
      out.push({ severity, kpi: kpiKey, kind: "pace_behind", value: kpi.required_daily_rate });
    } else {
      out.push({ severity, kpi: kpiKey, kind: "target_reached", value: null });
    }
  }

  if (kpi.forecast !== null && kpi.target && kpi.forecast < kpi.target && severity !== "high") {
    out.push({ severity: "medium", kpi: kpiKey, kind: "forecast_miss", value: kpi.target - kpi.forecast });
  }

  return out;
}

// Recommendations for one channel's dashboard row (as built by
// buildChannelDashboardRow). Pure function of its inputs -- safe to call
// on every row for every dashboard render. Only Sales carries a target/pace
// now -- Collections has none of its own (see buildChannelDashboardRow), so
// the only thing worth flagging about it is a pending balance not yet
// confirmed in Excel.
export function buildRecommendations(row) {
  const out = [...recommendationsForKpi("sales", row.sales)];

  // A large pending balance not yet confirmed in Excel is worth flagging on
  // its own, independent of Sales pace -- it tells the reviewer "the
  // manager says this is better than it looks," which is a different kind
  // of attention than a pace warning. Flat AMD threshold rather than a
  // ratio against a target, since Collections no longer has one.
  if (row.collections.pending_amd >= 50000) {
    out.push({ severity: "info", kpi: "collections", kind: "collections_pending", value: row.collections.pending_amd });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// Rolls up a whole dashboard's channel rows into a single "Needs Attention"
// list for the management overview -- every high/medium recommendation,
// tagged with which channel it belongs to, worst-first.
export function buildNeedsAttention(channelRows) {
  const items = [];
  for (const row of channelRows) {
    for (const rec of buildRecommendations(row)) {
      if (rec.severity === "info") continue;
      items.push({ channel_id: row.channel_id, channel_code: row.channel_code, channel_name: row.channel_name, ...rec });
    }
  }
  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
