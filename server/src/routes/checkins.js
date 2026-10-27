import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { photoUpload, uploadDirPath } from "../upload.js";
import { matchesDeclaredImageType } from "../utils/imageSniff.js";
import { thumbnailPathFor, removeThumbnail } from "../utils/imageThumbs.js";
import { haversineMeters, creditedDistanceMeters } from "../utils/geo.js";
import { getCheckinRadiusMeters, getCheckinAllowanceEnabled } from "../settings.js";
import { seesAllActivity } from "../roles.js";
import { FIELD_REP_ROLE } from "../visitCount.js";
import { periodTimestampCondition, PERIOD_KEYS } from "../utils/periodWindows.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { insertPayment } from "./payments.js";
import { autoCompleteCollectionTasks, autoCompleteProductCheckTasks, autoCompleteVisitTasks } from "../taskAutoComplete.js";
import { lockSignedOrders, createSignedActs, createPaymentSlip, saveOwnSignature } from "../signedActs.js";
import { scheduleAiCheck } from "../aiBlankCheck.js";
import { parseDeliveredOrderIds, deliverableOrders, deliverOrdersAtCheckin, notifyCheckinDelivered, CHECKIN_ORDER_LINKS_SQL } from "../checkinDelivery.js";

// Below this, a payment isn't worth interrupting anyone's Telegram for.
const LARGE_PAYMENT_THRESHOLD_AMD = 100000;

export const checkinsRouter = Router();

checkinsRouter.use(requireAuth);

// GPS accuracy in meters as the phone reported it; anything unusable is stored as NULL.
function parseAccuracy(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

// The app refused a sales manager's check-in for being too far (Check-in allowance) and reports where they
// stood: evidence for the Pin review (is the customer's pin wrong?). Best effort, deduplicated per rep +
// customer within 5 minutes.
checkinsRouter.post("/far-attempt", express.json(), async (req, res) => {
  if (req.user.role !== FIELD_REP_ROLE || !(await getCheckinAllowanceEnabled())) return res.status(204).end();
  const customerId = Number(req.body?.customer_id);
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isInteger(customerId) || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "customer_id, lat and lng are required" });
  const { rows } = await pool.query("SELECT lat, lng FROM customers WHERE id = $1", [customerId]);
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  const distance = haversineMeters(lat, lng, rows[0].lat, rows[0].lng);
  if (!(creditedDistanceMeters(distance, parseAccuracy(req.body?.accuracy_m)) > (await getCheckinRadiusMeters()))) return res.status(204).end(); // not far: nothing to record
  await pool.query(
    `INSERT INTO checkin_far_attempts (customer_id, user_id, lat, lng, distance_meters, accuracy_m)
     SELECT $1, $2, $3, $4, $5, $6
     WHERE NOT EXISTS (SELECT 1 FROM checkin_far_attempts WHERE customer_id = $1 AND user_id = $2 AND created_at > now() - interval '5 minutes')`,
    [customerId, req.user.id, lat, lng, distance, parseAccuracy(req.body?.accuracy_m)]
  );
  res.status(204).end();
});

const VALID_OUTCOMES = new Set([
  "order_placed",
  "payment_collected",
  "follow_up_required",
  "assortment_check",
  "customer_unavailable", // legacy value; the app shows it as "Products delivered" (truck icon)
  "other",
]);
// "No order" and "Complaint" were removed (owner, 2026-10-26; migration 155 merged the old records into "other"). A check-in
// still waiting in an old phone's offline queue may carry them: it is saved as "other" and, having been written before the
// rule existed, is not asked for the note that "other" now needs.
const MERGED_INTO_OTHER = new Set(["no_order", "complaint"]);

// The customer's CONFIRMED / PACKED orders, for the "Products delivered" outcome of the check-in form.
checkinsRouter.get("/deliverable-orders", async (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) return res.status(400).json({ error: "customer_id is required" });
  res.json(await deliverableOrders(customerId));
});

