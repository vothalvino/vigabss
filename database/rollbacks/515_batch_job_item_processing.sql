-- =============================================================================
-- Rollback 515 — batch job items claimed before they run (TNA-41)
-- =============================================================================
-- Roll back the application code with this. An item left 'processing' becomes
-- a failure, which is what the resumed job would have recorded. Safe to re-run.
-- =============================================================================

UPDATE batch_job_items
   SET status = 'failure', result_message = 'Interrupted before its outcome was recorded; check it by hand'
 WHERE status = 'processing';

ALTER TABLE batch_job_items
    MODIFY COLUMN status ENUM('pending','success','failure','skipped') NOT NULL DEFAULT 'pending';
