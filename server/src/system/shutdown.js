// A deploy stops the container with SIGTERM (improvement plan 0.8). Before this, Node ignored it and Docker killed the server 10 s later,
// mid photo upload or mid Excel sync. Now: stop taking new connections, let requests in progress finish, let no new background job start
// (and wait for the running ones), then close the database connections and exit. Everything is capped at capMs (25 s, under the 30 s
// stop_grace_period in docker-compose.yml); after that the remaining connections are cut and the database is given at most 2 s more.
// A second signal exits at once.
export const SHUTDOWN_CAP_MS = 25_000;

export function createShutdown({ server, stopJobs, closeDb, capMs = SHUTDOWN_CAP_MS, log = console, exit = (code) => process.exit(code) }) {
  let started = null;

  function shutdown(signal = "SIGTERM") {
    if (started) {
      log.warn?.(`${signal} again: exiting now`);
      exit(1);
      return started;
    }
    log.log?.(`${signal} received: finishing work in progress (up to ${Math.round(capMs / 1000)} s), then exiting`);
    const deadline = Date.now() + capMs;
    const left = () => Math.max(0, deadline - Date.now());
    started = (async () => {
      let cutTimer;
      const httpClosed = new Promise((resolve) => {
        server.close(() => resolve());
        // idle keep-alive connections would hold close() open; requests in progress keep theirs until they answer
        server.closeIdleConnections?.();
        cutTimer = setTimeout(() => {
          log.warn?.("Shutdown: requests still open at the time limit, closing them");
          server.closeAllConnections?.();
          resolve();
        }, left());
        cutTimer.unref?.();
      });
      const jobsLeft = stopJobs(left());
      await Promise.all([httpClosed, jobsLeft]);
      clearTimeout(cutTimer);
      // closing waits for every borrowed connection; a run past its limit may still hold one, so this wait is capped too (at least 2 s)
      let dbTimer;
      const dbCap = new Promise((resolve) => {
        dbTimer = setTimeout(() => {
          log.warn?.("Shutdown: database connections still busy at the time limit, exiting anyway");
          resolve();
        }, Math.max(2000, left()));
        dbTimer.unref?.();
      });
      try {
        await Promise.race([closeDb(), dbCap]);
      } catch (err) {
        log.error?.("Shutdown: closing the database failed:", err.message);
      }
      clearTimeout(dbTimer);
      log.log?.("Shutdown complete");
      exit(0);
    })();
    return started;
  }

  return shutdown;
}
