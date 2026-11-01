-- =============================================================================
-- Rollback 484: drop credit-note applications
-- =============================================================================
-- Credit notes stop reducing the invoices they credit; invoices a note had
-- settled keep their 'paid' status. Roll back the application code with this.
-- =============================================================================

DROP TABLE IF EXISTS credit_note_applications;
