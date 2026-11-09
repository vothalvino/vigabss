// =============================================================================
// In-memory answers to the SQL of services/resellerCommissionService.js and
// the reseller ledger writes it shares with resellerLedgerService.js
// (reseller program, phase 4).
// =============================================================================
// handleCommissionSql(state, sql, params) returns a mysql2-shaped result, or
// undefined when the statement is not one of these. `state` holds:
//   invoices:    { id: { id, organization_id, client_id, invoice_number, status,
//                        subtotal, total, currency, paid_at, deleted_at } }
//   clients:     { id: { id, organization_id, reseller_id } }
//   resellers:   { id: { id, organization_id, parent_id, commission_rate, deleted_at } }
//   commissions: [{ id, organization_id, reseller_id, invoice_id, client_id, commission_rate,
//                   base_amount, invoice_total, commission_amount, currency, status,
//                   earned_at, reversed_at }]
//   ledger:      [{ id, organization_id, reseller_id, entry_type, amount, ... }]
//   orgCurrency, commissionsSince (the go-live setting, or null),
//   orgCreatedAt (organizations.created_at, the go-live point without it)
//   seq:         { commission, ledger }
// Amounts are stored as mysql2 does: DECIMAL strings. The UNIQUE key
// (reseller_id, invoice_id) raises ER_DUP_ENTRY like InnoDB.
// =============================================================================
'use strict';

const cents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const NON_CASH = ['commission', 'commission_reversal', 'payout', 'collection_fee', 'collection_fee_reversal'];

function dup(message) {
  const err = new Error(`Duplicate entry '${message}' for key 'uq_reseller_commissions'`);
  err.code = 'ER_DUP_ENTRY';
  err.errno = 1062;
  return err;
}

