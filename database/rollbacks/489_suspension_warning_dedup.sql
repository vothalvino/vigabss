-- =============================================================================
-- Rollback 489: forget sent suspension warnings
-- =============================================================================
-- Drops the warning log, so warnings are sent on every run again. The legacy
-- auto_generate_invoices and auto_suspend_overdue rows stay disabled:
-- re-enabling them would run invoicing and suspension twice a day. Enable
-- them by hand only where billing_cycle is disabled.
-- =============================================================================

DROP TABLE IF EXISTS suspension_warning_logs;
