-- =============================================================================
-- Migration 513 — scheduled task run history (ASY-28)
-- =============================================================================
-- scheduled_tasks kept only the last status, and the worker path never wrote
-- a failure: a task that threw under BullMQ kept its previous 'success'. One
-- row per run now records how it was triggered, its outcome, its duration and
-- the error, from the cron path, the worker and a manual run alike. Old rows
-- are pruned by the retention task (RETENTION_SCHEDULED_TASK_RUNS_DAYS,
-- default 30). Re-runnable: CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    scheduled_task_id  BIGINT UNSIGNED NULL     COMMENT 'NULL once the task row is deleted',
    organization_id    BIGINT UNSIGNED NULL     COMMENT 'The task row''s organization; NULL = install-wide',
    task_name          VARCHAR(100)    NOT NULL,
    trigger_source     ENUM('cron','worker','manual') NOT NULL COMMENT 'cron = inline scheduler, worker = BullMQ job, manual = POST /scheduled-tasks/:id/run',
    status             ENUM('success','failed','skipped','timed_out') NOT NULL,
    started_at         TIMESTAMP(3)    NOT NULL,
    finished_at        TIMESTAMP(3)    NOT NULL,
    duration_ms        INT UNSIGNED    NOT NULL,
    error_message      VARCHAR(1000)   NULL,
    host               VARCHAR(255)    NULL     COMMENT 'Process that ran it: hostname:pid',
    PRIMARY KEY (id),
    KEY idx_scheduled_task_runs_task (scheduled_task_id, started_at),
    KEY idx_scheduled_task_runs_org (organization_id, started_at),
    KEY idx_scheduled_task_runs_started (started_at),
    CONSTRAINT fk_scheduled_task_runs_task FOREIGN KEY (scheduled_task_id)
        REFERENCES scheduled_tasks (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_scheduled_task_runs_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One row per scheduled task run (ASY-28)';
