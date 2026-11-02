-- =============================================================================
-- Rollback 507 — drop the webhook_events 'no_match' status (BIL-32)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

UPDATE webhook_events SET status = 'failed' WHERE status = 'no_match';

ALTER TABLE webhook_events
    MODIFY COLUMN status ENUM('received', 'processing', 'processed', 'failed', 'ignored')
        NOT NULL DEFAULT 'received' COMMENT 'Processing status';
