-- =============================================================================
-- Migration 470 — attribute NULL-organization payments to their client's org
-- =============================================================================
-- TNA-10: the payment CSV import (POST /import/payments[/upload]) inserted
-- payments with no organization_id. Every org-scoped list, the computed client
-- balance and the subscriber portal (organization_id <=> client's org) never
-- saw them, although the import reported them as imported. The importer now
-- writes the caller's org (src/controllers/importController.js).
--
-- This repair attributes each such live row to its client's organization when
-- that client HAS one. A single-tenant install whose clients also carry a NULL
-- organization_id is left untouched (NULL there is the legitimate value), so
-- the statement is a no-op on those installs and rerun-safe everywhere.
--
-- Not repaired here, deliberately:
--   * currency: the import let these rows fall to the column default 'USD';
--     a genuine USD payment cannot be told apart from a defaulted one, so an
--     operator must review them (SELECT ... WHERE currency = 'USD').
--   * the client_balance_ledger credit the import never wrote: the headline
--     balance is computed from payments, not the ledger, so it is already
--     correct once the row carries its org.
-- Data-only: no DDL, so no schema.sql change.
-- =============================================================================

UPDATE payments p
JOIN clients c ON c.id = p.client_id
   SET p.organization_id = c.organization_id
 WHERE p.organization_id IS NULL
   AND c.organization_id IS NOT NULL
   AND p.deleted_at IS NULL;
