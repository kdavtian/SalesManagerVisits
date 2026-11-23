// Where is the cash now (owner, 2026-11-23)? shared/cashPlace.js: ONE answer per payment for every screen, and the same rule gives the
// cash track of the copied payment (payments2/bridge.js).
import test from "node:test";
import assert from "node:assert/strict";
import { cashPlace, cashStateOf, CASH_PLACES } from "../src/shared/cashPlace.js";

const base = { status: "pending", approved_by: null, approved_from_erp: false, pending_handoff_id: null, holder_role: "sales_manager", holder_name: "Artak", handoff_to_name: null, on_office_desk: false };
const place = (over) => cashPlace({ ...base, ...over });

test("the journey: with the rep -> handed over -> counted by the director -> handed on -> at the office", () => {
  assert.deepEqual(place({}), { place: "with_rep", name: "Artak", to: null });
  assert.deepEqual(place({ pending_handoff_id: 7, handoff_to_name: "Martin" }), { place: "on_the_way", name: "Artak", to: "Martin" });
  assert.deepEqual(place({ holder_role: "sales_director", holder_name: "Martin" }), { place: "with_director", name: "Martin", to: null });
  assert.deepEqual(place({ holder_role: "sales_director", holder_name: "Martin", pending_handoff_id: 8, handoff_to_name: "Mane" }), { place: "on_the_way", name: "Martin", to: "Mane" });
  assert.equal(place({ status: "approved", approved_by: 3, holder_role: "accountant", holder_name: "Mane" }).place, "office");
});

test("the Excel alone does not move the notes: approved from the Excel only is still where its holder is", () => {
  assert.equal(place({ status: "approved", approved_from_erp: true }).place, "with_rep");
  assert.equal(place({ status: "approved", approved_from_erp: true, holder_role: "sales_director" }).place, "with_director");
  assert.equal(place({ status: "approved", approved_from_erp: true, approved_by: 3 }).place, "office", "then the accountant received it in a hand-over");
});

test("at the office: an accountant holds it, a person approved it (the CEO directly), or it is on the office desk", () => {
  assert.equal(place({ holder_role: "accountant" }).place, "office");
  assert.deepEqual(place({ status: "approved", approved_by: 9, holder_role: "ceo", holder_name: "Ilona" }), { place: "office", name: "Ilona", to: null, direct: true }, "taken directly: the mark names the person");
  assert.equal(place({ status: "approved", approved_by: 3, holder_role: "accountant", holder_name: "Mane" }).direct, undefined);
  assert.equal(place({ holder_role: "ceo", on_office_desk: true }).place, "office");
  assert.equal(place({ holder_role: "ceo" }).place, "with_director", "a CEO holding cash from before, not on the office desk");
});

test("rejected wins; a holder nobody knows or a driver counts as the collector; every answer is a known place", () => {
  assert.equal(place({ status: "rejected", pending_handoff_id: 4 }).place, "rejected");
  assert.equal(place({ holder_role: null, holder_name: null }).place, "with_rep");
  assert.equal(place({ holder_role: "delivery_manager" }).place, "with_rep");
  for (const role of ["sales_manager", "sales_director", "ceo", "operations_director", "admin", "accountant", "delivery_manager", null]) {
    for (const status of ["pending", "approved", "rejected"]) assert.ok(CASH_PLACES.includes(place({ status, holder_role: role }).place));
  }
});

test("the cash track of the copy: collected / counted / received; a waiting hand-over has not moved the cash", () => {
  assert.equal(cashStateOf(base), "collected");
  assert.equal(cashStateOf({ ...base, pending_handoff_id: 7 }), "collected");
  assert.equal(cashStateOf({ ...base, holder_role: "sales_director" }), "counted");
  assert.equal(cashStateOf({ ...base, holder_role: "admin" }), "counted");
  assert.equal(cashStateOf({ ...base, holder_role: "sales_director", pending_handoff_id: 8 }), "counted");
  assert.equal(cashStateOf({ ...base, holder_role: "accountant" }), "received");
  assert.equal(cashStateOf({ ...base, status: "approved", approved_by: 2 }), "received");
  assert.equal(cashStateOf({ ...base, status: "approved", approved_from_erp: true }), "collected");
  assert.equal(cashStateOf({ ...base, holder_role: "ceo", on_office_desk: true }), "received");
});
