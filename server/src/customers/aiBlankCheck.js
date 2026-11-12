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
    "SELECT COALESCE(sum((ai_result->>'cost_usd')::numeric), 0) AS spent FROM customer_files WHERE ai_checked_at IS NOT NULL AND (ai_checked_at AT TIME ZONE 'Asia/Yerevan')::date >= $1::date",
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
const SLIP_PROMPT = `This is a photo of a printed Armenian payment slip (receipt) of KAD Motors, a lubricants distributor. Read it and report with the report_slip tool. Do not guess: if a value cannot be read, use null; if the whole photo is unreadable, set legible to false.`;

// The kinds Vaghinak reads (owner, 2026-11-12): the order blank and the signed act carry the order; the slip carries a payment.
export const BLANK_KINDS = ["order_blank", "signed_act"];
export const CHECKED_KINDS = [...BLANK_KINDS, "payment_slip"];

// What the model read on a slip vs the app payment it is linked to (null = no payment linked: only the signatures are checked).
export function judgeSlip(read, payment) {
  if (!read.legible) return { status: "unreadable", issues: [{ code: "not_readable" }] };
  const issues = [];
  if (payment && read.amount_amd != null && Math.abs(Number(read.amount_amd) - Number(payment.amount_amd)) > 1) {
    issues.push({ code: "payment_mismatch", found: Math.round(Number(read.amount_amd)), expected: Math.round(Number(payment.amount_amd)) });
  }
  if (payment && read.amount_amd == null) issues.push({ code: "payment_not_read" });
  if (!read.payer_signature_present) issues.push({ code: "no_customer_signature" });
  if (!read.receiver_signature_present) issues.push({ code: "no_rep_signature" });
  return { status: issues.length ? "issues" : "ok", issues };
}

const PROMPT = `This is a photo of a printed Armenian delivery-acceptance act ("ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ") of KAD Motors, a lubricants distributor. Read it and report with the report_blank tool. Do not guess: if a value cannot be read, use null; if the whole photo is unreadable, set legible to false.`;

