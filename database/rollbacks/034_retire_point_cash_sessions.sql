-- Rollback 034 — nothing to undo in the schema. The sessions the migration
-- retired stay retired: the reseller app no longer has cash sessions, and
-- which rows it retired is not recorded.

SELECT 1;
