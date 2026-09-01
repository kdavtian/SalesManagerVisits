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

const KPI_LABELS = {
  sales: "Sales",
  collections: "Collections",
  new_customers: "New customers",
};

function statusSeverity(status) {
  if (status === STATUS.AT_RISK) return "high";
  if (status === STATUS.SLIGHTLY_BEHIND) return "medium";
  return null;
}

function formatAmd(n) {
  return `${Math.round(n).toLocaleString("en-US")} AMD`;
}

function formatNumber(n, unit) {
  return unit ? `${Math.round(n).toLocaleString("en-US")} ${unit}` : Math.round(n).toLocaleString("en-US");
}

// One KPI's recommendations: a pace warning when behind, plus a
// forecast-miss warning when the run-rate projection won't reach target
// even though current pace status hasn't crossed into "at risk" yet (an
// early signal, not a duplicate of the pace rule).
function recommendationsForKpi(kpiKey, kpi, { isAmd, unit } = {}) {
  const out = [];
  const format = (n) => (isAmd ? formatAmd(n) : formatNumber(n, unit));
  const label = KPI_LABELS[kpiKey] ?? kpiKey;

  const severity = statusSeverity(kpi.status);
  if (severity && kpi.required_daily_rate !== null) {
    out.push({
      severity,
      kpi: kpiKey,
      message:
        kpi.required_daily_rate > 0
          ? `${label} is ${kpi.status === STATUS.AT_RISK ? "at risk" : "slightly behind"} pace -- needs ${format(kpi.required_daily_rate)}/working day to hit target.`
          : `${label} target has already been reached.`,
    });
  }

  if (kpi.forecast !== null && kpi.target && kpi.forecast < kpi.target && severity !== "high") {
    const shortfall = kpi.target - kpi.forecast;
    out.push({
      severity: "medium",
      kpi: kpiKey,
      message: `${label} is projected to miss target by ${format(shortfall)} at the current run rate.`,
    });
  }

  return out;
}

// Recommendations for one channel's dashboard row (as built by
// buildChannelDashboardRow). Pure function of its inputs -- safe to call
// on every row for every dashboard render.
export function buildRecommendations(row) {
  const out = [
    ...recommendationsForKpi("sales", row.sales, { isAmd: true }),
    ...recommendationsForKpi("collections", row.collections, { isAmd: true }),
    ...recommendationsForKpi("new_customers", row.new_customers, {}),
  ];

  // Collections-specific: a large pending balance not yet confirmed in
  // Excel is worth flagging on its own, independent of pace -- it tells the
  // reviewer "the manager says this is better than it looks," which is a
  // different kind of attention than a pace warning.
  if (row.collections.pending_amd > 0 && row.collections.target) {
    const pendingRatio = row.collections.pending_amd / row.collections.target;
    if (pendingRatio >= 0.1) {
      out.push({
        severity: "info",
        kpi: "collections",
        message: `${formatAmd(row.collections.pending_amd)} logged in-app but not yet confirmed in Excel.`,
      });
    }
  }

  for (const brand of row.brands ?? []) {
    const severity = statusSeverity(brand.status);
    if (severity && brand.required_daily_rate > 0) {
      out.push({
        severity,
        kpi: `brand:${brand.brand}`,
        message: `${brand.brand} volume ${severity === "high" ? "at risk" : "slightly behind"} pace -- needs ${formatNumber(brand.required_daily_rate, "L")}/working day.`,
      });
    }
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