function handleCommissionSql(state, sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ');
  if (!state.commissions) state.commissions = [];
  if (!state.seq.commission) state.seq.commission = 0;
  if (!state.seq.ledger) state.seq.ledger = 0;

  // --- the invoice, locked (and its organization)
  if (/FROM invoices WHERE id = \? AND organization_id = \? FOR UPDATE/.test(s) && /paid_at, deleted_at/.test(s)) {
    const inv = state.invoices[Number(params[0])];
    return [inv && inv.organization_id === Number(params[1]) ? [{ ...inv }] : []];
  }
  if (/SELECT organization_id FROM invoices WHERE id = \?$/.test(s.trim())) {
    const inv = state.invoices[Number(params[0])];
    return [inv ? [{ organization_id: inv.organization_id }] : []];
  }
  // --- the organization currency and the go-live setting
  if (/FROM organizations o LEFT JOIN organization_settings s/.test(s)) {
    return [[{
      currency: state.orgCurrency || 'MXN', created_at: state.orgCreatedAt ?? null, commissions_since: state.commissionsSince ?? null,
    }]];
  }
  // --- who owns the client
  if (/SELECT reseller_id FROM clients WHERE id = \? AND organization_id = \?/.test(s)) {
    const c = state.clients[Number(params[0])];
    return [c && c.organization_id === Number(params[1]) ? [{ reseller_id: c.reseller_id ?? null }] : []];
  }

  // --- the reseller chain (plain reads, the share lock and lockReseller)
  if (/FROM resellers WHERE id = \? AND organization_id = \? AND deleted_at IS NULL/.test(s)) {
    const r = state.resellers[Number(params[0])];
    return [r && r.organization_id === Number(params[1]) && !r.deleted_at ? [{ ...r }] : []];
  }

  // --- commission rows
  if (/^SELECT id, reseller_id FROM reseller_commissions WHERE organization_id = \? AND invoice_id = \?$/.test(s.trim())) {
    const [org, invoiceId] = params.map(Number);
    return [state.commissions.filter((c) => c.organization_id === org && c.invoice_id === invoiceId)
      .map((c) => ({ id: c.id, reseller_id: c.reseller_id }))];
  }
  // the current read of an un-paid invoice's rows (lockRowsToReverse)
  if (/FROM reseller_commissions WHERE organization_id = \? AND invoice_id = \? ORDER BY id FOR UPDATE/.test(s)) {
    const [org, invoiceId] = params.map(Number);
    return [state.commissions.filter((c) => c.organization_id === org && c.invoice_id === invoiceId).map((c) => ({ ...c }))];
  }
  // the share lock of the resellers a reversal may book to
  if (/^(\/\*.*?\*\/ )?SELECT id FROM resellers WHERE organization_id = \? AND id IN \(.*\) ORDER BY id LOCK IN SHARE MODE/.test(s.trim())) {
    const org = Number(params[0]);
    const ids = params.slice(1).map(Number);
    return [ids.map((rid) => state.resellers[rid]).filter((r) => r && r.organization_id === org).map((r) => ({ id: r.id }))];
  }
  if (/FROM reseller_commissions WHERE organization_id = \? AND id IN \(.*\) FOR UPDATE/.test(s)) {
    const org = Number(params[0]);
    const ids = params.slice(1).map(Number);
    return [state.commissions.filter((c) => c.organization_id === org && ids.includes(c.id)).map((c) => ({ ...c }))];
  }
  if (/FROM reseller_commissions WHERE organization_id = \? AND reseller_id = \? AND invoice_id = \? FOR UPDATE/.test(s)) {
    const [org, rid, invoiceId] = params.map(Number);
    return [state.commissions.filter((c) => c.organization_id === org && c.reseller_id === rid && c.invoice_id === invoiceId).map((c) => ({ ...c }))];
  }
  if (/^INSERT INTO reseller_commissions/.test(s.trim())) {
    const [org, rid, invoiceId, clientId, rate, base, total, amount, currency] = params;
    if (state.commissions.some((c) => c.reseller_id === Number(rid) && c.invoice_id === Number(invoiceId))) {
      throw dup(`${rid}-${invoiceId}`);
    }
    const id = ++state.seq.commission;
    state.commissions.push({
      id, organization_id: Number(org), reseller_id: Number(rid), invoice_id: Number(invoiceId), client_id: Number(clientId),
      commission_rate: Number(rate).toFixed(2), base_amount: Number(base).toFixed(2), invoice_total: Number(total).toFixed(2),
      commission_amount: Number(amount).toFixed(2), currency, status: 'earned', earned_at: new Date(), reversed_at: null,
      created_at: new Date(),
    });
    return [{ insertId: id, affectedRows: 1 }];
  }
  if (/^UPDATE reseller_commissions SET status = 'reversed', reversed_at = NOW\(\) WHERE id = \? AND organization_id = \? AND reversed_at IS NULL/.test(s.trim())) {
    const c = state.commissions.find((x) => x.id === Number(params[0]) && x.organization_id === Number(params[1]) && x.reversed_at === null);
    if (c) { c.status = 'reversed'; c.reversed_at = new Date(); }
    return [{ affectedRows: c ? 1 : 0 }];
  }
  if (/^UPDATE reseller_commissions SET status = 'earned', reversed_at = NULL/.test(s.trim())) {
    const [clientId, rate, base, total, amount, currency, id, org] = params;
    const c = state.commissions.find((x) => x.id === Number(id) && x.organization_id === Number(org) && x.reversed_at !== null);
    if (c) {
      Object.assign(c, {
        status: 'earned', reversed_at: null, earned_at: new Date(), client_id: Number(clientId),
        commission_rate: Number(rate).toFixed(2), base_amount: Number(base).toFixed(2), invoice_total: Number(total).toFixed(2),
        commission_amount: Number(amount).toFixed(2), currency,
      });
    }
    return [{ affectedRows: c ? 1 : 0 }];
  }
  if (/SUM\(commission_amount\), 0\) AS total FROM reseller_commissions WHERE organization_id = \? AND reseller_id = \?/.test(s)) {
    const [org, rid] = params.map(Number);
    const since = params[2] instanceof Date ? params[2].getTime() : 0;
    const total = state.commissions
      .filter((c) => c.organization_id === org && c.reseller_id === rid && c.reversed_at === null && c.earned_at && c.earned_at.getTime() >= since)
      .reduce((t, c) => t + cents(c.commission_amount), 0);
    return [[{ total: fromCents(total) }]];
  }

  // --- the reseller ledger
  if (/^INSERT INTO reseller_ledger_entries/.test(s.trim())) {
    const [orgId, resellerId, entryType, amount, currency, paymentId, cashSessionId, note, createdBy, cashBagId, invoiceId, commissionId] = params;
    const id = ++state.seq.ledger;
    state.ledger.push({
      id, organization_id: orgId, reseller_id: Number(resellerId), entry_type: entryType, amount: Number(amount).toFixed(2), currency,
      payment_id: paymentId ?? null, cash_session_id: cashSessionId ?? null, cash_bag_id: cashBagId ?? null, note,
      created_by: createdBy ?? null, created_at: new Date(), invoice_id: invoiceId ?? null, commission_id: commissionId ?? null,
    });
    return [{ insertId: id, affectedRows: 1 }];
  }
  if (/AS cash_held FROM reseller_ledger_entries/.test(s)) {
    const rid = Number(params[1]);
    const total = state.ledger.filter((e) => e.reseller_id === rid && !NON_CASH.includes(e.entry_type))
      .reduce((t, e) => t + cents(e.amount), 0);
    return [[{ cash_held: fromCents(total) }]];
  }
  if (/SELECT id, invoice_number FROM invoices WHERE organization_id = \? AND id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [ids.map((id) => state.invoices[id]).filter(Boolean).map((i) => ({ id: i.id, invoice_number: i.invoice_number }))];
  }
  return undefined;
}

/** The sum of a reseller's ledger lines, in cents. */
function ledgerCents(state, resellerId) {
  return state.ledger.filter((e) => e.reseller_id === resellerId).reduce((t, e) => t + cents(e.amount), 0);
}

module.exports = { handleCommissionSql, ledgerCents };