// The competitors' list, in the order the check-in shows it (owner, 2026-10-26).
export const COMPETITOR_BRANDS = [
  "mobil", "motul", "shell", "liquimoly", "aral", "bardahl", "petronas", "fuchs", "total",
  "ravenol", "oscar", "amsoil", "zic", "pennzoil", "addinol", "s_oil", "kixx", "russian_oil",
];

const BRAND_STATUS_OPTIONS = {
  castrol: new Set([
    "available",
    "unavailable",
    "full_range",
    "fake",
    "imported_us",
    "imported_dubai",
    "imported_ru",
    "imported_other",
  ]),
  lotos: new Set(["available", "unavailable", "full_range"]),
  royal: new Set(["available", "unavailable", "full_range"]),
  competitors: new Set(COMPETITOR_BRANDS),
};

function parseOutcomes(raw) {
  if (!raw) return { values: [], legacy: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { values: [], legacy: false };
  }
  if (!Array.isArray(parsed)) return { values: [], legacy: false };
  const legacy = parsed.some((o) => MERGED_INTO_OTHER.has(o));
  const values = [...new Set(parsed.map((o) => (MERGED_INTO_OTHER.has(o) ? "other" : o)).filter((o) => VALID_OUTCOMES.has(o)))];
  return { values, legacy };
}

// A free-text list (product names/brands from this customer's own order
// history, not a fixed catalog whitelist) -- just sanitized and capped,
// same trust level as `note`.
const MAX_AVAILABLE_PRODUCTS = 200;
function parseAvailableProducts(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const values = parsed
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, MAX_AVAILABLE_PRODUCTS);
  return values.length ? values : null;
}

function parseBrandStatus(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const result = {};
  for (const [brand, allowed] of Object.entries(BRAND_STATUS_OPTIONS)) {
    const values = Array.isArray(parsed[brand]) ? parsed[brand].filter((v) => allowed.has(v)) : [];
    if (!values.length) continue;
    // Defensive: "available" and "unavailable" are mutually exclusive; the
    // client already enforces this, but never trust the client alone.
    const deduped = values.includes("available") ? values.filter((v) => v !== "unavailable") : values;
    result[brand] = deduped;
  }
  return Object.keys(result).length ? result : null;
}

const MAX_PHOTOS_PER_CHECKIN = 5;

// A check-in sent from the offline queue arrives minutes or hours after the
// visit: its `timestamp` is the moment the rep pressed submit (captured_at),
// not the moment the server heard about it (created_at keeps that). Accepted
// only when plausible -- not in the future, not older than a week -- so a wrong
// phone clock cannot rewrite history.
export function parseCapturedAt(value, now = Date.now()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t) || t > now + 5 * 60 * 1000 || t < now - 7 * 24 * 60 * 60 * 1000) return null;
  return new Date(t).toISOString();
}

const MAX_ORDER_BLANK_PHOTOS = 6;

