// Constant-time comparison used to authenticate the ERP sync bot's shared
// secret (server/src/routes/erpSync.js).
import "dotenv/config"; // routes/erpSync.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "../src/routes/erpSync.js";

test("timingSafeEqual: identical strings match", () => {
  assert.equal(timingSafeEqual("shared-secret-key", "shared-secret-key"), true);
});

test("timingSafeEqual: differing strings of the same length do not match", () => {
  assert.equal(timingSafeEqual("shared-secret-key", "shared-secret-keZ"), false);
});

test("timingSafeEqual: differing lengths do not match, and do not throw", () => {
  assert.equal(timingSafeEqual("short", "a-much-longer-secret"), false);
});

test("timingSafeEqual: empty strings compared to each other match", () => {
  assert.equal(timingSafeEqual("", ""), true);
});

test("timingSafeEqual: an empty string against a non-empty one does not match", () => {
  assert.equal(timingSafeEqual("", "x"), false);
});
