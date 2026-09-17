// Real-Postgres coverage for the Phase 7 personal-bests module: a
// completed week's totals raise (never lower) a user's best, and
// lastCompletedWeekBounds always resolves to the week before "now"'s week.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { updatePersonalBestsForWeek, lastCompletedWeekBounds, listPersonalBestsForUser } from "../../src/bonusPersonalBests.js";
import { yerevanWeekBounds } from "../../src/utils/yerevanDate.js";
import { createUser, cleanupAll } from "./helpers.js";

const userIds = [];

test.after(async () => {
  if (userIds.length) {
    await pool.query("DELETE FROM bonus_personal_bests WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  }
  await cleanupAll();
});

// bonus_point_ledger requires exactly one of source_contribution_id /
// attendance_id / challenge_award_id -- attendance_id is the simplest to
// satisfy for a fixture that only cares about the ledger totals.
async function insertLedgerRow(userId, localDate, occurrenceAt, collectibleScaled, operationKey) {
  const { rows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, $2, $3, true) RETURNING id`,
    [userId, localDate, occurrenceAt]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key, created_at)
     VALUES ($1, 'strawberry', $2, $2, $3, $4, $5)`,
    [userId, collectibleScaled, rows[0].id, operationKey, occurrenceAt]
  );
}

test("lastCompletedWeekBounds: resolves to the week before now's week", () => {
  const now = new Date("2026-09-17T10:00:00Z"); // a Thursday
  const thisWeek = yerevanWeekBounds(now);
  const lastWeek = lastCompletedWeekBounds(now);
  assert.ok(lastWeek.endAt <= thisWeek.startAt);
  const diffDays = (thisWeek.startAt.getTime() - lastWeek.startAt.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(diffDays, 7);
});

test("updatePersonalBestsForWeek: raises a best from a completed week's ledger totals", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  const weekStartAt = new Date("2020-04-06T00:00:00Z"); // a Monday
  const weekEndAt = new Date("2020-04-13T00:00:00Z");

  await insertLedgerRow(manager.id, "2020-04-07", new Date("2020-04-07T09:00:00Z"), 300, "pb-test-1");

  await updatePersonalBestsForWeek(weekStartAt, weekEndAt);

  const bests = await listPersonalBestsForUser(manager.id);
  const collectibleBest = bests.find((b) => b.metric === "collectible_count");
  const pointsBest = bests.find((b) => b.metric === "points");
  assert.equal(Number(collectibleBest.best_value_scaled), 300);
  assert.equal(Number(pointsBest.best_value_scaled), 300);

  // A later, smaller week must never lower an already-recorded best.
  const smallerWeekStartAt = new Date("2020-04-13T00:00:00Z");
  const smallerWeekEndAt = new Date("2020-04-20T00:00:00Z");
  await insertLedgerRow(manager.id, "2020-04-14", new Date("2020-04-14T09:00:00Z"), 100, "pb-test-2");
  await updatePersonalBestsForWeek(smallerWeekStartAt, smallerWeekEndAt);

  const bestsAfter = await listPersonalBestsForUser(manager.id);
  const collectibleBestAfter = bestsAfter.find((b) => b.metric === "collectible_count");
  assert.equal(Number(collectibleBestAfter.best_value_scaled), 300);
  assert.equal(collectibleBestAfter.achieved_week_start.toISOString().slice(0, 10), "2020-04-06");

  // A later, bigger week must raise the best and move the achieved date.
  const biggerWeekStartAt = new Date("2020-04-20T00:00:00Z");
  const biggerWeekEndAt = new Date("2020-04-27T00:00:00Z");
  await insertLedgerRow(manager.id, "2020-04-21", new Date("2020-04-21T09:00:00Z"), 500, "pb-test-3");
  await updatePersonalBestsForWeek(biggerWeekStartAt, biggerWeekEndAt);

  const bestsFinal = await listPersonalBestsForUser(manager.id);
  const collectibleBestFinal = bestsFinal.find((b) => b.metric === "collectible_count");
  assert.equal(Number(collectibleBestFinal.best_value_scaled), 500);
  assert.equal(collectibleBestFinal.achieved_week_start.toISOString().slice(0, 10), "2020-04-20");
});