checkinsRouter.post("/", (req, res, next) => {
  photoUpload.fields([
    { name: "photos", maxCount: MAX_PHOTOS_PER_CHECKIN },
    { name: "order_blank_photos", maxCount: MAX_ORDER_BLANK_PHOTOS },
    { name: "customer_signature", maxCount: 1 },
    { name: "rep_signature", maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { customer_id, lat, lng, note, brand_status, outcomes, amount_collected_amd, available_products, client_ref, captured_at, accuracy_m, delivered_order_ids } = req.body ?? {};
  const customerId = Number(customer_id);
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const { values: outcomeValues, legacy: legacyOutcome } = parseOutcomes(outcomes);
  // Visit photos and photos of the signed order blank arrive as two upload fields; both are checked and stored.
  const visitFiles = req.files?.photos ?? [];
  const blankFiles = req.files?.order_blank_photos ?? [];
  // The customer's electronic signature on the delivery-acceptance act, and the rep's own one when it is not on their profile yet.
  const customerSignature = req.files?.customer_signature?.[0] ?? null;
  const repSignature = req.files?.rep_signature?.[0] ?? null;
  const files = [...visitFiles, ...blankFiles, ...[customerSignature, repSignature].filter(Boolean)];

  // multer's fileFilter only ever sees the client-declared Content-Type
  // (see upload.js) -- this checks the bytes actually written to disk
  // match one of the allowed image signatures, catching a renamed
  // non-image file fileFilter alone can't.
  if (files.some((f) => !matchesDeclaredImageType(f.path, f.mimetype))) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "One or more uploaded files are not valid images" });
  }

  // Checking in at the office (customers.checkin_for_all) needs no visit outcome: it is just "I'm here".
  let officeCheckin = false;
  if (customerId) {
    const { rows: officeRows } = await pool.query("SELECT 1 FROM customers WHERE id = $1 AND checkin_for_all", [customerId]);
    officeCheckin = officeRows.length > 0;
    if (officeCheckin && !outcomeValues.length) outcomeValues.push("other");
  }

  if (!customerId || Number.isNaN(latNum) || Number.isNaN(lngNum) || !outcomeValues.length) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "customer_id, lat, lng and at least one outcome are required" });
  }

  // "Other" must be explained (owner, 2026-10-26) -- except the office check-in, which has nothing to explain, and a check-in an
  // older phone queued before this rule existed.
  if (outcomeValues.includes("other") && !officeCheckin && !legacyOutcome && !String(note ?? "").trim()) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "A note is required when the outcome is Other", code: "note_required_for_other" });
  }

  // The photo of a signed order blank belongs to a delivery.
  if (blankFiles.length && !outcomeValues.includes("customer_unavailable")) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "An order-blank photo needs the Products delivered outcome" });
  }

  // The customer signs the act (Products delivered) or the payment slip (Payment collected).
  if (customerSignature && !outcomeValues.includes("customer_unavailable") && !outcomeValues.includes("payment_collected")) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "A signature needs the Products delivered or Payment collected outcome" });
  }

  // A retried submission (the offline queue's flushQueue() re-sending an
  // entry whose earlier attempt actually succeeded but whose response was
  // lost) carries the same client_ref every time -- recognize it here and
  // return the original check-in instead of creating a duplicate. The
  // photos on this retry are discarded (already saved with the original).
  if (client_ref) {
    const { rows: existingRows } = await pool.query("SELECT *, (SELECT count(*)::int FROM checkin_photos WHERE checkin_id = checkins.id) AS photo_count FROM checkins WHERE user_id = $1 AND client_ref = $2", [
      req.user.id,
      client_ref,
    ]);
    if (existingRows[0]) {
      files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(201).json(existingRows[0]);
    }
  }

  // Only meaningful (and required) when the rep actually flagged this visit
  // as a collection -- an amount on a visit with no such outcome would be
  // an orphaned, unexplainable number in the accountant's payment list.
  let amountCollected = null;
  if (outcomeValues.includes("payment_collected")) {
    amountCollected = Number(amount_collected_amd);
    if (!Number.isFinite(amountCollected) || amountCollected <= 0) {
      files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: "amount_collected_amd must be a positive number when payment_collected is selected" });
    }
  }

  const { rows: customerRows } = await pool.query(
    "SELECT id, name, lat, lng, erp_customer_id FROM customers WHERE id = $1",
    [customerId]
  );
  const customer = customerRows[0];
  if (!customer) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: "Customer not found" });
  }

  // Check-in allowance (Settings, can be switched off): a sales manager must be within this many meters of the customer's pin,
  // otherwise the check-in is refused. Management roles (director, admin, CEO...) check in from anywhere;
  // theirs is saved with within_range = false when far, and never counts as the customer's visit anyway.
  const radiusMeters = await getCheckinRadiusMeters();
  const distance = haversineMeters(latNum, lngNum, customer.lat, customer.lng);
  const withinRange = distance <= radiusMeters;
  // The refusal forgives GPS accuracy up to 100 m (owner, 2026-10-13); the real distance and within_range are what get saved.
  const tooFar = creditedDistanceMeters(distance, parseAccuracy(accuracy_m)) > radiusMeters;
  if (tooFar && req.user.role === FIELD_REP_ROLE && (await getCheckinAllowanceEnabled())) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(422).json({
      error: `You are ${Math.round(distance)} m from the customer; check-in is allowed within ${radiusMeters} m`,
      code: "checkin_too_far",
      distance_meters: Math.round(distance),
      allowance_meters: radiusMeters,
    });
  }
  const brandStatusValue = parseBrandStatus(brand_status);
  const availableProductsValue = parseAvailableProducts(available_products);

  // "Products delivered" (stored as customer_unavailable): the orders the rep picked move to Delivered together with the check-in.
  // Picking is optional -- goods can be handed over without a confirmed / packed order in the system.
  const deliveredIds = outcomeValues.includes("customer_unavailable") ? parseDeliveredOrderIds(delivered_order_ids) : [];

  const client = await pool.connect();
  let checkin;
  let rep = null;
  let deliveredOrders = [];
  let signatureSavedPath = null;
  let paymentId = null;
  const blankFileIds = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, note, brand_status, outcomes, amount_collected_amd, available_products, client_ref, timestamp, accuracy_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()), $14)
       RETURNING *`,
      [customerId, req.user.id, latNum, lngNum, distance, withinRange, note ?? null, brandStatusValue, outcomeValues, amountCollected, availableProductsValue, client_ref || null, parseCapturedAt(captured_at), parseAccuracy(accuracy_m)]
    );
    checkin = rows[0];
    for (const file of visitFiles) {
      await client.query("INSERT INTO checkin_photos (checkin_id, photo_path) VALUES ($1, $2)", [
        checkin.id,
        file.filename,
      ]);
    }
    // The signed order blank of a delivery: a customer document kept with the check-in, linked to the delivered orders (Files > Documents,
    // the order's Documents, the accountant's inbox). Only a visit marked "Products delivered" can carry one.
    for (const file of blankFiles) {
      const { rows: inserted } = await client.query(
        "INSERT INTO customer_files (customer_id, kind, file_path, mime, size_bytes, order_ids, checkin_id, created_by) VALUES ($1, 'order_blank', $2, $3, $4, $5, $6, $7) RETURNING id",
        [customerId, file.filename, file.mimetype, file.size, deliveredIds, checkin.id, req.user.id]
      );
      blankFileIds.push(inserted[0].id);
    }

    // In the same transaction as the check-in itself, not a fire-and-forget
    // call after the response was already sent -- that used to mean a
    // failure here (a transient DB error, nothing to do with the check-in
    // data itself) silently discarded the payment while the check-in still
    // saved and returned 201, leaving money marked "collected" on the visit
    // with no corresponding row in the accountant's reconciliation queue.
    // Now either both commit or neither does, and the rep sees the actual
    // error instead of a false success. client_ref ties it 1:1 to this
    // check-in, so it can never double-sync.
    if (amountCollected != null) {
      const { rows: repRows } = await client.query("SELECT name, position, role FROM users WHERE id = $1", [req.user.id]);
      rep = repRows[0] ?? null;
      if (rep) {
        // The check-in itself is the field-visit record of the money
        // changing hands; this mirrors it into the reviewed Payments
        // workflow so an accountant sees and reconciles it the same way
        // as a manually-submitted payment, instead of it sitting invisibly
        // on amount_collected_amd where only checkin/activity views show it.
        paymentId = await insertPayment({
          customer,
          amount: amountCollected,
          paymentDate: checkin.timestamp,
          salesManagerId: req.user.id,
          manager: rep,
          note: null,
          createdBy: req.user.id,
          clientRef: `checkin-${checkin.id}`,
          db: client,
        });
      }
    }

    deliveredOrders = await deliverOrdersAtCheckin(client, { customerId, orderIds: deliveredIds, userId: req.user.id, checkinId: checkin.id });

    // The customer signed the delivery-acceptance act on the rep's phone: one signature for every order delivered at this visit. The orders
    // lock in the same transaction; the signed PDFs are made right after it commits.
    if (customerSignature && deliveredOrders.length) {
      signatureSavedPath = customerSignature.filename;
      await lockSignedOrders(client, { customerId, checkinId: checkin.id, filePath: signatureSavedPath, createdBy: req.user.id, orderIds: deliveredOrders.map((o) => o.id) });
    } else if (customerSignature && amountCollected != null) {
      // No delivery, only money: the customer signed the payment slip (made below, after the commit).
      signatureSavedPath = customerSignature.filename;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    files.forEach((f) => fs.unlink(f.path, () => {}));
    // 23505 = unique_violation -- two near-simultaneous retries of the same
    // queued entry both passed the client_ref check above before either had
    // committed; the loser here just needs the winner's row, not an error.
    if (err.code === "23505" && client_ref) {
      const { rows: existingRows } = await pool.query(
        "SELECT *, (SELECT count(*)::int FROM checkin_photos WHERE checkin_id = checkins.id) AS photo_count FROM checkins WHERE user_id = $1 AND client_ref = $2",
        [req.user.id, client_ref]
      );
      if (existingRows[0]) return res.status(201).json(existingRows[0]);
    }
    throw err;
  } finally {
    client.release();
  }

  // The rep's own signature first (when it was not on their profile yet), so the very first signed act already carries it.
  let repSignatureSaved = false;
  if (repSignature) {
    const { rows: ownRows } = await pool.query("SELECT signature_path FROM users WHERE id = $1", [req.user.id]);
    if (!ownRows[0]?.signature_path) {
      await saveOwnSignature(req.user.id, repSignature);
      repSignatureSaved = true;
    } else {
      fs.unlink(repSignature.path, () => {});
    }
  }

  // The signed acts: one PDF per delivered order.
  let signedActs = [];
  let signedActError = false;
  let paymentSlip = null;
  let paymentSlipError = false;
  if (signatureSavedPath && deliveredOrders.length) {
    try {
      // Money collected at the same visit goes on the act too: previous balance, order, payment, current balance (owner, 2026-10-27).
      signedActs = await createSignedActs({ orderIds: deliveredOrders.map((o) => o.id), customerId, checkinId: checkin.id, customerSignaturePath: signatureSavedPath, signerId: req.user.id, paymentAmd: amountCollected });
    } catch (err) {
      signedActError = true;
      console.error("Signed act PDF failed:", err);
    }
  } else if (customerSignature && !signatureSavedPath) {
    fs.unlink(customerSignature.path, () => {}); // nothing was delivered or paid with it
  }
  // Money without a delivery: the payment slip, signed by the customer when they signed, ready to look at, save and share (owner, 2026-10-27).
  if (amountCollected != null && !deliveredOrders.length) {
    try {
      paymentSlip = await createPaymentSlip({ paymentId, customerId, checkinId: checkin.id, amountAmd: amountCollected, paidAt: new Date(checkin.timestamp), customerSignaturePath: signatureSavedPath, signerId: req.user.id });
    } catch (err) {
      paymentSlipError = true;
      console.error("Payment slip PDF failed:", err);
    }
  }
  res.status(201).json({
    ...checkin,
    photo_count: visitFiles.length,
    order_blank_count: blankFiles.length,
    delivered_orders: deliveredOrders,
    signed_acts: signedActs,
    signed_act_error: signedActError || undefined,
    payment_slip: paymentSlip || undefined,
    payment_slip_error: paymentSlipError || undefined,
    rep_signature_saved: repSignatureSaved || undefined,
  });

  // The AI check of the photographed blanks (a switch in App configuration, OFF by default) runs after the answer, never delaying it.
  blankFileIds.forEach((id) => scheduleAiCheck(id));

  notifyCheckinDelivered({ delivered: deliveredOrders, customerName: customer.name, actorId: req.user.id });

  // Money collected on this visit closes the customer's "collect the debt" task (taskAutoComplete.js).
  if (amountCollected != null) {
    autoCompleteCollectionTasks({ customerId, actorId: req.user.id, amountAmd: amountCollected }).catch((err) => console.error("Task auto-complete failed:", err.message));
  }

  // The visit itself closes the "Visit" task given to this rep for this customer.
  autoCompleteVisitTasks({ customerId, actorId: req.user.id }).catch((err) => console.error("Task auto-complete failed:", err.message));

  // Recording what the shop has (brand chips / available products) closes the customer's "check products" task.
  if (brandStatusValue || (Array.isArray(availableProductsValue) && availableProductsValue.length)) {
    autoCompleteProductCheckTasks({ customerId, actorId: req.user.id }).catch((err) => console.error("Task auto-complete failed:", err.message));
  }

  if (amountCollected != null && amountCollected >= LARGE_PAYMENT_THRESHOLD_AMD) {
    notifyTelegram(
      `💰 <b>Large payment collected</b>\n${escapeHtml(rep?.name || "Someone")} — ${escapeHtml(customer.name)}\n${Math.round(amountCollected).toLocaleString()} AMD`
    );
  }
});

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const CHECKINS_PAGE_SIZE = 1000;

checkinsRouter.get("/", async (req, res) => {
  const { range, customer_id, from, to, payments_only, offset } = req.query;
  let { user_id } = req.query;

  // Plain managers only see their own check-ins; admins and every
  // director-tier role (sales/warehouse/delivery) can filter by any user.
  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }

  const conditions = [];
  const params = [];

  // An explicit custom range (from/to) takes priority over the range
  // keyword -- the two are alternative ways to express "since when", not
  // meant to be combined.
  if (isValidDateString(from)) {
    params.push(from);
    conditions.push(`ch.timestamp >= $${params.length}::date`);
  } else if (PERIOD_KEYS.includes(range)) {
    // today / week / month / quarter / year and the previous one of each, as Yerevan calendar days (a check-in logged
    // between 00:00 and 03:59 Yerevan belongs to that day, not to the UTC day before; the week starts on Monday).
    conditions.push(periodTimestampCondition("ch.timestamp", range, params));
  }
  if (isValidDateString(to)) {
    params.push(to);
    conditions.push(`ch.timestamp < ($${params.length}::date + interval '1 day')`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`ch.user_id = $${params.length}`);
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`ch.customer_id = $${params.length}`);
  }
  if (payments_only === "true") {
    conditions.push(`ch.amount_collected_amd IS NOT NULL`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offsetNum = Math.max(0, Number(offset) || 0);

  // Fetch one extra row to know whether there's a next page, without a
  // separate COUNT(*) query -- trimmed back to CHECKINS_PAGE_SIZE before
  // sending.
  params.push(CHECKINS_PAGE_SIZE + 1, offsetNum);
  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name, c.name AS customer_name, c.category AS customer_category,
       c.customer_tier AS customer_tier,
       -- Aliased away from a bare "region" so it can't collide with the
       -- check-in's own columns when the row is spread client-side.
       c.region AS customer_region,
       COALESCE(
         (SELECT json_agg(json_build_object('id', cp.id) ORDER BY cp.id) FROM checkin_photos cp WHERE cp.checkin_id = ch.id),
         '[]'
       ) AS photos,
       COALESCE((SELECT json_agg(json_build_object('id', cf.id, 'kind', cf.kind, 'mime', cf.mime, 'version', cf.version) ORDER BY cf.id) FROM customer_files cf WHERE cf.checkin_id = ch.id), '[]') AS files,
       -- Lets an "Order placed" outcome row link straight to the order it
       -- created (see visitDetail.js). A scalar subquery, not a join, so a
       -- checkin never fans out into multiple rows even in the unlikely
       -- case of more than one order referencing the same checkin_id.
       ${CHECKIN_ORDER_LINKS_SQL}
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     ${where}
     ORDER BY ch.timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, CHECKINS_PAGE_SIZE), has_more: rows.length > CHECKINS_PAGE_SIZE });
});

// Legacy single-photo endpoint -- still works for check-ins recorded before
// the multi-photo table existed (backfilled into checkin_photos, but this
// keeps old client caches / bookmarked URLs working).
// "End visit" (migration 106): the rep's own check-in made today at a customer and not ended yet.
checkinsRouter.get("/open", async (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: "customer_id is required" });
  const { rows } = await pool.query(
    `SELECT id, customer_id, timestamp FROM checkins
     WHERE user_id = $1 AND customer_id = $2 AND within_range AND ended_at IS NULL
       AND (timestamp AT TIME ZONE 'Asia/Yerevan')::date = (now() AT TIME ZONE 'Asia/Yerevan')::date
     ORDER BY timestamp DESC LIMIT 1`,
    [req.user.id, customerId]
  );
  res.json(rows[0] ?? null);
});

checkinsRouter.post("/:id/end", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE checkins SET ended_at = now() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING id, timestamp, ended_at`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "No open visit to end" });
  res.json(rows[0]);
});

