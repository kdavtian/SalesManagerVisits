import test from "node:test";
import assert from "node:assert/strict";
import { rewardCard, rewardKindKey } from "../../client/public/js/shell/taskRewardMessages.js";

test("the kind of work picks the wording", () => {
  assert.equal(rewardKindKey({ auto_kind: "debt_collection" }), "reward_kind_debt");
  assert.equal(rewardKindKey({ task_kind: "make_order" }), "reward_kind_order");
  assert.equal(rewardKindKey({ auto_kind: "reorder_followup" }), "reward_kind_order");
  assert.equal(rewardKindKey({ task_kind: "visit_customer" }), "reward_kind_visit");
  assert.equal(rewardKindKey({ task_kind: "check_products" }), "reward_kind_check");
  assert.equal(rewardKindKey({}), "reward_kind_default");
});

test("one task: a title, its kind and customer, week count and what is left; the last open task is a big moment", () => {
  const c = rewardCard([{ id: 4, task_kind: "collect_debt", customer_name: "Shop" }], { done_today: 1, done_week: 5, open_left: 2, overdue_left: 0 });
  assert.match(c.titleKey, /^reward_title_[123]$/);
  assert.equal(c.kindKey, "reward_kind_debt");
  assert.equal(c.customer, "Shop");
  assert.deepEqual(c.lines.map((l) => l.key), ["reward_week", "reward_left"]);
  assert.equal(c.big, false);
  const last = rewardCard([{ id: 4 }], { done_today: 1, done_week: 1, open_left: 0, overdue_left: 0 });
  assert.equal(last.big, true);
  assert.ok(last.lines.some((l) => l.key === "reward_all_clear"));
});

test("several at once: one card with up to 3 names and a +more; overdue shown before 'left'; no stats still works", () => {
  const list = [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `T${i}`, customer_name: i < 3 ? `C${i}` : null }));
  const c = rewardCard(list, { done_today: 5, done_week: 9, open_left: 3, overdue_left: 2 });
  assert.equal(c.titleKey, "reward_title_many");
  assert.deepEqual(c.names, ["C1", "C2", "T3"]);
  assert.equal(c.more, 2);
  assert.equal(c.big, true);
  assert.ok(c.lines.some((l) => l.key === "reward_overdue" && l.n === 2));
  assert.deepEqual(rewardCard([{ id: 1 }], null).lines, []);
});
