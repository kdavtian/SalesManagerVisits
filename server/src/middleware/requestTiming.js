// Flags slow API requests to the server console -- the only "measure slow
// endpoints" tooling this app has today (no APM, no request logger at
// all). Deliberately minimal: log past a threshold, don't store or
// aggregate anything, so this can't itself become a performance or
// storage problem on a single-instance deployment.
const SLOW_REQUEST_MS = 750;

export function requestTiming(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs >= SLOW_REQUEST_MS) {
      console.warn(`[slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(0)}ms`);
    }
  });
  next();
}