checkinsRouter.get("/:id/photo", async (req, res) => {
  const { rows } = await pool.query("SELECT user_id, photo_path FROM checkins WHERE id = $1", [
    req.params.id,
  ]);
  const checkin = rows[0];
  if (!checkin || !checkin.photo_path) {
    return res.status(404).json({ error: "Photo not found" });
  }
  if (!seesAllActivity(req.user.role) && checkin.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  res.sendFile(path.join(uploadDirPath, checkin.photo_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Photo not found" });
  });
});

checkinsRouter.delete("/:id/photo", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT photo_path FROM checkins WHERE id = $1", [
    req.params.id,
  ]);
  const checkin = rows[0];
  if (!checkin || !checkin.photo_path) {
    return res.status(404).json({ error: "Photo not found" });
  }

  fs.unlink(path.join(uploadDirPath, checkin.photo_path), () => {});
  removeThumbnail(uploadDirPath, checkin.photo_path);
  await pool.query("UPDATE checkins SET photo_path = NULL WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

checkinsRouter.get("/photos/:photoId", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.photo_path, ch.user_id
     FROM checkin_photos cp
     JOIN checkins ch ON ch.id = cp.checkin_id
     WHERE cp.id = $1`,
    [req.params.photoId]
  );
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  if (!seesAllActivity(req.user.role) && photo.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  // A stored photo never changes (a new one gets a new id), so the phone may keep it for a year: it is downloaded once, not on every
  // open. ?size=thumb sends a small copy for grids; the original is the fallback when none can be made.
  const cacheHeaders = { "Cache-Control": "private, max-age=31536000, immutable" };
  let file = path.join(uploadDirPath, photo.photo_path);
  if (req.query.size === "thumb") file = (await thumbnailPathFor(uploadDirPath, photo.photo_path)) || file;
  res.sendFile(file, { headers: cacheHeaders }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Photo not found" });
  });
});

checkinsRouter.delete("/photos/:photoId", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("DELETE FROM checkin_photos WHERE id = $1 RETURNING photo_path", [
    req.params.photoId,
  ]);
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  fs.unlink(path.join(uploadDirPath, photo.photo_path), () => {});
  removeThumbnail(uploadDirPath, photo.photo_path);
  res.status(204).end();
});
