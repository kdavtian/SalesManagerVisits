// A check-in sent later from the offline queue keeps the time the rep pressed
// submit (captured_at) -- but only when it is plausible.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCapturedAt } from "../../src/routes/checkins.js";

const NOW = Date.parse("2031-03-10T12:00:00Z");

test("captured_at: accepted when recent and not in the future, otherwise ignored", () => {
  assert.equal(parseCapturedAt("2031-03-10T09:30:00Z", NOW), "2031-03-10T09:30:00.000Z");
  assert.equal(parseCapturedAt("2031-03-08T09:30:00Z", NOW), "2031-03-08T09:30:00.000Z"); // two days offline
  assert.equal(parseCapturedAt("2031-03-10T12:03:00Z", NOW), "2031-03-10T12:03:00.000Z"); // small clock skew
  assert.equal(parseCapturedAt("2031-03-10T13:00:00Z", NOW), null); // future
  assert.equal(parseCapturedAt("2031-02-20T09:30:00Z", NOW), null); // older than a week
  assert.equal(parseCapturedAt("not a date", NOW), null);
  assert.equal(parseCapturedAt(undefined, NOW), null);
});