// What the model read vs the orders the document is linked to. Returns { status, issues: [{ code, ...params }] }.
// Pure, so the rules can be tested without the model.
// `collectedAmd`: what the driver / rep recorded as collected at delivery (the order's delivery record), for a blank of ONE order; the paper's
// "Վճարում" must then say the same (owner, 2026-11-12: "check if all information matches payments and orders").
export function judgeBlank(read, orders, { collectedAmd = null } = {}) {
  const issues = [];
  if (!read.legible) return { status: "unreadable", issues: [{ code: "not_readable" }] };
  const codes = orders.map((o) => String(o.order_code ?? "").trim()).filter(Boolean);
  if (read.order_number && codes.length && !codes.some((c) => c.toLowerCase() === String(read.order_number).trim().toLowerCase())) {
    issues.push({ code: "order_number_mismatch", found: String(read.order_number), expected: codes.join(", ") });
  }
  // One order linked: its total must match the paper's (1 AMD of rounding allowed). With several, the paper may be any one of them.
  if (read.total_amd != null && orders.length === 1 && Math.abs(Number(read.total_amd) - Number(orders[0].total_amd)) > 1) {
    issues.push({ code: "total_mismatch", found: Math.round(Number(read.total_amd)), expected: Math.round(Number(orders[0].total_amd)) });
  }
  if (orders.length === 1 && collectedAmd != null && Number(collectedAmd) > 0) {
    if (read.payment_amd == null) issues.push({ code: "payment_not_read", expected: Math.round(Number(collectedAmd)) });
    else if (Math.abs(Number(read.payment_amd) - Number(collectedAmd)) > 1) {
      issues.push({ code: "payment_mismatch", found: Math.round(Number(read.payment_amd)), expected: Math.round(Number(collectedAmd)) });
    }
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

// Checks one stored document (only a photographed order blank), saves the verdict and tells the uploader when something is wrong.
// Returns the verdict, or null when nothing was done (switch off, no key, cap reached, not an order-blank photo, already checked).
export async function checkFileWithAi(fileId, { client = null, db = pool, force = false } = {}) {
  if (!client && !isAiConfigured()) return null;
  const settings = await getAiCheckSettings(db);
  if (!settings.enabled) return null;
  const { rows } = await db.query("SELECT id, customer_id, kind, mime, file_path, order_ids, payment_id, created_by, ai_status FROM customer_files WHERE id = $1", [fileId]);
  const file = rows[0];
  if (!file || !CHECKED_KINDS.includes(file.kind) || !file.mime.startsWith("image/")) return null;
  if (file.ai_status && !force) return null;
  if ((await aiCheckMonthSpendUsd(db)) >= settings.capUsd) return null;

  await db.query("UPDATE customer_files SET ai_status = 'pending' WHERE id = $1", [file.id]);
  let verdict;
  try {
    const buffer = await fs.promises.readFile(path.join(uploadDirPath, file.file_path));
    const slip = file.kind === "payment_slip";
    const { read, usage } = await readBlankPhoto(buffer, { client, slip });
    let judged;
    if (slip) {
      const { rows: pays } = file.payment_id ? await db.query("SELECT amount_amd FROM payments WHERE id = $1", [file.payment_id]) : { rows: [] };
      judged = judgeSlip(read, pays[0] ?? null);
    } else {
      const { rows: orders } = file.order_ids.length ? await db.query("SELECT order_code, total_amd FROM orders WHERE id = ANY($1)", [file.order_ids]) : { rows: [] };
      // what was recorded as collected at delivery (the latest delivery record of that one order)
      const { rows: pod } = file.order_ids.length === 1
        ? await db.query("SELECT amount_collected_amd FROM pod_records WHERE order_id = $1 ORDER BY id DESC LIMIT 1", [file.order_ids[0]])
        : { rows: [] };
      judged = judgeBlank(read, orders, { collectedAmd: pod[0]?.amount_collected_amd ?? null });
    }
    verdict = { ...judged, read, cost_usd: Math.round(estimateCostUsd(AI_CHECK_MODEL, usage) * 100000) / 100000 };
  } catch (err) {
    // A failed call must never block anyone: the document simply stays unchecked (and can be checked again).
    console.error("AI blank check failed:", err.message);
    await db.query("UPDATE customer_files SET ai_status = NULL WHERE id = $1 AND ai_status = 'pending'", [file.id]);
    return null;
  }
  await db.query("UPDATE customer_files SET ai_status = $2, ai_result = $3, ai_checked_at = now() WHERE id = $1", [file.id, verdict.status, JSON.stringify(verdict)]);
  if (verdict.status !== "ok" && file.created_by) {
    notifyUser(file.created_by, "document_issue", {
      title: verdict.status === "unreadable" ? "Փաստաթղթի նկարը չի կարդացվում" : "Փաստաթղթում խնդիր կա",
      body: "Ստուգեք պատվերի թերթիկի նկարը և անհրաժեշտության դեպքում նորից նկարեք։",
      url: `/#/customers/${file.customer_id}`,
    });
  }
  return verdict;
}

// Fire-and-forget after a document is saved: never throws, never delays the response.
export function scheduleAiCheck(fileId) {
  checkFileWithAi(fileId).catch((err) => console.error("AI blank check failed:", err.message));
}

// Vaghinak's round over documents uploaded before the check was on, or while it was off (owner, 2026-11-12): the unchecked blanks / acts of
// delivered or recorded orders and the unchecked payment slips of the last `days` days, a few per run, oldest first. The monthly cap still holds
// (checkFileWithAi stops at it). Returns how many were checked.
let roundRunning = false;
export async function checkRecentDocuments({ db = pool, client = null, limit = 10, days = 30 } = {}) {
  if (!client && !isAiConfigured()) return 0;
  if (roundRunning) return 0;
  roundRunning = true;
  try {
    return await documentRound({ db, client, limit, days });
  } finally {
    roundRunning = false;
  }
}
async function documentRound({ db, client, limit, days }) {
  if (!(await getAiCheckSettings(db)).enabled) return 0;
  const { rows } = await db.query(
    `SELECT f.id FROM customer_files f
     WHERE f.ai_status IS NULL AND f.mime LIKE 'image/%' AND f.created_at > now() - make_interval(days => $1)
       AND ((f.kind = ANY($2) AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ANY(f.order_ids) AND o.status IN ('delivered', 'recorded')))
            OR f.kind = 'payment_slip')
     ORDER BY f.created_at LIMIT $3`,
    [days, BLANK_KINDS, limit]
  );
  let checked = 0;
  for (const { id } of rows) {
    if (await checkFileWithAi(id, { db, client })) checked++;
    else break; // the cap was reached, or the call failed: try again next run
  }
  return checked;
}
