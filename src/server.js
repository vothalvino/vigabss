// =============================================================================
// VigaBSS — Server Entry Point
// =============================================================================

require('dotenv').config();
const config = require('./config');
const app = require('./app');
const db = require('./config/database');
const scheduler = require('./services/scheduler');
const jobQueue = require('./services/jobQueueService');
const workers = require('./workers');
const updateCheck = require('./services/updateCheck');
const { tunnelServer } = require('./services/firerelayTunnel');
const { wsHub } = require('./services/wsHub');
const snmpTrapReceiver = require('./services/snmpTrapReceiver');
const radiusServer = require('./services/radiusServerService');
const wireguardRuntime = require('./services/wireguardRuntimeService');
const logger = require('./utils/logger');
const { createGracefulShutdown } = require('./utils/gracefulShutdown');
const product = require('./product');

async function start() {
  // Validate critical environment variables before anything else
  config.validateEnv(logger);

  // Verify database connectivity
  try {
    const [rows] = await db.query('SELECT 1 AS connected');
    if (rows[0].connected === 1) {
      logger.info({ host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || '3306', db: process.env.DB_NAME || 'fireisp' }, 'Database connected');
    }
  } catch (err) {
    logger.fatal({ err }, 'Database connection failed');
    process.exit(1);
  }

  // Check migration status
  try {
    const fs = require('fs');
    const path = require('path');
    const migrationsDir = path.resolve(__dirname, '../database/migrations');
    const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    const [applied] = await db.query(
      'SELECT COUNT(*) AS count FROM schema_migrations',
    );
    const appliedCount = applied[0].count;
    const totalCount = migrationFiles.length;

    if (appliedCount < totalCount) {
      logger.warn(
        { applied: appliedCount, total: totalCount, pending: totalCount - appliedCount },
        'Pending migrations detected — run `npm run migrate`',
      );
    } else {
      logger.info({ migrations: appliedCount }, 'All migrations applied');
    }
  } catch (migrationErr) {
    // schema_migrations table may not exist yet on fresh installs
    logger.warn({ err: migrationErr }, 'Could not check migration status — run `npm run migrate` first');
  }

  // The CSP's img-src follows the configured map tile server (FE-11).
  require('./utils/mapTileOrigins').startMapTileOriginRefresh();

  // Start the cron scheduler. SCHEDULER_ENABLED=false keeps this process out
  // of cron (e.g. web-only pods); every task still runs once per tick across
  // the processes that do start it (scheduler.runClaimed / BullMQ job ids).
  if (process.env.SCHEDULER_ENABLED === 'false') {
    logger.info('Scheduler disabled on this process (SCHEDULER_ENABLED=false)');
  } else {
    try {
      await scheduler.start();
    } catch (err) {
      logger.warn({ err }, 'Scheduler failed to start');
    }
  }

  // Register BullMQ job workers (no-op when REDIS_URL is unset)
  try {
    workers.registerWorkers();
  } catch (err) {
    logger.warn({ err }, 'Worker registration failed');
  }

  // Populate the update-check cache so the first visit to Settings -> Version is
  // served from memory rather than waiting on api.github.com. Deliberately NOT
  // awaited: boot must not depend on a third party being reachable, and a
  // failure is cached with its own retry window. No-op unless the operator
  // enabled checks.
  try {
    updateCheck.warmCache();
  } catch (err) {
    logger.warn({ err }, 'Update-check warm failed');
  }

  // Restore the installation-wide GUI choice. The web/API process remains
  // non-root; an enabled hub delegates kernel operations to the isolated helper.
  try {
    await wireguardRuntime.initialize();
  } catch (err) {
    logger.warn({ err }, 'WireGuard runtime initialization failed; hub remains disabled');
  }

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env, version: product.version }, `${product.displayName} listening`);
  });

  // Attach the FireRelay WebSocket tunnel to the HTTP server
  try {
    tunnelServer.attach(server);
  } catch (err) {
    logger.warn({ err }, 'FireRelay tunnel failed to attach');
  }

  // Attach the WebSocket hub for real-time browser clients
  try {
    wsHub.attach(server);
  } catch (err) {
    logger.warn({ err }, 'WsHub failed to attach');
  }

  // Start the SNMP trap receiver (UDP listener for unsolicited device alerts)
  try {
    const trapStatus = await snmpTrapReceiver.start();
    if (!trapStatus.ready) {
      logger.warn({ reason: trapStatus.reason }, 'SNMP trap receiver is not ready');
    }
  } catch (err) {
    logger.warn({ err }, 'SNMP trap receiver failed to start');
  }

  // Start the embedded RADIUS server (no-op unless RADIUS_SERVER_ENABLED=true)
  try {
    radiusServer.start();
  } catch (err) {
    logger.warn({ err }, 'Embedded RADIUS server failed to start');
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown — see utils/gracefulShutdown (OPS-13): WebSocket servers
  // close first, open SSE streams are cut after a drain window, and the force
  // exit stays below the container's 30 s stop_grace_period.
  // ---------------------------------------------------------------------------
  const gracefulShutdown = createGracefulShutdown({
    server,
    socketServers: [tunnelServer, wsHub],
    stopIntake: async () => {
      // Stop UDP acceptance first; the promise drains the receiver's bounded
      // in-flight transaction set before the DB closes.
      const trapDrain = snmpTrapReceiver.stop();
      radiusServer.stop();
      scheduler.stop();
      require('./utils/mapTileOrigins').stopMapTileOriginRefresh();
      await trapDrain;
    },
    closeQueues: () => jobQueue.close(),
    closeDb: () => db.close(),
    logger,
    drainMs: parseInt(process.env.SHUTDOWN_DRAIN_MS || '5000', 10),
    timeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10),
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

start().catch(err => {
  logger.fatal({ errorName: err?.name || 'Error' }, 'Failed to start');
  process.exit(1);
});
