// Vaghinak - Sales Expert, step 3 (owner, 2026-11-15): once a week an AI model (OpenAI, the owner's choice) reads what happened in the field
// and writes management a market strategy in Armenian: where to push, which competitor is winning where, what each sales manager should say at
// this week's picked customers. Test mode first: only management sees it (the Funnel screen).
//
// Privacy, the same one-way gates as Ask KAD (askKad/anonymize.js): the facts sent are counts and codes (CUST-.. / REP-..); the free text
// (visit notes, voice-note transcripts) is masked name by name and every long digit run (phones, TINs, card numbers) is removed before it
// leaves the server; the codes in the answer are turned back into names here. Cost: one run a week (+ "generate now", once an hour at most,
// never two at once), a capped answer length, and every paid run kept in sales_strategy_runs (failed ones too) with its tokens and price.
import { pool } from "../../db/pool.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { computeFunnel } from "./funnel.js";
import { runWeeklyPicks } from "./nextSteps.js";
import { getVaghinakSettings } from "./settings.js";
import { mondayOf } from "./digest.js";
import { minuteOfDay, isWorkingDay } from "./engine.js";
import { loadNameBook, maskText, unmaskText, customerCode, repCode } from "../askKad/anonymize.js";

const API_URL = "https://api.openai.com/v1/chat/completions";
// The market pitch of a step carries our prices and margins: internal, never sent to the AI (only counts and codes go out, review 2026-11-26)
const withoutPitch = (params) => {
  if (!params?.pitch) return params ?? {};
  const { pitch: _pitch, ...rest } = params;
  return rest;
};

export const STRATEGY_MODEL = process.env.OPENAI_STRATEGY_MODEL || "gpt-5";
export const isStrategistConfigured = () => Boolean(process.env.OPENAI_API_KEY);
const MAX_NOTES = 80;
const NOTE_CHARS = 400;
const RUN_FROM_MINUTE = 10 * 60; // after the 09:00 picks
const MAX_WEEKLY_FAILURES = 3;
const MAX_ANSWER_TOKENS = 8000; // reasoning + the JSON answer; caps the price of one run

// USD per million tokens (OpenAI price list); an unknown model is priced like the dearest one so the shown cost errs on the safe side.
const PRICES = { "gpt-5": { input: 1.25, output: 10 }, "gpt-5-mini": { input: 0.25, output: 2 }, "gpt-4.1": { input: 2, output: 8 } };
export const estimateCostUsd = (model, usage = {}) => {
  const p = PRICES[model] ?? PRICES["gpt-5"];
  return ((usage.prompt_tokens ?? 0) * p.input + (usage.completion_tokens ?? 0) * p.output) / 1e6;
};

// Free text -> safe to send: known names become codes, every run of 6+ digits (phones, TINs, cards; spaces / dashes inside allowed) goes.
export function cleanFreeText(text, book) {
  // masked whole first, cut after: a name crossing the cut is never sent half
  const masked = maskText(String(text ?? "").replace(/\s+/g, " ").trim(), book);
  // a CUST-/REP- code is kept whole (its digits are an id, not a phone)
  const scrubbed = masked.text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/(^|\s)@[\w.]{2,}/g, "$1[handle]")
    // phones, TINs, cards: 6+ digits with spaces, dashes, dots, slashes or brackets between them (a CUST-/REP- code is an id, kept)
    .replace(/\b(?:CUST|REP)-[A-Za-z0-9]+\b|\+?\(?\d[\d\s\-./()]{4,}\d/g, (m) => (/^(?:CUST|REP)-/.test(m) || m.replace(/\D/g, "").length < 6 ? m : "[number]"));
  return { text: scrubbed.slice(0, NOTE_CHARS), count: masked.count };
}

