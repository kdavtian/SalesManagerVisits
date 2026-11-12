// The rules of each sales direction (owner, 2026-11-12: directions are added and edited in the admin panel). They used to be lists of names
// spread over the code; now they are columns of sales_channels (migration 204). SQL reads the table directly (the *_SQL fragments below);
// JavaScript reads this in-memory copy, refreshed every minute and right after an admin edit.
//
// Until the table has been read once (the first seconds after start, or a test that never loads it), the copy is today's built-in rules, so the
// app behaves exactly as before; a direction the table does not know gets the plain "field" rules.
import { pool } from "../db/pool.js";
import { setChannelCommissionKinds } from "../../../client/public/js/costModel.js";

export const RULE_COLUMNS = ["visit_mode", "debt_mode", "separate_plan", "cash_source", "commission_kind", "visit_type_key", "route_autofill", "director_report_excluded"];
export const VISIT_MODES = ["field", "no_visit"];
export const DEBT_MODES = ["visit", "call", "none"];
export const COMMISSION_KINDS = ["rep", "trade", "none"];
export const VISIT_TYPE_KEYS = ["sm", "cvo", "pco", "oem", "cas", "kf"];
// values the client writes into sales_channel for display only (api/core.js normalizeCustomer): never a real direction's code
export const RESERVED_CODES = ["POTENTIAL", "COMPETITORS"];

// today's behaviour, as migration 204 seeds it
const BUILT_IN = {
  "SM YVN": { cash_source: "Cash YVN" },
  "SM Davtashen": { cash_source: "Cash DVT" },
  "SM Shirak": { cash_source: "Cash Shirak" },
  "SM B2B": { debt_mode: "call", separate_plan: true },
  "SM CAS": {},
  OEM: { visit_mode: "no_visit", debt_mode: "call", route_autofill: false },
  CVO: { visit_mode: "no_visit", debt_mode: "call", route_autofill: false },
  PCO: { visit_mode: "no_visit", debt_mode: "call", route_autofill: false },
  CAS: { visit_mode: "no_visit", debt_mode: "none", commission_kind: "none", director_report_excluded: true },
  KF: { visit_mode: "no_visit", debt_mode: "none", commission_kind: "none", director_report_excluded: true },
};

// The plain rules of a code nobody configured (the old behaviour of an unknown name: visited, visit tasks, own main plan, central cash).
export function defaultRules(code) {
  const c = String(code ?? "");
  return {
    visit_mode: "field",
    debt_mode: "visit",
    separate_plan: false,
    cash_source: null,
    commission_kind: /^SM(\s|$)/i.test(c) ? "rep" : "trade",
    visit_type_key: /^SM/i.test(c) ? "sm" : VISIT_TYPE_KEYS.includes(c.toLowerCase()) ? c.toLowerCase() : "sm",
    route_autofill: true,
    director_report_excluded: false,
  };
}

let byCode = new Map(Object.entries(BUILT_IN).map(([code, r]) => [code, { code, active: true, ...defaultRules(code), ...r }]));
let loadedFromDb = false;
let loadedAt = 0;
let generation = 0; // a read that started before a newer one never overwrites it (review 2026-11-12)
let inflight = null;
pushCommissionKinds();

function pushCommissionKinds() {
  setChannelCommissionKinds(Object.fromEntries([...byCode.values()].map((r) => [r.code.toUpperCase(), r.commission_kind])));
}

export async function refreshChannelRules(db = pool) {
  const mine = ++generation;
  const { rows } = await db.query(`SELECT code, active, ${RULE_COLUMNS.join(", ")} FROM sales_channels`);
  if (mine !== generation) return byCode; // a newer read is on its way (or done): it decides
  byCode = new Map(rows.map((r) => [r.code, r]));
  loadedFromDb = true;
  loadedAt = Date.now();
  pushCommissionKinds();
  return byCode;
}
export const channelRulesLoaded = () => loadedFromDb;

// Kept fresh PER PROCESS without a timer: a read older than a minute starts a new one in the background (the answer that triggered it uses
// the copy it has); every admin edit refreshes at once. A failed read keeps the last good copy.
const MAX_AGE_MS = 60_000;
function keepFresh() {
  if (inflight || Date.now() - loadedAt < MAX_AGE_MS) return;
  inflight = refreshChannelRules()
    .catch((err) => console.error("Sales direction rules could not be read:", err.message))
    .finally(() => {
      inflight = null;
      if (!loadedFromDb) loadedAt = Date.now(); // a failing database is not asked again on every call
    });
}

// At start, before the server answers anything (index.js awaits it): a failure leaves the built-in rules.
export async function loadChannelRulesAtStart(db = pool) {
  try {
    await refreshChannelRules(db);
  } catch (err) {
    console.error("Sales direction rules could not be read at start (built-in rules used):", err.message);
  }
}

export const rulesOf = (code) => {
  keepFresh();
  return byCode.get(String(code ?? "")) ?? { code, active: false, ...defaultRules(code) };
};
export const isNoVisitChannel = (code) => rulesOf(code).visit_mode === "no_visit";
export const isCallChannel = (code) => rulesOf(code).debt_mode === "call" && byCode.has(String(code ?? ""));
export const isSeparatePlanChannel = (code) => rulesOf(code).separate_plan === true && byCode.has(String(code ?? ""));
export const separatePlanChannels = () => {
  keepFresh();
  return [...byCode.values()].filter((r) => r.separate_plan).map((r) => r.code);
};
export const cashSourceOf = (code) => rulesOf(code).cash_source || "Cash";

// SQL fragments read straight from the table (always current). `col` = the SQL expression of the customer's channel.
export const noVisitSql = (col = "c.sales_channel") => `COALESCE(${col}, '') IN (SELECT code FROM sales_channels WHERE visit_mode = 'no_visit')`;
export const debtSkippedSql = (col = "c.sales_channel") => `COALESCE(${col}, '') IN (SELECT code FROM sales_channels WHERE debt_mode = 'none')`;
