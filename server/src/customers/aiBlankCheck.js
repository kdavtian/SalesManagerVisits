// AI check of a photographed order blank (owner, 2026-10-26; the switch is OFF by default). A Claude model looks at the photo and reports what
// is written on the paper (order number, total, signatures); the server compares that with the orders the document is linked to and stores
// the verdict on the document: ok / issues / unreadable. The rep hears about a problem at once (a retake is still possible), the accountant finds
// the same documents under "Problems" in the Documents inbox.
// Cost control, like Ask KAD: every check records its cost; once the month's total reaches the cap set in App configuration, no new check runs.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db/pool.js";
import { uploadDirPath } from "../shared/upload.js";
import { notifyUser } from "../shared/notifications.js";
import { yerevanToday } from "../utils/yerevanDate.js";

export const AI_CHECK_MODEL = process.env.AI_BLANK_CHECK_MODEL || "claude-sonnet-5-5";
// USD per million tokens, as in askKad/engine.js (an unknown model is priced like the dearest one, so the cap errs on the safe side).
const PRICES = { "claude-sonnet-5-5": { input: 2, output: 10 }, "claude-opus-5-5": { input: 4, output: 20 }, "claude-haiku-5-5": { input: 0.1, output: 0.5 } };
export const estimateCostUsd = (model, usage) => {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output) / 1e6;
};

export const isAiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);
let sharedClient = null;
const defaultClient = () => (sharedClient ??= new Anthropic());

export async function getAiCheckSettings(db = pool) {
  const { rows } = await db.query("SELECT ai_blank_check_enabled, ai_blank_check_monthly_cap_usd FROM app_settings WHERE id = 1");
  return { enabled: rows[0]?.ai_blank_check_enabled ?? false, capUsd: Number(rows[0]?.ai_blank_check_monthly_cap_usd ?? 10) };
}
export async function setAiCheckEnabled(enabled, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO app_settings (id, ai_blank_check_enabled) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET ai_blank_check_enabled = EXCLUDED.ai_blank_check_enabled RETURNING ai_blank_check_enabled`,
    [enabled]
  );
  return rows[0].ai_blank_check_enabled;
}
export async function setAiCheckMonthlyCapUsd(usd, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO app_settings (id, ai_blank_check_monthly_cap_usd) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET ai_blank_check_monthly_cap_usd = EXCLUDED.ai_blank_check_monthly_cap_usd RETURNING ai_blank_check_monthly_cap_usd`,
    [usd]
  );
  return Number(rows[0].ai_blank_check_monthly_cap_usd);
}
export async function aiCheckMonthSpendUsd(db = pool, today = yerevanToday()) {
  const { rows } = await db.query(
    // the ledger (migration 202): every model call, also one whose verdict was later replaced (re-check, turned photo) or that failed
    "SELECT COALESCE(sum(cost_usd), 0) AS spent FROM ai_check_spend WHERE (spent_at AT TIME ZONE 'Asia/Yerevan')::date >= $1::date",
    [`${today.slice(0, 7)}-01`]
  );
  return Number(rows[0].spent);
}

const READ_TOOL = {
  name: "report_blank",
  description: "Report what is written on the photographed delivery-acceptance act (order blank).",
  input_schema: {
    type: "object",
    properties: {
      legible: { type: "boolean", description: "false when the photo is too blurry, cut off, dark or not an order blank, so the numbers cannot be read" },
      order_number: { type: ["string", "null"], description: "the order number printed after 'Պատվերի No', digits and letters exactly as written" },
      total_amd: { type: ["number", "null"], description: "the ԸՆԴԱՄԵՆԸ total of the table in AMD, a plain number" },
      customer_signature_present: { type: "boolean", description: "a handwritten signature (or a drawn electronic one) exists on the line after 'Ընդունեց'" },
      rep_signature_present: { type: "boolean", description: "a handwritten signature exists on the line after 'Հանձնեց'" },
      payment_amd: { type: ["number", "null"], description: "the amount written after 'Վճարում՝' (money paid at delivery) in AMD, a plain number; null when that field is empty or absent" },
      notes: { type: "string", description: "one short sentence about anything odd (crossed-out lines, handwriting over the table...), or empty" },
    },
    required: ["legible", "order_number", "total_amd", "customer_signature_present", "rep_signature_present", "payment_amd", "notes"],
  },
};

