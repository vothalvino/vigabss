---
name: credit-note-draft-ledger-write
description: POST /credit-notes writes a client_balance_ledger credit at create for ANY status (drafts included), so re-totaling a draft header from items needs a ledger decision first
metadata:
  type: project
---

As of 2026-10-29, `POST /credit-notes` (src/routes/creditNotes.js) inserts a `client_balance_ledger` 'credit' row whenever `client_id && total`, regardless of `status` (which defaults to 'draft'). No issue/apply transition writes the ledger; it is only written at create. The headline balance (`clientBalanceService.computeClientBalance`) excludes drafts, but the ledger-based readers do NOT: `GET /clients/:id/balance-ledger` meta.balance, GraphQL `Client.ledger`, and the statement PDF opening/running balance.

**Why:** a follow-up asked to re-total the draft header from `POST /credit-notes/:id/items`; it was stopped because the header total would diverge from the create-time ledger credit (or a total-0 draft would never get one).

**How to apply:** before touching credit-note totals, decide (product call) whether ledger rows move to issue time or get a compensating adjustment. Re-verify the route still writes at create. Related: [[balance-computed-currency-org]].
