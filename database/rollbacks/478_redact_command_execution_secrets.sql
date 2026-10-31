-- =============================================================================
-- Rollback 478 — scrubbed command-history credentials cannot be restored
-- =============================================================================
-- Migration 478 changes no schema. It replaced stored PPPoE and connection
-- passwords in device_command_executions.params with '[REDACTED]'; the
-- original values were not kept anywhere, by design. Nothing to revert.

SELECT 1 AS command_history_redaction_preserved;