// A payment slip (receipt, orderBlankPdf.js): the amount paid and two signatures ('Ստացավ' = the rep received it, 'Վճարեց' = the customer paid).
const READ_SLIP_TOOL = {
  name: "report_slip",
  description: "Report what is written on the photographed payment slip (receipt).",
  input_schema: {
    type: "object",
    properties: {
      legible: { type: "boolean", description: "false when the photo is too blurry, cut off, dark or not a payment slip, so the amount cannot be read" },
      amount_amd: { type: ["number", "null"], description: "the amount written after 'Վճարում՝' in AMD, a plain number" },
      receiver_signature_present: { type: "boolean", description: "a handwritten signature exists on the line after 'Ստացավ'" },
      payer_signature_present: { type: "boolean", description: "a handwritten signature (or a drawn electronic one) exists on the line after 'Վճարեց'" },
      notes: { type: "string", description: "one short sentence about anything odd, or empty" },
    },
    required: ["legible", "amount_amd", "receiver_signature_present", "payer_signature_present", "notes"],
  },
};
const PROMPT = `This is a photo of a printed Armenian delivery-acceptance act ("ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ") of KAD Motors, a lubricants distributor. Read it and report with the report_blank tool. Do not guess: if a value cannot be read, use null; if the whole photo is unreadable, set legible to false.`;
const SLIP_PROMPT = `This is a photo of a printed Armenian payment slip (receipt) of KAD Motors, a lubricants distributor. Read it and report with the report_slip tool. Do not guess: if a value cannot be read, use null; if the whole photo is unreadable, set legible to false.`;

// The kinds Vaghinak reads (owner, 2026-11-12): the photographed order blank carries the order; the slip carries a payment. (A signed act made
// by the app is a PDF, so only a photographed one is ever read.)
export const BLANK_KINDS = ["order_blank", "signed_act"];
export const CHECKED_KINDS = [...BLANK_KINDS, "payment_slip"];
// Bumped when the rules change: a verdict of an older version never earns the "Checked" chip (orders/vaghinakChecked.js).
export const CHECK_VERSION = 2;

