-- =============================================================================
-- Rollback 520 — Per-organization credit note number sequence
-- =============================================================================
-- Drops the counter. Credit notes created without a number fail again until a
-- caller supplies one.
-- =============================================================================

DROP TABLE IF EXISTS organization_credit_note_sequences;
