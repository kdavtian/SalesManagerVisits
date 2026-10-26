// A notification shows the K while Calculator Mode is off and the plain calculator while it is on (owner, 2026-10-26).
import test from "node:test";
import assert from "node:assert/strict";
import { pushIcons } from "../../src/push.js";

test("push icons follow Calculator Mode", () => {
  assert.deepEqual(pushIcons(false), { icon: "/icons/app/icon-192.png", badge: "/icons/app/icon-192.png" });
  assert.deepEqual(pushIcons(true), { icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" });
});
