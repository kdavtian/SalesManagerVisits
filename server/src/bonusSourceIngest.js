// Turns real business events (a checkin, an approved payment, a delivered
// order) into Bonuses ledger entries. Every ingest*() function here is
// idempotent and safe to call more than once for the same source row --
// call it from the route that creates/transitions the source event, from a
// reconciliation sweep, or both; either way a re-run is a cheap no-op, never
// a duplicate award (see bonus_source_contributions' and bonus_point_ledger's
// own UNIQUE constraints, and bonusIdempotency.js for how a mid-transaction
// unique-violation is turned into a lookup rather than an aborted
// transaction).
//
// Collectible/point storage convention (see docs/bonuses-design.md section
// 10, and bonusUnits.js's own header): every column here is uniformly in
// bonusUnits.js's scale-2 terms, including the "whole-only" collectibles
// (strawberry, apple, cherry) -- a whole unit is stored as 2, never 1. This
// keeps bonus_point_ledger.collectible_delta_scaled one convention for every
// activity that flows through it, matching bonus_earning_units' own
// max_scaled=2 "cap of one full unit" representation for strawberry/apple
// even though neither ever actually takes a 0.5 step.
import { pool } from "./db/pool.js";
import { getEarningRuleAt } from "./bonusRules.js";
import { toScaled } from "./bonusUnits.js";
import { yerevanDateOf, yerevanTimeOfDay, yerevanIsoDayOfWeek } from "./utils/yerevanDate.js";
import { getBonusSettings } from "./bonusSettings.js";
import { evidenceFromCheckin, findNearbyCheckinForLinkage } from "./bonusGpsEvidence.js";
import { getEarningUnitForUpdate, addToEarningUnit, lockEarningUnitById } from "./bonusEarningUnits.js";
import { postLedgerEntry, reverseLedgerEntry } from "./bonusLedger.js";
import { insertIdempotent } from "./bonusIdempotency.js";

const FULL_CREDIT_SCALED = toScaled(1); // 2
const HALF_CREDIT_SCALED = toScaled(0.5); // 1

async function insertSourceContribution(
  client,
  { earningUnitId, sourceTable, sourceId, status, contributesScaled, gpsVerified, gpsEvidenceId, occurrenceAt }
) {
  return insertIdempotent(client, {
    insertSql: `INSERT INTO bonus_source_contributions (
         earning_unit_id, source_table, source_id, status, contributes_scaled, gps_verified, gps_evidence_id,
         occurrence_at, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $4 = 'confirmed' THEN now() ELSE NULL END)
       RETURNING *`,
    insertParams: [earningUnitId, sourceTable, sourceId, status, contributesScaled, gpsVerified, gpsEvidenceId, occurrenceAt],
    conflictSelectSql: "SELECT * FROM bonus_source_contributions WHERE source_table = $1 AND source_id = $2",
    conflictSelectParams: [sourceTable, sourceId],
  });
}

// Points earned for a given scaled collectible amount, in the activity's
// current rule -- both sides of the multiplication are already in scale-2
// terms, so the product is too (see this file's own header comment).
async function scaledPoints(activity, atInstant, collectibleDeltaScaled) {
  const rule = await getEarningRuleAt(activity, atInstant);
  if (!rule || !rule.enabled) return { rule: null, pointsDeltaScaled: 0 };
  return { rule, pointsDeltaScaled: collectibleDeltaScaled * rule.points_per_unit };
}

