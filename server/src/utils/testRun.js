// True inside an automated test run (NODE_ENV=test, or any process started by `node --test`). The "X is not set" start-up notices are useful in
// production and dev, but a full test run starts ~150 processes and printed three of them each: hundreds of identical lines.
export const isTestRun = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
