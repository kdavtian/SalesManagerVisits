// Notification eligibility precedence (server/src/notificationPreferences.js):
// a user-scoped setting always wins over a role-scoped one; with neither,
// a notification is enabled by default (opt-out, not opt-in).
import "dotenv/config"; // notificationPreferences.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { resolveNotificationEnabled, NOTIFICATION_TYPES } from "../src/notificationPreferences.js";

test("resolveNotificationEnabled: no matching rows at all defaults to enabled", () => {
  assert.equal(resolveNotificationEnabled([]), true);
});

test("resolveNotificationEnabled: a role-scoped row alone is honored", () => {
  assert.equal(resolveNotificationEnabled([{ scope_type: "role", enabled: false }]), false);
  assert.equal(resolveNotificationEnabled([{ scope_type: "role", enabled: true }]), true);
});

test("resolveNotificationEnabled: a user-scoped row alone is honored", () => {
  assert.equal(resolveNotificationEnabled([{ scope_type: "user", enabled: false }]), false);
});

test("resolveNotificationEnabled: a user-scoped row overrides a role-scoped row, opting out", () => {
  const rows = [
    { scope_type: "role", enabled: true },
    { scope_type: "user", enabled: false },
  ];
  assert.equal(resolveNotificationEnabled(rows), false);
});

test("resolveNotificationEnabled: a user-scoped row overrides a role-scoped row, opting back in", () => {
  const rows = [
    { scope_type: "role", enabled: false },
    { scope_type: "user", enabled: true },
  ];
  assert.equal(resolveNotificationEnabled(rows), true);
});

test("resolveNotificationEnabled: row order in the array doesn't matter -- user scope always wins", () => {
  const rows = [
    { scope_type: "user", enabled: false },
    { scope_type: "role", enabled: true },
  ];
  assert.equal(resolveNotificationEnabled(rows), false);
});

test("NOTIFICATION_TYPES: is a non-empty flat list of unique string identifiers", () => {
  assert.ok(Array.isArray(NOTIFICATION_TYPES) && NOTIFICATION_TYPES.length > 0);
  assert.equal(new Set(NOTIFICATION_TYPES).size, NOTIFICATION_TYPES.length, "no duplicate notification types");
  for (const type of NOTIFICATION_TYPES) assert.equal(typeof type, "string");
});
