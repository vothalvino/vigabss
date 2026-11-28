-- Rollback 043 — drops the per-person cash limits. Everyone follows the
-- organization's setting again.

DROP TABLE IF EXISTS cashier_user_limits;
