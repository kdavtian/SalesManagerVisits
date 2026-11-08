import test from "node:test";
import assert from "node:assert/strict";
import { MIN_TASK_PAYMENT_AMD, taskPaymentThreshold, paymentCountsForTask } from "../src/team/taskPaymentRule.js";

test("the limit is MIN(20,000, the debt before the payment)", () => {
  assert.equal(MIN_TASK_PAYMENT_AMD, 20000);
  assert.equal(taskPaymentThreshold(200000), 20000);
  assert.equal(taskPaymentThreshold(5000), 5000);
  assert.equal(taskPaymentThreshold(0), 20000);
  assert.equal(taskPaymentThreshold(null), 20000);
});

test("tiny payments do not count, the limit and the whole small balance do", () => {
  assert.equal(paymentCountsForTask(1, 200000), false);
  assert.equal(paymentCountsForTask(19999, 200000), false);
  assert.equal(paymentCountsForTask(20000, 200000), true);
  assert.equal(paymentCountsForTask(5000, 5000), true);
  assert.equal(paymentCountsForTask(4999, 5000), false);
  assert.equal(paymentCountsForTask(5000, 5000.4), true);
});