// Notes name people the way people talk: "Արտակը", not "Artak Petrosyan". Every part (4+ letters) of each staff name, Latin and Armenian, is
// masked as that person too (Armenian endings are covered: the match is on the start of the word).
export async function strategyNameBook(db = pool) {
  const book = await loadNameBook(db);
  const known = new Set(book.needles.map(([n]) => n));
  const { rows: users } = await db.query("SELECT id, name, name_hy FROM users");
  const { rows: brands } = await db.query("SELECT DISTINCT lower(brand) AS b FROM products WHERE brand IS NOT NULL");
  const protectedWords = new Set(brands.map((r) => r.b));
  for (const u of users) {
    for (const part of `${u.name ?? ""} ${u.name_hy ?? ""}`.split(/[\s.,-]+/)) {
      const n = part.trim().toLowerCase();
      if (n.length >= 4 && !/\d/.test(n) && !known.has(n) && !protectedWords.has(n)) {
        known.add(n);
        book.needles.push([n, repCode(u.id)]);
      }
    }
  }
  book.needles.sort((a, b) => b[0].length - a[0].length);
  return book;
}

// What the model reads: only codes, counts and masked text. Pure on its inputs (unit-tested through buildStrategyInput's shape).
export async function buildStrategyInput({ db = pool, now = new Date(), book } = {}) {
  book ??= await strategyNameBook(db);
  const settings = await getVaghinakSettings(db);
  const funnel = await computeFunnel({ db, settings });
  const { cfg, customers } = funnel;
  const byId = new Map(customers.map((c) => [c.id, c]));
  const custCode = (c) => customerCode(c.erp_customer_id, c.id);
  const week = mondayOf(yerevanToday(now));
  const [{ rows: visits }, { rows: outcomeRows }, { rows: notes }, { rows: moves }, { rows: competitors }, { rows: since }, { rows: picks }] = await Promise.all([
    db.query(
      `SELECT user_id, COUNT(*)::int AS visits, COUNT(DISTINCT customer_id)::int AS customers
       FROM checkins WHERE timestamp > now() - interval '7 days' GROUP BY user_id`
    ),
    db.query(
      `SELECT ch.user_id, x AS outcome, COUNT(*)::int AS n
       FROM checkins ch CROSS JOIN LATERAL unnest(ch.outcomes) AS x
       WHERE ch.timestamp > now() - interval '7 days' GROUP BY 1, 2`
    ),
    db.query(
      `SELECT ch.customer_id, ch.user_id, ch.outcomes, ch.note, string_agg(v.transcript, ' ') AS voice
       FROM checkins ch LEFT JOIN checkin_voice_notes v ON v.checkin_id = ch.id AND v.transcript_status = 'done'
       WHERE ch.timestamp > now() - interval '7 days' AND (NULLIF(trim(ch.note), '') IS NOT NULL OR v.transcript IS NOT NULL)
       GROUP BY ch.id ORDER BY ch.timestamp DESC LIMIT $1`,
      [MAX_NOTES]
    ),
    db.query("SELECT customer_id, from_stage, to_stage FROM customer_funnel_moves WHERE moved_at > now() - interval '7 days'"),
    // competitor brands on the shelf at the last visit that recorded them, last 30 days, per region
    db.query(
      `SELECT DISTINCT ON (ch.customer_id) ch.customer_id, ch.brand_status -> 'competitors' AS brands
       FROM checkins ch WHERE ch.timestamp > now() - interval '30 days' AND jsonb_typeof(ch.brand_status -> 'competitors') = 'array'  -- an empty list = the visit marked every competitor "not available" (2026-11-19): it is the latest state
       ORDER BY ch.customer_id, ch.timestamp DESC`
    ),
    db.query("SELECT customer_id, since FROM customer_funnel_stage"),
    db.query("SELECT customer_id, rep_id, kind, params FROM sales_step_picks WHERE week_start = $1", [week]),
  ]);
  // customers met in the notes / picks that are not in the funnel (closed, competitor) still get their real code
  const outside = [...new Set([...notes.map((n) => n.customer_id), ...picks.map((p) => p.customer_id)])].filter((id) => !byId.has(id));
  const erpOf = new Map(
    outside.length ? (await db.query("SELECT id, erp_customer_id FROM customers WHERE id = ANY($1::int[])", [outside])).rows.map((r) => [r.id, r.erp_customer_id]) : []
  );
  const codeOfId = (id) => (byId.has(id) ? custCode(byId.get(id)) : customerCode(erpOf.get(id), id));
  const sinceOf = new Map(since.map((r) => [r.customer_id, r.since]));
  let masked = 0;
  const stages = [1, 2, 3, 4].map((s) => ({
    stage: s,
    customers: customers.filter((c) => c.stage === s).length,
    moved_in: moves.filter((m) => m.to_stage === s && m.from_stage < s).length,
    moved_down: moves.filter((m) => m.from_stage === s && m.to_stage < s).length,
    stuck_60_days: customers.filter((c) => c.stage === s && s < 4 && sinceOf.get(c.id) && now - new Date(sinceOf.get(c.id)) >= 60 * 86400000).length,
  }));
  const regionBrands = {};
  for (const r of competitors) {
    const region = byId.get(r.customer_id)?.region || "?";
    regionBrands[region] ??= {};
    for (const b of r.brands) regionBrands[region][b] = (regionBrands[region][b] ?? 0) + 1;
  }
  const fieldNotes = notes.map((n) => {
    const c = byId.get(n.customer_id);
    const note = cleanFreeText(n.note, book);
    const voice = cleanFreeText(n.voice, book);
    masked += note.count + voice.count;
    return {
      customer: codeOfId(n.customer_id),
      rep: repCode(n.user_id),
      stage: c?.stage ?? null,
      outcomes: n.outcomes ?? [],
      note: note.text || undefined,
      voice: voice.text || undefined,
    };
  });
  // a code -> every customer it stands for (two customers can share one ERP id)
  const codeToId = new Map();
  for (const id of [...customers.map((c) => c.id), ...outside]) codeToId.set(codeOfId(id), [...(codeToId.get(codeOfId(id)) ?? []), id]);
  return {
    masked,
    codeToId,
    input: {
      week_start: week,
      rules: { groups_target: cfg.groupsTarget, share_target_pct: cfg.sharePct },
      stages,
      reps: visits.map((v) => ({
        rep: repCode(v.user_id),
        visits_7_days: v.visits,
        customers_visited: v.customers,
        outcomes: Object.fromEntries(outcomeRows.filter((o) => o.user_id === v.user_id).map((o) => [o.outcome, o.n])),
      })),
      competitors_on_shelves_by_region: regionBrands,
      this_week_picks: picks.map((p) => {
        const c = byId.get(p.customer_id);
        // the step as it was picked (kind and details together), not the customer's step of today
        return { rep: repCode(p.rep_id), customer: codeOfId(p.customer_id), stage: c?.stage ?? null, step: p.kind, step_details: withoutPitch(p.params), region: c?.region ?? null, tier: c?.tier ?? null };
      }),
      field_notes_7_days: fieldNotes,
    },
  };
}