// A number the model read: "20 000", "20,000" and 20000 are the same; anything else is "not read" (null), never NaN (which compares false
// with everything and would let a wrong amount pass).
export function readAmount(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const text = String(v).replace(/[\s,]/g, "").replace(/(դր|amd|֏)\.?$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null; // "abc", "20 000 / 5" ... : not a clean number
  return Number(text);
}

// What the model read on a slip vs the app payment it is linked to (null = no payment linked: only the signatures are checked).
export function judgeSlip(read, payment) {
  if (!read.legible) return { status: "unreadable", issues: [{ code: "not_readable" }] };
  const issues = [];
  const amount = readAmount(read.amount_amd);
  if (payment) {
    if (amount == null) issues.push({ code: "payment_not_read", expected: Math.round(Number(payment.amount_amd)) });
    else if (Math.abs(amount - Number(payment.amount_amd)) > 1) issues.push({ code: "payment_mismatch", found: Math.round(amount), expected: Math.round(Number(payment.amount_amd)) });
  }
  if (!read.payer_signature_present) issues.push({ code: "no_customer_signature" });
  if (!read.receiver_signature_present) issues.push({ code: "no_receiver_signature" });
  return { status: issues.length ? "issues" : "ok", issues };
}

// What the model read vs the orders the document is linked to. Returns { status, issues: [{ code, ...params }] }.
// Pure, so the rules can be tested without the model.
// `collectedAmd` (owner, 2026-11-12: "check if all information matches payments and orders"): for a blank of ONE delivered order, what the app
// recorded as paid at delivery (the delivery record, or the payment of the visit it was delivered at); 0 when nothing was paid; undefined when
// the order is not delivered yet (nothing to compare). A payment written on the paper must equal it -- also money on the paper that the app
// does not have (the cash a rep keeps). An empty payment line is not an issue: the printed blank leaves it blank and not every rep fills it in.
export function judgeBlank(read, orders, { collectedAmd } = {}) {
  const issues = [];
  if (!read.legible) return { status: "unreadable", issues: [{ code: "not_readable" }] };
  const codes = orders.map((o) => String(o.order_code ?? "").trim()).filter(Boolean);
  const number = read.order_number == null ? "" : String(read.order_number).trim();
  if (number && codes.length && !codes.some((c) => c.toLowerCase() === number.toLowerCase())) {
    issues.push({ code: "order_number_mismatch", found: number, expected: codes.join(", ") });
  }
  // a paper whose number cannot be read could be any order's (the same basket every month): it cannot prove this one
  if (!number && codes.length) issues.push({ code: "order_number_not_read", expected: codes.join(", ") });
  // One order linked: its total must match the paper's (1 AMD of rounding allowed). With several, the paper may be any one of them.
  const total = readAmount(read.total_amd);
  if (orders.length === 1) {
    if (total == null) issues.push({ code: "total_not_read", expected: Math.round(Number(orders[0].total_amd)) });
    else if (Math.abs(total - Number(orders[0].total_amd)) > 1) issues.push({ code: "total_mismatch", found: Math.round(total), expected: Math.round(Number(orders[0].total_amd)) });
  }
  const paid = readAmount(read.payment_amd);
  if (orders.length === 1 && collectedAmd !== undefined && paid != null && paid > 0) {
    const expected = Math.round(Number(collectedAmd ?? 0));
    if (Math.abs(paid - expected) > 1) issues.push({ code: "payment_mismatch", found: Math.round(paid), expected });
  }
  if (!read.customer_signature_present) issues.push({ code: "no_customer_signature" });
  if (!read.rep_signature_present) issues.push({ code: "no_rep_signature" });
  return { status: issues.length ? "issues" : "ok", issues };
}

// Sends the photo to the model; returns { read, usage }. `client` can be injected (tests).
export async function readBlankPhoto(buffer, { client = null, model = AI_CHECK_MODEL, slip = false } = {}) {
  const tool = slip ? READ_SLIP_TOOL : READ_TOOL;
  // Always a modest JPEG: the model reads printed text fine at this size and the request stays cheap.
  const sharp = (await import("sharp")).default; // on use: a server without the image library must still start
  const jpeg = await sharp(buffer, { failOn: "none" }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const api = client ?? defaultClient();
  const response = await api.messages.create({
    model,
    max_tokens: 1000,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: slip ? SLIP_PROMPT : PROMPT },
        ],
      },
    ],
  });
  const block = response.content?.find((b) => b.type === "tool_use");
  if (!block) throw new Error("the model returned no reading");
  return { read: block.input, usage: response.usage ?? {} };
}

// What the app recorded as paid when ONE order was delivered: the latest delivery record (driver), else the payment saved at the visit the
// paper was photographed at (deliveries at a visit write no delivery record, the money goes to payments with client_ref "checkin-<id>").
// undefined = the order is not delivered yet: nothing to compare.
async function collectedAtDelivery(db, orderId, checkinId) {
  const { rows: [o] } = await db.query("SELECT status FROM orders WHERE id = $1", [orderId]);
  if (!o || !["delivered", "recorded"].includes(o.status)) return undefined;
  const { rows: pod } = await db.query("SELECT amount_collected_amd FROM pod_records WHERE order_id = $1 ORDER BY id DESC LIMIT 1", [orderId]);
  if (pod[0]) return Number(pod[0].amount_collected_amd ?? 0);
  if (checkinId) {
    const { rows: pay } = await db.query("SELECT COALESCE(sum(amount_amd), 0) AS amd FROM payments WHERE client_ref = $1 AND status <> 'rejected'", [`checkin-${checkinId}`]);
    return Number(pay[0].amd);
  }
  return 0;
}

const MAX_ATTEMPTS = 3;
const STALE_PENDING_MINUTES = 15;

