-- =============================================================================
-- Rollback 523 — A firmware download is done when it is installed
-- =============================================================================
-- Downloads still awaiting confirmation cannot keep that status: they are
-- failed (the CPE never confirmed them), then the value is dropped.
-- =============================================================================

UPDATE cpe_tasks
   SET status = 'failed', completed_at = NOW(),
       error_message = 'Unconfirmed when migration 523 was rolled back'
 WHERE status = 'awaiting_transfer';

ALTER TABLE cpe_tasks
    MODIFY COLUMN status ENUM('queued','in_progress','done','failed') NOT NULL DEFAULT 'queued';