const SYSTEM = `You are Vaghinak, the sales expert of KAD Motors, an Armenian distributor of Castrol, Lotos, Royal and Orlen lubricants (car service shops, oil shops, fleets). Every week you read what happened in the field and write management a short market strategy.

The sales funnel: stage 1 Potential (not buying yet; potential level 1-4), stage 2 Customer (buys, but fewer product groups than its tier should: Bronze/Silver/Gold), stage 3 Assortment (enough groups, our litres below the share target of its monthly need), stage 4 Our share (target reached).

Rules
- Use only the data given. Never invent numbers, customers, brands or events; when the data is too thin for a conclusion, say so.
- Customers and staff appear as codes (CUST-..., REP-...). Write each code exactly as given, never invent one; the system turns codes into names.
- Write in Armenian, plain everyday words, short sentences. Management is "ղեկավարություն".
- Be concrete: name the region, competitor brand, stage or code each point is about.

Answer with ONE JSON object, nothing else:
{"headline": "one sentence: the most important thing this week",
 "situation": ["3-5 short points: what moved, what is stuck, where"],
 "where_to_push": ["2-4 points: regions / customer groups / product groups to focus on and why"],
 "competitors": ["1-3 points: which competitor is strong where and how to answer it"],
 "risks": ["0-3 points: customers or reps that need attention"],
 "actions": [{"who": "REP-.. or ղեկավարություն", "what": "one concrete action"}],
 "talking_points": [{"rep": "REP-..", "customer": "CUST-..", "points": ["1-3 short things to say or offer at this visit"]}]}
talking_points: one entry per item of this_week_picks (same rep and customer).`;