// Checks one stored document (a photographed order blank / act, or a payment slip), saves the verdict and tells the uploader when something is
// wrong. Returns the verdict, or null when nothing was done (switch off, no key, cap reached, not a readable kind, already checked, someone
// else is checking it right now, or the call failed).
// The file is CLAIMED first (one atomic update), so the upload, Vaghinak's round and a manual re-check never pay twice for the same photo;
// the verdict is written only if the photo is still the one that was read (version: turning it starts a new check).
export async function checkFileWithAi(fileId, { client = null, db = pool, force = false, notify = true } = {}) {
  if (!client && !isAiConfigured()) return null;
  const settings = await getAiCheckSettings(db);
  if (!settings.enabled) return null;
  if ((await aiCheckMonthSpendUsd(db)) >= settings.capUsd) return null;
  const { rows } = await db.query(
    `UPDATE customer_files SET ai_status = 'pending', ai_checked_at = now()
     WHERE id = $1 AND kind = ANY($2) AND mime LIKE 'image/%'
       AND (ai_status IS NULL OR (ai_status = 'error' AND ai_attempts < $4)
            OR (ai_status = 'pending' AND ai_checked_at < now() - make_interval(mins => $5))
            OR ($3 AND ai_status <> 'pending'))
     RETURNING id, customer_id, kind, file_path, order_ids, payment_id, checkin_id, created_by, created_at, version`,
    [fileId, CHECKED_KINDS, force, MAX_ATTEMPTS, STALE_PENDING_MINUTES]
  );
  const file = rows[0];
  if (!file) return null;

  let verdict;
  let costUsd = 0;
  try {
    const buffer = await fs.promises.readFile(path.join(uploadDirPath, file.file_path));
    const slip = file.kind === "payment_slip";
    const { read: raw, usage } = await readBlankPhoto(buffer, { client, slip });
    // amounts stored as plain numbers ("55 500" -> 55500), so the chip's SQL can compare them
    const read = { ...raw, ...(slip ? { amount_amd: readAmount(raw.amount_amd) } : { total_amd: readAmount(raw.total_amd), payment_amd: readAmount(raw.payment_amd) }) };
    costUsd = Math.round(estimateCostUsd(AI_CHECK_MODEL, usage) * 100000) / 100000;
    await db.query("INSERT INTO ai_check_spend (file_id, cost_usd) VALUES ($1, $2)", [file.id, costUsd]);
    let judged;
    if (slip) {
      const { rows: pays } = file.payment_id ? await db.query("SELECT amount_amd FROM payments WHERE id = $1", [file.payment_id]) : { rows: [] };
      judged = judgeSlip(read, pays[0] ?? null);
    } else {
      const { rows: orders } = file.order_ids.length ? await db.query("SELECT order_code, total_amd, status FROM orders WHERE id = ANY($1)", [file.order_ids]) : { rows: [] };
      const collectedAmd = file.order_ids.length === 1 ? await collectedAtDelivery(db, file.order_ids[0], file.checkin_id) : undefined;
      // read once every linked order was delivered: the verdict is final (Vaghinak's round does not read it again)
      const afterDelivery = orders.length > 0 && orders.every((o) => o.status === "delivered" || o.status === "recorded");
      judged = { ...judgeBlank(read, orders, { collectedAmd }), expected_collected_amd: collectedAmd ?? null, after_delivery: afterDelivery };
    }
    verdict = { ...judged, read, v: CHECK_VERSION, cost_usd: costUsd };
  } catch (err) {
    // A failed check never blocks anyone: the document is left as "error" and tried again later (at most MAX_ATTEMPTS times).
    console.error("AI blank check failed:", err.message);
    await db.query(
      "UPDATE customer_files SET ai_status = 'error', ai_attempts = ai_attempts + 1, ai_result = $3 WHERE id = $1 AND ai_status = 'pending' AND version = $2",
      [file.id, file.version, JSON.stringify({ error: String(err.message).slice(0, 200), cost_usd: costUsd })]
    );
    return null;
  }
  const { rowCount } = await db.query(
    "UPDATE customer_files SET ai_status = $3, ai_result = $4, ai_checked_at = now(), ai_attempts = 0 WHERE id = $1 AND ai_status = 'pending' AND version = $2",
    [file.id, file.version, verdict.status, JSON.stringify(verdict)]
  );
  if (!rowCount) return null; // the photo was turned / replaced meanwhile: its own check decides
  // the person who took it hears about a problem while a retake is still possible (not about a weeks-old paper Vaghinak read in his round)
  const fresh = Date.now() - new Date(file.created_at).getTime() < 24 * 3600 * 1000;
  if (notify && fresh && verdict.status !== "ok" && file.created_by) {
    const slip = file.kind === "payment_slip";
    notifyUser(file.created_by, "document_issue", {
      title: verdict.status === "unreadable" ? "Փաստաթղթի նկարը չի կարդացվում" : "Փաստաթղթում խնդիր կա",
      body: slip ? "Ստուգեք վճարման անդորրագրի նկարը և անհրաժեշտության դեպքում նորից նկարեք։" : "Ստուգեք պատվերի թերթիկի նկարը և անհրաժեշտության դեպքում նորից նկարեք։",
      url: `/#/customers/${file.customer_id}`,
    });
  }
  return verdict;
}

