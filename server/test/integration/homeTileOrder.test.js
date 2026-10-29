// Each person's own order of the Home buttons (owner, 2026-10-29; migration 169): saved on the server for that person only.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";

let cookieA, cookieB;
test.before(async () => {
  await startTestServer();
  cookieA = await loginAs((await createUser("sales_manager")).email);
  cookieB = await loginAs((await createUser("sales_manager")).email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("the order is saved for the person, comes back from /me and at login, and resets to the standard order", async () => {
  assert.equal((await apiRequest("/api/me", { cookie: cookieA })).data.home_tile_order, null);
  const put = await apiRequest("/api/me/home-order", { method: "PUT", cookie: cookieA, body: { order: ["qa_tasks", "qa_check_in", "qa_tasks"] } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.home_tile_order, ["qa_tasks", "qa_check_in"], "a repeated id is kept once");
  assert.deepEqual((await apiRequest("/api/me", { cookie: cookieA })).data.home_tile_order, ["qa_tasks", "qa_check_in"]);
  assert.equal((await apiRequest("/api/me", { cookie: cookieB })).data.home_tile_order, null, "another person keeps their own");
  assert.equal((await apiRequest("/api/me/home-order", { method: "PUT", cookie: cookieA, body: { order: null } })).status, 200);
  assert.equal((await apiRequest("/api/me", { cookie: cookieA })).data.home_tile_order, null);
});

test("only a list of tile ids is accepted, and only when signed in", async () => {
  for (const order of ["qa_tasks", [1, 2], ["DROP TABLE users"], Array.from({ length: 81 }, (_, i) => `qa_x${"a".repeat(i % 5)}`)]) {
    assert.equal((await apiRequest("/api/me/home-order", { method: "PUT", cookie: cookieA, body: { order } })).status, 400, JSON.stringify(order).slice(0, 40));
  }
  assert.equal((await apiRequest("/api/me/home-order", { method: "PUT", body: { order: [] } })).status, 401);
});
