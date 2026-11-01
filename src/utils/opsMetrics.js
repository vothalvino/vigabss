'use strict';

// =============================================================================
// Operational metrics recorded outside HTTP (OPS-15)
// =============================================================================
// The shipped backup alert queried fireisp_last_backup_timestamp_seconds and
// nothing exported it; scheduled tasks had no run or failure counters. These
// are recorded where the work happens and read by /metrics.
// =============================================================================

const { registry } = require('./metricsRegistry');

const scheduledTaskRuns = registry.counter({
  name: 'scheduled_task_runs_total',
  help: 'Scheduled task runs by task and outcome',
  labelNames: ['task', 'status'],
  maxSeries: 400,
});

let lastBackupSeconds = null;
let lastBackupLoadedAt = 0;
const BACKUP_RELOAD_MS = 5 * 60 * 1000;

function noteBackupSuccess(at = new Date()) {
  lastBackupSeconds = Math.floor(at.getTime() / 1000);
  lastBackupLoadedAt = Date.now();
}

// After a restart the timestamp is read back from backup_runs (the backup may
// have run in another process). The refresh is asynchronous; a scrape never
// waits on the database.
function refreshLastBackupFromDb() {
  if (Date.now() - lastBackupLoadedAt < BACKUP_RELOAD_MS) return;
  lastBackupLoadedAt = Date.now();
  const db = require('../config/database');
  db.query("SELECT UNIX_TIMESTAMP(MAX(finished_at)) AS ts FROM backup_runs WHERE status = 'success'")
    .then(([[row]]) => {
      const ts = Number(row?.ts);
      if (Number.isFinite(ts) && ts > 0 && (lastBackupSeconds === null || ts > lastBackupSeconds)) lastBackupSeconds = ts;
    })
    .catch(() => {});
}

registry.collected({
  name: 'fireisp_last_backup_timestamp_seconds',
  help: 'Unix time of the last successful database backup',
  collect: () => {
    refreshLastBackupFromDb();
    return lastBackupSeconds;
  },
});

function noteTaskRun(task, status) {
  scheduledTaskRuns.inc({ task, status });
}

module.exports = { noteBackupSuccess, noteTaskRun, scheduledTaskRuns };