class StrategyError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Claims a run before any paid call, under a lock: never two at once (a run older than 10 minutes counts as stopped), and for "generate now"
// not within an hour of the last one. Returns the run id.
export async function claimStrategyRun({ db = pool, now = new Date(), userId = null, manual = false } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sales_strategy_run'))");
    await client.query("UPDATE sales_strategy_runs SET status = 'failed', finished_at = now(), error = 'stopped' WHERE status = 'running' AND started_at < now() - interval '10 minutes'");
    const { rows: [last] } = await client.query("SELECT status, started_at FROM sales_strategy_runs ORDER BY started_at DESC LIMIT 1");
    if (last?.status === "running") throw new StrategyError("A strategy is being written right now", 409, "running");
    if (manual && last && now - new Date(last.started_at) < 60 * 60 * 1000) throw new StrategyError("A strategy was made less than an hour ago", 429, "too_soon");
    const { rows: [run] } = await client.query(
      "INSERT INTO sales_strategy_runs (week_start, created_by, model) VALUES ($1, $2, $3) RETURNING id",
      [mondayOf(yerevanToday(now)), userId, STRATEGY_MODEL]
    );
    await client.query("COMMIT");
    return run.id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One run: build the input, call the model, unmask, store (replacing this week's report). The run row records the outcome, the tokens and the
// price whatever happens. `fetchImpl` / `apiKey` are injectable (tests).
export async function generateStrategy({ db = pool, now = new Date(), userId = null, fetchImpl = globalThis.fetch, apiKey = process.env.OPENAI_API_KEY, model = STRATEGY_MODEL, runId = null } = {}) {
  if (!apiKey) throw new StrategyError("The OpenAI key is not set on the server", 503, "not_configured");
  runId ??= await claimStrategyRun({ db, now, userId });
  let usage = {};
  try {
    const book = await strategyNameBook(db);
    const { input, masked, codeToId } = await buildStrategyInput({ db, now, book });
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_completion_tokens: MAX_ANSWER_TOKENS,
        // reasoning models: a short think is enough for a weekly summary (and keeps the price down)
        ...(/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: "low" } : {}),
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(170_000),
    });
    if (!res.ok) throw new StrategyError(`The AI service answered ${res.status}`, 502);
    const data = await res.json();
    usage = data?.usage ?? {};
    let parsed;
    try {
      parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "");
    } catch {
      throw new StrategyError("The AI answer could not be read", 502);
    }
    const report = unmaskDeep(normalizeReport(parsed), book);
    // the screen puts each talking point under its pick by customer id (a code the model wrote that matches no customer shows nowhere)
    for (const tp of report.talking_points) tp.customer_ids = codeToId.get(tp.customer) ?? [];
    const cost = estimateCostUsd(model, usage);
    const { rows: [row] } = await db.query(
      `INSERT INTO sales_strategy_reports (week_start, created_by, model, input_tokens, output_tokens, cost_usd, masked_names, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (week_start) DO UPDATE SET created_at = now(), created_by = EXCLUDED.created_by, model = EXCLUDED.model,
         input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd,
         masked_names = EXCLUDED.masked_names, report = EXCLUDED.report
       RETURNING id, week_start::text AS week_start, created_at, model, input_tokens, output_tokens, cost_usd::float8 AS cost_usd, masked_names, report`,
      [input.week_start, userId, data?.model || model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, cost, masked, JSON.stringify(report)]
    );
    await finishRun(db, runId, "done", model, usage, null);
    return row;
  } catch (err) {
    await finishRun(db, runId, "failed", model, usage, err.message).catch(() => {});
    throw err;
  }
}
const finishRun = (db, runId, status, model, usage, error) =>
  db.query(
    "UPDATE sales_strategy_runs SET status = $2, finished_at = now(), model = $3, input_tokens = $4, output_tokens = $5, cost_usd = $6, error = $7 WHERE id = $1",
    [runId, status, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, estimateCostUsd(model, usage), error ? String(error).slice(0, 300) : null]
  );