// Fire-and-forget after a document is saved: never throws, never delays the response.
export function scheduleAiCheck(fileId) {
  checkFileWithAi(fileId).catch((err) => console.error("AI blank check failed:", err.message));
}

// Vaghinak's round (owner, 2026-11-12): the papers of delivered / recorded orders of the last `days` days that have no current verdict --
// never checked, checked before the order was delivered (the payment could not be compared then), checked by older rules, or failed earlier
// (a few tries) -- and the unchecked payment slips. A few per run, oldest first; a broken photo is skipped, not waited on. The monthly cap
// still holds. Returns how many were checked.
let roundRunning = false;
export async function checkRecentDocuments({ db = pool, client = null, limit = 10, days = 30, customerId = null } = {}) {
  if (!client && !isAiConfigured()) return 0;
  if (roundRunning) return 0;
  roundRunning = true;
  try {
    return await documentRound({ db, client, limit, days, customerId });
  } finally {
    roundRunning = false;
  }
}
async function documentRound({ db, client, limit, days, customerId }) {
  const settings = await getAiCheckSettings(db);
  if (!settings.enabled) return 0;
  const { rows } = await db.query(
    `SELECT f.id, f.ai_status FROM customer_files f
     WHERE f.mime LIKE 'image/%' AND f.created_at > now() - make_interval(days => $1)
       AND ($4::int IS NULL OR f.customer_id = $4)
       AND (f.ai_status IS NULL OR (f.ai_status = 'error' AND f.ai_attempts < $5 AND f.ai_checked_at < now() - interval '1 hour')
            OR (f.ai_status = 'pending' AND f.ai_checked_at < now() - make_interval(mins => $6))
            OR (f.ai_status IN ('ok', 'issues') AND f.kind = ANY($2)
                AND (CASE WHEN jsonb_typeof(f.ai_result->'v') = 'number' THEN (f.ai_result->>'v')::numeric < $7 ELSE true END
                     OR f.ai_result->'after_delivery' IS DISTINCT FROM 'true'::jsonb)))
       AND ((f.kind = ANY($2) AND cardinality(f.order_ids) > 0
             AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = ANY(f.order_ids) AND o.status NOT IN ('delivered', 'recorded')))
            OR (f.kind = 'payment_slip' AND f.ai_status IS DISTINCT FROM 'ok' AND f.ai_status IS DISTINCT FROM 'issues'))
     ORDER BY f.created_at LIMIT $3`,
    [days, BLANK_KINDS, limit, customerId, MAX_ATTEMPTS, STALE_PENDING_MINUTES, CHECK_VERSION]
  );
  let checked = 0;
  for (const { id, ai_status } of rows) {
    if ((await aiCheckMonthSpendUsd(db)) >= settings.capUsd) break; // the month's budget is spent
    // a verdict of older rules / from before the delivery is re-read (force); the person is not told again about an old paper
    if (await checkFileWithAi(id, { db, client, force: ai_status === "ok" || ai_status === "issues", notify: false })) checked++;
  }
  return checked;
}
