// Texts the owner edits in Settings > Sales & customers (owner, 2026-10-27):
//  - what the customer reads on the signature page before signing (orders received / payment / both), with the order number(s), the
//    amount and the debt left filled in by the app ([order no], [payment amount], [updated debt balance]);
//  - the warning printed at the bottom of every blank (order blanks, signed acts, payment slips).
// Stored in app_settings.document_texts; a key that is missing or empty falls back to the built-in text below.
import { pool } from "./db/pool.js";

export const DOCUMENT_TEXT_DEFAULTS = {
  sign_order: "Սույնով հաստատում եմ, որ ստացա [order no] պատվերը: Պարտքի մնացորդը կազմում է [updated debt balance] դրամ։",
  sign_payment: "Սույնով հաստատում եմ, որ վճարեցի [payment amount] դրամ: Պարտքի մնացորդը կազմում է [updated debt balance] դրամ։",
  sign_order_payment: "Սույնով հաստատում եմ, որ ստացա [order no] պատվերը և վճարեցի [payment amount] դրամ: Պարտքի մնացորդը կազմում է [updated debt balance] դրամ։",
  pdf_warning: "ՀԱՍՏԱՏՈՒՄԸ ԿՍՏԱՆԱՔ ՆԱԵՎ whatsapp ԽՄԲՈՒՄ 2 աշխատանքային օրվա ընթացքում: Չստանալու դեպքում խնդրում ենք անմիջապես կապվել գրասենյակի հետ։ Հեռ՝ 091 007 019:",
};
export const DOCUMENT_TEXT_KEYS = Object.keys(DOCUMENT_TEXT_DEFAULTS);
const MAX_LEN = 600;

export async function getDocumentTexts(db = pool) {
  const { rows } = await db.query("SELECT document_texts FROM app_settings WHERE id = 1");
  const saved = rows[0]?.document_texts ?? {};
  return Object.fromEntries(DOCUMENT_TEXT_KEYS.map((k) => [k, typeof saved[k] === "string" && saved[k].trim() ? saved[k] : DOCUMENT_TEXT_DEFAULTS[k]]));
}

/** Saves the given keys (an empty text = back to the built-in one). Returns the texts in use. */
export async function setDocumentTexts(patch, db = pool) {
  const clean = {};
  for (const k of DOCUMENT_TEXT_KEYS) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] ?? "").trim().slice(0, MAX_LEN);
    clean[k] = v && v !== DOCUMENT_TEXT_DEFAULTS[k] ? v : null;
  }
  await db.query(
    `INSERT INTO app_settings (id, document_texts) VALUES (1, jsonb_strip_nulls($1::jsonb))
     ON CONFLICT (id) DO UPDATE SET document_texts = jsonb_strip_nulls(app_settings.document_texts || $1::jsonb)`,
    [JSON.stringify(clean)]
  );
  return getDocumentTexts(db);
}

// ---- default visit frequency per customer type -------------------------------------------------------------------------------
// Keys of app_settings.visit_frequency_by_type, in the order Settings lists them. potential_1..4 = No / Low / Real / High potential.
export const VISIT_TYPE_KEYS = ["cvo", "pco", "oem", "sm", "cas", "kf", "potential_1", "potential_2", "potential_3", "potential_4", "competitor", "bronze", "silver", "gold"];

export async function getVisitFrequencyByType(db = pool) {
  const { rows } = await db.query("SELECT visit_frequency_by_type FROM app_settings WHERE id = 1");
  const saved = rows[0]?.visit_frequency_by_type ?? {};
  return Object.fromEntries(VISIT_TYPE_KEYS.map((k) => [k, Number(saved[k]) > 0 ? Number(saved[k]) : null]));
}

/** patch: { key: days | null }. null / empty = no default for that type. Every customer that follows the defaults is recomputed. */
export async function setVisitFrequencyByType(patch, db = pool) {
  const current = await getVisitFrequencyByType(db);
  for (const k of VISIT_TYPE_KEYS) {
    if (patch[k] === undefined) continue;
    const n = patch[k] === null || patch[k] === "" ? null : Math.round(Number(patch[k]));
    if (n !== null && !(n >= 1 && n <= 365)) throw Object.assign(new Error(`${k}: days must be between 1 and 365`), { status: 400 });
    current[k] = n;
  }
  const stored = Object.fromEntries(Object.entries(current).filter(([, v]) => v !== null));
  await db.query(
    `INSERT INTO app_settings (id, visit_frequency_by_type) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET visit_frequency_by_type = EXCLUDED.visit_frequency_by_type`,
    [JSON.stringify(stored)]
  );
  await recomputeDefaultVisitFrequencies(db);
  return current;
}

/** Re-applies the type defaults to every customer whose frequency was not set by hand (the trigger of migration 162 does the maths). */
export async function recomputeDefaultVisitFrequencies(db = pool) {
  const { rowCount } = await db.query(
    `UPDATE customers SET visit_frequency_days = visit_frequency_days
     WHERE NOT visit_frequency_manual
       AND visit_frequency_days IS DISTINCT FROM customer_default_visit_days(sales_channel, customer_tier, potential_level)`
  );
  return rowCount;
}

/** The sentence the customer reads before signing. balance null (no Excel figure) drops the sentence about the debt. */
export function signStatement(texts, { orderCodes = [], paymentAmd = null, balanceAfterAmd = null }) {
  const amd = (n) => Math.round(Number(n)).toLocaleString("en-US");
  const hasOrders = orderCodes.length > 0;
  const hasPayment = Number(paymentAmd) > 0;
  const template = hasOrders && hasPayment ? texts.sign_order_payment : hasOrders ? texts.sign_order : hasPayment ? texts.sign_payment : "";
  let text = template;
  if (balanceAfterAmd === null || balanceAfterAmd === undefined) {
    text = text.split(/(?<=[։:.])\s+/).filter((s) => !s.includes("[updated debt balance]")).join(" ");
  }
  return text
    .replaceAll("[order no]", orderCodes.join(", "))
    .replaceAll("[payment amount]", hasPayment ? amd(paymentAmd) : "")
    .replaceAll("[updated debt balance]", balanceAfterAmd === null || balanceAfterAmd === undefined ? "" : amd(balanceAfterAmd))
    .trim();
}
