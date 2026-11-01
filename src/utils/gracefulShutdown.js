'use strict';

// =============================================================================
// Graceful shutdown (OPS-13)
// =============================================================================
// server.close() calls back only once every socket has closed, upgraded
// WebSockets and open SSE responses included. The WebSocket servers used to be
// closed inside that callback, so with one staff tab or FireRelay agent
// connected the callback never fired: the process sat until the force-exit
// timer (exit 1) or Docker's SIGKILL, and the job queue, scheduler and DB
// teardown never ran. The order here is:
//   1. stop accepting HTTP connections and stop the scheduler, RADIUS and the
//      trap receiver;
//   2. close the WebSocket servers at once (they terminate their sockets);
//   3. give in-flight HTTP requests drainMs, then cut what is left (SSE);
//   4. close the job queue and the database, then exit 0.
// timeoutMs stays below the container's stop_grace_period (30 s).
// =============================================================================

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * @param {object} deps
 * @param {import('http').Server} deps.server
 * @param {{ close(): Promise<void> }[]} deps.socketServers - WebSocket servers to close first
 * @param {() => (Promise<void>|void)} [deps.stopIntake] - stop non-HTTP intake (scheduler, RADIUS, …)
 * @param {() => Promise<void>} [deps.closeQueues]
 * @param {() => Promise<void>} deps.closeDb
 * @param {object} deps.logger
 * @param {number} [deps.drainMs]
 * @param {number} [deps.timeoutMs]
 * @param {(code: number) => void} [deps.exit]
 */
function createGracefulShutdown({
  server, socketServers = [], stopIntake = () => {}, closeQueues = async () => {}, closeDb,
  logger, drainMs = 5000, timeoutMs = 25000, exit = (code) => process.exit(code),
}) {
  let started = false;

  return async function gracefulShutdown(signal) {
    if (started) return;
    started = true;
    logger.info({ signal }, `${signal} received, starting graceful shutdown…`);

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, 'Shutdown timeout reached — forcing exit');
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    const httpClosed = new Promise((resolve) => server.close(() => resolve()));
    const intakeDrained = Promise.resolve().then(stopIntake).catch((err) => {
      logger.warn({ err }, 'Stopping background intake failed during shutdown');
    });

    await Promise.allSettled(socketServers.map((s) => Promise.resolve().then(() => s.close())));
    server.closeIdleConnections?.();

    const drained = await Promise.race([httpClosed.then(() => true), delay(drainMs).then(() => false)]);
    if (!drained) {
      logger.warn({ drainMs }, 'HTTP connections still open after the drain window — closing them (SSE streams)');
      server.closeAllConnections?.();
      await httpClosed;
    }
    logger.info('HTTP server closed');

    await intakeDrained;
    await closeQueues().catch(() => {});
    await closeDb();
    clearTimeout(timer);
    logger.info('All resources released — exiting');
    exit(0);
  };
}

module.exports = { createGracefulShutdown };
