-- =============================================================================
-- Rollback 475: drop reseller user bindings
-- =============================================================================
-- The bindings are dropped and cannot be restored by a later re-apply; record
-- them first if they must be re-created. Older application versions do not
-- confine reseller users at all, so after a downgrade every reseller_admin
-- regains cross-reseller access within its organization (the pre-475
-- behavior audit TNB-13 describes).
-- =============================================================================

DROP TABLE IF EXISTS reseller_user_bindings;
