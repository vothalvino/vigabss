---
name: credit-note-draft-ledger-write
description: Credit-note ledger invariant (migrations 465+466) — net credit == total while issued/applied, 0 when draft/cancelled/soft-deleted; one shared sync helper on every write path
metadata:
  type: project
---

User decision (2026-10-29): a credit note posts to `client_balance_ledger` only when issued. Migration 465 + PR #9 did issue-time posting; migration 466 (2026-10-29, follow-up) closed the remaining gaps so ONE invariant holds: net ledger credit == total while issued/applied and not soft-deleted, == 0 while draft/cancelled/soft-deleted.

Owner: `src/services/creditNoteLedgerService.js` (`syncCreditNoteLedger`, net-aware, appends one credit/debit for the difference). Called from `src/routes/creditNotes.js` afterUpdate (issue, cancel, total delta, client re-point reverses old client), beforeDelete (reversal), afterRestore (re-post), POST create, and `refundRequestService` credit_note branch (now one transaction with the note insert). Cancel of a note with a live CFDI is 422 CFDI_STAMPED (same guard as delete).

Choice: total change on an issued note ADJUSTS by delta rather than blocking, because issued invoices are not immutable in this codebase (only live-CFDI/void/cancelled are frozen) and the CFDI guard already freezes stamped notes.

**Why:** the ledger running balance (Ledger tab, `/clients/:id/balance-ledger`, statement PDF) must agree with `clientBalanceService`, which counts exactly issued/applied, non-deleted notes. `billing_adjustments` feeds NO balance (audit only), so posting refund-path notes is not a double-count.

**How to apply:** any new credit-note write path must call `syncCreditNoteLedger` on the same transaction/row lock. Open, not fixed: `PUT /credit-notes/:id` accepts an unverified `client_id` (no org FK check; undeclared in updateCreditNote schema but fillable). Related: [[balance-computed-currency-org]].