// The model's object -> the fields the screen shows, strings only, bounded (a malformed answer never breaks the screen).
const str = (v, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v, n = 8) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, n) : []);
export function normalizeReport(o = {}) {
  return {
    headline: str(o.headline, 300),
    situation: strList(o.situation),
    where_to_push: strList(o.where_to_push),
    competitors: strList(o.competitors),
    risks: strList(o.risks),
    actions: (Array.isArray(o.actions) ? o.actions : []).map((a) => ({ who: str(a?.who, 80), what: str(a?.what) })).filter((a) => a.what).slice(0, 10),
    talking_points: (Array.isArray(o.talking_points) ? o.talking_points : [])
      .map((t) => ({ rep: str(t?.rep, 40), customer: str(t?.customer, 40), points: strList(t?.points, 4) }))
      .filter((t) => t.points.length)
      .slice(0, 100),
  };
}
// Codes -> names everywhere in the report, but the talking points keep their codes too (the screen matches them to the picks).
function unmaskDeep(report, book) {
  const un = (s) => unmaskText(s, book);
  return {
    ...report,
    headline: un(report.headline),
    situation: report.situation.map(un),
    where_to_push: report.where_to_push.map(un),
    competitors: report.competitors.map(un),
    risks: report.risks.map(un),
    actions: report.actions.map((a) => ({ who: un(a.who), what: un(a.what) })),
    talking_points: report.talking_points.map((t) => ({ ...t, rep_name: un(t.rep), customer_name: un(t.customer), points: t.points.map(un) })),
  };
}

export async function latestStrategy(db = pool) {
  const [{ rows: [report] }, { rows: [run] }] = await Promise.all([
    db.query(
      `SELECT id, week_start::text AS week_start, created_at, model, input_tokens, output_tokens, cost_usd::float8 AS cost_usd, masked_names, report
       FROM sales_strategy_reports ORDER BY week_start DESC LIMIT 1`
    ),
    db.query("SELECT id, status, started_at, finished_at, error FROM sales_strategy_runs ORDER BY started_at DESC LIMIT 1"),
  ]);
  return { report: report ?? null, run: run ?? null };
}

// The weekly run (jobs/index.js, hourly): the first working day of the week after 10:00 Yerevan, once, when the key is set and the
// strategist is not off; after 3 failed runs in a week it waits for next week (the runs are counted in the database).
export async function runWeeklyStrategy(now = new Date(), db = pool) {
  if (!isStrategistConfigured()) return { skipped: "not_configured" };
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off" || settings.strategistMode === "off") return { skipped: "off" };
  const day = yerevanToday(now);
  if (minuteOfDay(now) < RUN_FROM_MINUTE || !(await isWorkingDay(db, day))) return { skipped: "not_now" };
  const week = mondayOf(day);
  const { rowCount } = await db.query("SELECT 1 FROM sales_strategy_reports WHERE week_start = $1", [week]);
  if (rowCount) return { skipped: "done" };
  const { rows: [f] } = await db.query("SELECT COUNT(*)::int AS n FROM sales_strategy_runs WHERE week_start = $1 AND status = 'failed'", [week]);
  if (f.n >= MAX_WEEKLY_FAILURES) return { skipped: "gave_up" };
  // this week's picks first (the jobs start side by side after a restart): the talking points are written for them. Picking is locked and
  // once a week, so this only waits for, or does, what the steps job would do anyway.
  await runWeeklyPicks(now, db);
  const row = await generateStrategy({ db, now });
  return { generated: row.id };
}
