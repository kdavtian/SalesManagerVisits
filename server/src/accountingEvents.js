// In-process wake-up for Lily's long-poll (GET /api/integration/v1/wait):
// anything that puts an order into the accounting queue calls
// accountingQueueChanged(), and a waiting Lily returns at once instead of
// finding out on her next poll. A waiting call also re-checks the database
// every few seconds, so a missed event (or a second server process) only
// costs that delay.
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function accountingQueueChanged() {
  emitter.emit("queue");
}

// Resolves when the queue changes or after ms, whichever comes first.
export function waitForQueueChange(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      emitter.off("queue", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    emitter.once("queue", done);
  });
}
