---
name: credit-note-draft-ledger-write
description: Credit notes post their client_balance_ledger credit on ISSUE (migration 465), not on draft creation; refund-path notes have no ledger row by design-or-omission
metadata:
  type: project
---

User decision (2026-10-29): a credit note posts to `client_balance_ledger` only when issued. Implemented in migration 465 + `src/routes/creditNotes.js`: drafts post nothing; PUT draft -> issued/applied posts the final total (net-aware, inside the crudController row lock via `transactionalAfterHooks`); posted -> draft and leaving `cancelled` are 422 `CREDIT_NOTE_STATUS_TRANSITION`; item add moves the draft header by delta (`billingService.applyCreditNoteLineItemToTotals`). Migration 465 appended compensating debits for drafts that had create-time credits.

**Why:** the ledger running balance (Ledger tab, `/clients/:id/balance-ledger`, statement PDF) disagreed with `clientBalanceService`, which never counts drafts.

**How to apply:** known gaps left open on purpose. Cancelling or soft-deleting a posted note writes no reversal. Editing an issued note's total does not adjust the ledger. Refund-path `credit_note` notes (`refundRequestService`) are inserted 'issued' with NO ledger row (only billing_adjustments). Don't "fix" any of these without a product decision. Related: [[balance-computed-currency-org]].
