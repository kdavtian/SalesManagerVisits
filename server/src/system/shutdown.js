// A deploy stops the container with SIGTERM (improvement plan 0.8). Before this, Node ignored it and Docker killed the server 10 s later,
// mid photo upload or mid Excel sync. Now: stop taking new connections, let requests in progress finish, let no new background job start
// (and wait for the running ones), then close the database connections and exit. Everything is capped at capMs (25 s, under the 30 s
// stop_grace_period in docker-compose.yml); after that the remaining connections are cut. A second signal exits at once.
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
      try {
        await closeDb();
      } catch (err) {
        log.error?.("Shutdown: closing the database failed:", err.message);
      }
      log.log?.("Shutdown complete");
      exit(0);
    })();
    return started;
  }

  return shutdown;
}
