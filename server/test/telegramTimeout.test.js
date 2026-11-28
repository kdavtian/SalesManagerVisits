// Improvement plan 0.22: a Telegram call that never answers must not hold the request or job that sent it: every send has a 10 s limit.
process.env.NODE_ENV = "development";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_NOTIFY_CHAT_IDS = "1";

import test from "node:test";
import assert from "node:assert/strict";

test("notifyTelegram sends with a time limit and survives a send that times out", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.signal);
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  const errors = console.error;
  console.error = () => {};
  try {
    const { notifyTelegram, TELEGRAM_TIMEOUT_MS } = await import("../src/shared/telegram.js");
    assert.equal(TELEGRAM_TIMEOUT_MS, 10_000);
    await notifyTelegram("hello"); // must not throw
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof AbortSignal, "a signal is passed");
  } finally {
    globalThis.fetch = realFetch;
    console.error = errors;
  }
});
