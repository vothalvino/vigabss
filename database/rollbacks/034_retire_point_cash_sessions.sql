-- Rollback 034 — brings back the closed reseller-app cash sessions the
-- migration retired. The ones still open were retired by migration 032 and
-- stay retired here.

UPDATE cash_reconciliation_sessions
   SET deleted_at = NULL
 WHERE deleted_at IS NOT NULL
   AND status <> 'open'
   AND notes = 'Opened by the reseller app';