// Strawberry: a GPS-verified visit. One credited visit per employee/
// customer/Yerevan-day; a second checkin at the same customer the same day
// still gets its own (rejected-if-ungated, confirmed-but-zero-if-already-
// capped) contribution row for history, but never a second ledger entry.
export async function ingestVisitContribution(checkinId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM checkins WHERE id = $1", [checkinId]);
    const checkin = rows[0];
    if (!checkin) throw new Error(`ingestVisitContribution: no checkin with id ${checkinId}`);

    const localDate = yerevanDateOf(checkin.timestamp);
    const unit = await getEarningUnitForUpdate(client, {
      userId: checkin.user_id,
      customerId: checkin.customer_id,
      activity: "strawberry",
      localDate,
    });
    const evidence = await evidenceFromCheckin(client, checkin);

    const remaining = Math.max(0, unit.max_scaled - unit.confirmed_scaled);
    const contributesScaled = checkin.within_range ? Math.min(remaining, FULL_CREDIT_SCALED) : 0;
    const status = checkin.within_range ? "confirmed" : "rejected";

    const { row: contribution, alreadyExisted } = await insertSourceContribution(client, {
      earningUnitId: unit.id,
      sourceTable: "checkin",
      sourceId: checkinId,
      status,
      contributesScaled,
      gpsVerified: checkin.within_range,
      gpsEvidenceId: evidence.id,
      occurrenceAt: checkin.timestamp,
    });

    let ledger = null;
    if (!alreadyExisted && contributesScaled > 0) {
      await addToEarningUnit(client, unit.id, contributesScaled);
      const { rule, pointsDeltaScaled } = await scaledPoints("strawberry", checkin.timestamp, contributesScaled);
      ({ row: ledger } = await postLedgerEntry(client, {
        userId: checkin.user_id,
        activity: "strawberry",
        collectibleDeltaScaled: contributesScaled,
        pointsDeltaScaled,
        ruleVersionId: rule?.id ?? null,
        sourceContributionId: contribution.id,
        operationKey: `checkin:${checkinId}:strawberry`,
      }));
    }
    await client.query("COMMIT");
    return { contribution, ledger };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Carrot: an approved collection. Full credit when a checkin by the same
// rep at the same customer is found within the configured freshness window
// ending at the payment's own timestamp and that checkin was itself GPS-
// verified; half credit (per docs/bonuses-design.md's "GPS-dependent
// full/half collection credit" decision) when no such evidence exists.
// Payments that are still pending or were rejected earn nothing -- only
// 'approved' payments reach here (call this from the payment-approval route
// in a later phase, or from a reconciliation sweep that only selects
// approved payments).
export async function ingestCollectionContribution(paymentId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1", [paymentId]);
    const payment = rows[0];
    if (!payment) throw new Error(`ingestCollectionContribution: no payment with id ${paymentId}`);
    if (payment.status !== "approved") {
      await client.query("ROLLBACK");
      return { contribution: null, ledger: null, reason: "payment_not_approved" };
    }

    const localDate = yerevanDateOf(payment.payment_date);
    const unit = await getEarningUnitForUpdate(client, {
      userId: payment.sales_manager_id,
      customerId: payment.customer_id,
      activity: "carrot",
      localDate,
    });

    const settings = await getBonusSettings();
    const linkedCheckin = await findNearbyCheckinForLinkage(client, {
      userId: payment.sales_manager_id,
      customerId: payment.customer_id,
      occurredAt: payment.payment_date,
      freshnessHours: settings.collectionGpsFreshnessHours,
    });
    const gpsVerified = Boolean(linkedCheckin?.within_range);
    const evidence = linkedCheckin ? await evidenceFromCheckin(client, linkedCheckin, { linked: true }) : null;

    const creditWorthScaled = gpsVerified ? FULL_CREDIT_SCALED : HALF_CREDIT_SCALED;
    const remaining = Math.max(0, unit.max_scaled - unit.confirmed_scaled);
    const contributesScaled = Math.min(remaining, creditWorthScaled);

    const { row: contribution, alreadyExisted } = await insertSourceContribution(client, {
      earningUnitId: unit.id,
      sourceTable: "payment",
      sourceId: paymentId,
      status: "confirmed",
      contributesScaled,
      gpsVerified,
      gpsEvidenceId: evidence?.id ?? null,
      occurrenceAt: payment.payment_date,
    });

    let ledger = null;
    if (!alreadyExisted && contributesScaled > 0) {
      await addToEarningUnit(client, unit.id, contributesScaled);
      const { rule, pointsDeltaScaled } = await scaledPoints("carrot", payment.payment_date, contributesScaled);
      ({ row: ledger } = await postLedgerEntry(client, {
        userId: payment.sales_manager_id,
        activity: "carrot",
        collectibleDeltaScaled: contributesScaled,
        pointsDeltaScaled,
        ruleVersionId: rule?.id ?? null,
        sourceContributionId: contribution.id,
        operationKey: `payment:${paymentId}:carrot`,
      }));
    }
    await client.query("COMMIT");
    return { contribution, ledger };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Apple: a delivered order. One credited delivery per employee/customer/
// Yerevan-day, keyed off order_status_history's first transition to
// 'delivered' (never orders.updated_at, which changes on any later edit).
// Not GPS-gated -- "delivered" is an objective warehouse/ERP event with no
// location claim of its own; if the order carries a linked checkin
// (orders.checkin_id) its evidence is recorded for information only.
export async function ingestOrderDelivery(orderId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    const order = orderRows[0];
    if (!order) throw new Error(`ingestOrderDelivery: no order with id ${orderId}`);

    const { rows: historyRows } = await client.query(
      `SELECT changed_at FROM order_status_history
       WHERE order_id = $1 AND new_status = 'delivered'
       ORDER BY changed_at ASC LIMIT 1`,
      [orderId]
    );
    if (!historyRows[0]) {
      await client.query("ROLLBACK");
      return { contribution: null, ledger: null, reason: "order_not_delivered" };
    }
    const deliveredAt = historyRows[0].changed_at;

    const localDate = yerevanDateOf(deliveredAt);
    const unit = await getEarningUnitForUpdate(client, {
      userId: order.user_id,
      customerId: order.customer_id,
      activity: "apple",
      localDate,
    });

    let evidence = null;
    let gpsVerified = false;
    if (order.checkin_id) {
      const { rows: checkinRows } = await client.query("SELECT * FROM checkins WHERE id = $1", [order.checkin_id]);
      if (checkinRows[0]) {
        evidence = await evidenceFromCheckin(client, checkinRows[0], { linked: true });
        gpsVerified = checkinRows[0].within_range;
      }
    }

    const remaining = Math.max(0, unit.max_scaled - unit.confirmed_scaled);
    const contributesScaled = Math.min(remaining, FULL_CREDIT_SCALED);

    const { row: contribution, alreadyExisted } = await insertSourceContribution(client, {
      earningUnitId: unit.id,
      sourceTable: "order",
      sourceId: orderId,
      status: "confirmed",
      contributesScaled,
      gpsVerified,
      gpsEvidenceId: evidence?.id ?? null,
      occurrenceAt: deliveredAt,
    });

    let ledger = null;
    if (!alreadyExisted && contributesScaled > 0) {
      await addToEarningUnit(client, unit.id, contributesScaled);
      const { rule, pointsDeltaScaled } = await scaledPoints("apple", deliveredAt, contributesScaled);
      ({ row: ledger } = await postLedgerEntry(client, {
        userId: order.user_id,
        activity: "apple",
        collectibleDeltaScaled: contributesScaled,
        pointsDeltaScaled,
        ruleVersionId: rule?.id ?? null,
        sourceContributionId: contribution.id,
        operationKey: `order:${orderId}:apple`,
      }));
    }
    await client.query("COMMIT");
    return { contribution, ledger };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Cherry: GPS-verified office arrival, strictly before the configured local
// cutoff time. Every checkin at the office customer is recorded as an
// attendance row (qualifying or not) for history; only the first qualifying
// arrival per employee per Yerevan-day earns a cherry -- enforced by a
// deterministic per-user/per-day operation_key, not by pre-checking for an
// earlier record, so two concurrent qualifying check-ins the same day still
// only ever produce one ledger entry. Returns
// { attendance: null, ledger: null, reason } when app_settings.
// bonus_office_erp_customer_id is unset or this checkin isn't at the office
// customer at all -- not an error, just "nothing to do here."
export async function ingestOfficeAttendance(checkinId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM checkins WHERE id = $1", [checkinId]);
    const checkin = rows[0];
    if (!checkin) throw new Error(`ingestOfficeAttendance: no checkin with id ${checkinId}`);

    const settings = await getBonusSettings();
    if (!settings.officeErpCustomerId) {
      await client.query("ROLLBACK");
      return { attendance: null, ledger: null, reason: "office_customer_not_configured" };
    }

    const { rows: customerRows } = await client.query("SELECT erp_customer_id FROM customers WHERE id = $1", [
      checkin.customer_id,
    ]);
    if (customerRows[0]?.erp_customer_id !== settings.officeErpCustomerId) {
      await client.query("ROLLBACK");
      return { attendance: null, ledger: null, reason: "not_office_customer" };
    }

    const timeOfDay = yerevanTimeOfDay(checkin.timestamp);
    const isoDow = yerevanIsoDayOfWeek(checkin.timestamp);
    const beforeCutoff = timeOfDay < settings.officeCutoffTime;
    const afterEarliest = !settings.officeEarliestTime || timeOfDay >= settings.officeEarliestTime;
    const workdayOk = !settings.officeWorkdays?.length || settings.officeWorkdays.includes(isoDow);
    const qualifies = Boolean(checkin.within_range) && beforeCutoff && afterEarliest && workdayOk;

    const evidence = await evidenceFromCheckin(client, checkin);
    const localDate = yerevanDateOf(checkin.timestamp);

    const { row: attendance, alreadyExisted } = await insertIdempotent(client, {
      insertSql: `INSERT INTO bonus_attendance_records (
           user_id, local_date, checkin_id, occurrence_at, gps_evidence_id, qualifies, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'recorded')
         RETURNING *`,
      insertParams: [checkin.user_id, localDate, checkinId, checkin.timestamp, evidence.id, qualifies],
      conflictSelectSql: "SELECT * FROM bonus_attendance_records WHERE checkin_id = $1",
      conflictSelectParams: [checkinId],
    });

    let ledger = null;
    if (!alreadyExisted && qualifies) {
      const collectibleDeltaScaled = FULL_CREDIT_SCALED;
      const { rule, pointsDeltaScaled } = await scaledPoints("cherry", checkin.timestamp, collectibleDeltaScaled);
      ({ row: ledger } = await postLedgerEntry(client, {
        userId: checkin.user_id,
        activity: "cherry",
        collectibleDeltaScaled,
        pointsDeltaScaled,
        ruleVersionId: rule?.id ?? null,
        attendanceId: attendance.id,
        operationKey: `attendance:cherry:${checkin.user_id}:${localDate}`,
      }));
    }
    await client.query("COMMIT");
    return { attendance, ledger };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Reverses a source contribution's earning: reverses its ledger entry (if
// one was posted -- a contribution that never earned anything, e.g. a
// GPS-rejected visit, has none), gives back the earning-unit capacity it
// consumed, and marks the contribution 'reversed'. Idempotent: reversing an
// already-reversed contribution is a no-op (alreadyReversed: true), and
// reverseLedgerEntry's own operation_key convention means even a duplicate
// call that somehow reaches the ledger insert again lands on the same row.
// Not used for the attendance/cherry path today (call reverseLedgerEntry
// directly against the attendance-linked ledger row for that case) --
// attendance records have no earning-unit capacity to give back.
export async function reverseSourceContribution(sourceTable, sourceId, { reason, actorId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM bonus_source_contributions WHERE source_table = $1 AND source_id = $2", [
      sourceTable,
      sourceId,
    ]);
    const contribution = rows[0];
    if (!contribution) throw new Error(`reverseSourceContribution: no contribution for ${sourceTable}:${sourceId}`);
    if (contribution.status === "reversed") {
      await client.query("ROLLBACK");
      return { contribution, ledger: null, alreadyReversed: true };
    }

    const { rows: ledgerRows } = await client.query(
      "SELECT * FROM bonus_point_ledger WHERE source_contribution_id = $1 AND reversal_of_id IS NULL",
      [contribution.id]
    );
    let ledger = null;
    if (ledgerRows[0]) {
      ({ row: ledger } = await reverseLedgerEntry(client, ledgerRows[0].id, { reason, actorId }));
      await lockEarningUnitById(client, contribution.earning_unit_id);
      await addToEarningUnit(client, contribution.earning_unit_id, -contribution.contributes_scaled);
    }

    const { rows: updated } = await client.query(
      "UPDATE bonus_source_contributions SET status = 'reversed' WHERE id = $1 RETURNING *",
      [contribution.id]
    );
    await client.query("COMMIT");
    return { contribution: updated[0], ledger, alreadyReversed: false };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
