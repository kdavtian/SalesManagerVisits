// AI check of a photographed order blank (owner, 2026-10-26; the switch is OFF by default). A Claude model looks at the photo and reports what
// is written on the paper (order number, total, signatures); the server compares that with the orders the document is linked to and stores
// the verdict on the document: ok / issues / unreadable. The rep hears about a problem at once (a retake is still possible), the accountant finds
// the same documents under "Problems" in the Documents inbox.
// Cost control, like Ask KAD: every check records its cost; once the month's total reaches the cap set in App configuration, no new check runs.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "./db/pool.js";
import { uploadDirPath } from "./upload.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";

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
      notes: { type: "string", description: "one short sentence about anything odd (crossed-out lines, handwriting over the table...), or empty" },
    },
    required: ["legible", "order_number", "total_amd", "customer_signature_present", "rep_signature_present", "notes"],
  },
};

const PROMPT = `This is a photo of a printed Armenian delivery-acceptance act ("ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ") of KAD Motors, a lubricants distributor. Read it and report with the report_blank tool. Do not guess: if a value cannot be read, use null; if the whole photo is unreadable, set legible to false.`;

// What the model read vs the orders the document is linked to. Returns { status, issues: [{ code, ...params }] }.
// Pure, so the rules can be tested without the model.
export function judgeBlank(read, orders) {
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
  if (!read.customer_signature_present) issues.push({ code: "no_customer_signature" });
  if (!read.rep_signature_present) issues.push({ code: "no_rep_signature" });
  return { status: issues.length ? "issues" : "ok", issues };
}

// Sends the photo to the model; returns { read, usage }. `client` can be injected (tests).
export async function readBlankPhoto(buffer, { client = null, model = AI_CHECK_MODEL } = {}) {
  // Always a modest JPEG: the model reads printed text fine at this size and the request stays cheap.
  const sharp = (await import("sharp")).default; // on use: a server without the image library must still start
  const jpeg = await sharp(buffer, { failOn: "none" }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const api = client ?? defaultClient();
  const response = await api.messages.create({
    model,
    max_tokens: 1000,
    tools: [READ_TOOL],
    tool_choice: { type: "tool", name: READ_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
          { type: "text", text: PROMPT },
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
  const { rows } = await db.query("SELECT id, customer_id, kind, mime, file_path, order_ids, created_by, ai_status FROM customer_files WHERE id = $1", [fileId]);
  const file = rows[0];
  if (!file || file.kind !== "order_blank" || !file.mime.startsWith("image/")) return null;
  if (file.ai_status && !force) return null;
  if ((await aiCheckMonthSpendUsd(db)) >= settings.capUsd) return null;

  await db.query("UPDATE customer_files SET ai_status = 'pending' WHERE id = $1", [file.id]);
  let verdict;
  try {
    const buffer = await fs.promises.readFile(path.join(uploadDirPath, file.file_path));
    const { read, usage } = await readBlankPhoto(buffer, { client });
    const { rows: orders } = file.order_ids.length ? await db.query("SELECT order_code, total_amd FROM orders WHERE id = ANY($1)", [file.order_ids]) : { rows: [] };
    verdict = { ...judgeBlank(read, orders), read, cost_usd: Math.round(estimateCostUsd(AI_CHECK_MODEL, usage) * 100000) / 100000 };
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
