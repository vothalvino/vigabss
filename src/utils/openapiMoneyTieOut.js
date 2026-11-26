// =============================================================================
// OpenAPI paths of the money tie-out (migration 037): the month's collections
// tied to the bank, the organization's bank accounts and the safe.
// Merged into the spec by src/utils/openapi.js; routes in
// src/routes/moneyTieOut.js.
// =============================================================================

const PURPOSES = ['client_invoices', 'general_public', 'any'];
const KINDS = ['count', 'deposit', 'other_in', 'other_out'];

const num = () => ({ type: 'number' });
const nullableNum = () => ({ type: ['number', 'null'] });
const nullableString = () => ({ type: ['string', 'null'] });
const obj = (properties) => ({ type: 'object', properties });
const ok = (description, schema) => ({ description, content: { 'application/json': { schema: obj({ data: schema }) } } });
const err = (description) => ({
  description,
  content: { 'application/json': { schema: obj({ error: obj({ code: { type: 'string' }, message: { type: 'string' } }) }) } },
});
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const security = [{ bearerAuth: [] }];
const tags = ['Money Tie-out'];
const idParam = () => ({ name: 'id', in: 'path', required: true, schema: { type: 'integer' } });
const monthParams = () => [
  { name: 'year', in: 'query', required: false, schema: { type: 'integer' }, description: 'Defaults to the current year' },
  { name: 'month', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 12 }, description: 'Defaults to the current month' },
];

const transit = () => obj({
  at_points: num(), owed_to_points: num(), in_bags: num(), in_drawers: num(),
  in_safe: { ...nullableNum(), description: 'Null until the safe has been counted once' },
  total: num(), position: num(),
});
const split = () => ({
  client_cfdi: num(), general_public_stamped: num(), general_public_pending: num(),
  unpaid_no_cfdi: num(), credit: num(), general_public: num(),
});
const bankAccount = () => obj({
  id: { type: 'integer' }, name: { type: 'string' }, bank_name: nullableString(), account_hint: nullableString(),
  purpose: { type: 'string', enum: PURPOSES }, status: { type: 'string', enum: ['active', 'inactive'] },
});
const safeMovement = () => obj({
  id: { type: 'integer' }, kind: { type: 'string', enum: KINDS }, amount: num(),
  expected_amount: { ...nullableNum(), description: 'A count only: what the safe should have held' },
  bank_account_id: { type: ['integer', 'null'] }, bank_account_name: nullableString(),
  moved_at: { type: 'string', format: 'date-time' }, reference: nullableString(), note: nullableString(),
  created_by: { type: ['integer', 'null'] }, created_by_name: nullableString(),
  in_safe: { ...nullableNum(), description: 'On the response of a new movement: what the safe holds after it' },
});

const report = () => obj({
  period: obj({
    year: { type: 'integer' }, month: { type: 'integer' }, from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date', description: 'Exclusive' }, cutoff: { type: 'string', format: 'date-time' },
    closed: { type: 'boolean' }, today: { type: 'string', format: 'date' },
  }),
  collected: obj({
    count: { type: 'integer' }, total: num(), cash: num(), cash_staff: num(), cash_points: num(), non_cash: num(),
    by_method: { type: 'array', items: obj({ method: { type: 'string' }, total: num() }) },
  }),
  fiscal: obj({ ...split(), cash: obj(split()) }),
  cash: obj({
    tracked: { type: 'boolean' },
    tracking_since: { type: ['string', 'null'], format: 'date-time', description: 'The first safe count' },
    started_in_month: { type: 'boolean', description: 'Tracking began during this month, so its cash cannot add up' },
    recorded: num(), in_transit_start: transit(), in_transit_end: transit(),
    deposited: num(), commissions_kept: num(), other_out: num(), other_in: num(),
    reached_safe: obj({ pickups: num(), bags: num(), handed_in: num() }),
    differences: {
      type: ['object', 'null'],
      description: 'Positive = more cash than the records expected. Null until the safe has been counted once',
      properties: {
        total: num(), cashier_counts: num(), bag_counts: num(), safe_counts: num(),
        point_adjustments: num(), point_payouts: num(), unexplained: num(),
      },
    },
  }),
  bank: obj({
    deposited: num(), cash_for_client_invoices: num(), cash_for_general_public: num(),
    for_client_invoices: num(), for_general_public: num(),
    in_client_invoice_accounts: num(), in_general_public_accounts: num(), in_other_accounts: num(),
    direct_unassigned: { ...num(), description: 'Paid by transfer, card or check with no bank account named' },
    accounts: {
      type: 'array',
      items: obj({
        ...bankAccount().properties, deposits: { type: 'integer' }, deposited: num(),
        payments: { type: 'integer', description: 'Non-cash payments of the month that name this account' }, received: num(),
      }),
    },
  }),
  attention: {
    type: 'array',
    items: obj({
      kind: { type: 'string', enum: ['bag_waiting', 'pickup_unconfirmed', 'safe_waiting', 'safe_not_counted'] },
      amount: num(), days: { type: 'integer' }, serial: { type: 'string' }, point_name: nullableString(),
      status: { type: 'string' }, bag_id: { type: 'integer' }, pickup_id: { type: 'integer' }, session_id: { type: 'integer' },
    }),
  },
  resico: obj({
    applies: { type: 'boolean' }, year: { type: 'integer' }, income: num(), limit: num(), percent: num(),
  }),
});

function moneyTieOutPaths() {
  return {
    '/money-tieout': {
      get: {
        tags, security, operationId: 'getMoneyTieOut', parameters: monthParams(),
        summary: "A month's collections tied to the bank: what was collected and how it is invoiced, where the cash is (points, bags, drawers, the safe, the bank), and whether the month's cash adds up. Needs cash_reconciliation.approve",
        responses: { 200: ok('The tie-out', report()), 422: err('A year or month out of range, or a month that has not started') },
      },
    },
    '/money-tieout/bank-accounts': {
      get: {
        tags, security, operationId: 'listBankAccounts', summary: "The organization's bank accounts. Needs cash_reconciliation.approve",
        responses: { 200: ok('Bank accounts', { type: 'array', items: bankAccount() }) },
      },
      post: {
        tags, security, operationId: 'createBankAccount',
        summary: 'Add a bank account and say what it is for: money invoiced to a client RFC, money invoiced to General Public, or any',
        requestBody: body({
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 100 }, bank_name: { type: 'string', maxLength: 100 },
            account_hint: { type: 'string', maxLength: 20, description: 'Last digits or another short hint; never the account number' },
            purpose: { type: 'string', enum: PURPOSES },
          },
        }),
        responses: { 201: ok('The bank account', bankAccount()), 422: err('Invalid values') },
      },
    },
    '/money-tieout/bank-accounts/{id}': {
      put: {
        tags, security, operationId: 'updateBankAccount', parameters: [idParam()],
        summary: 'Rename a bank account, change what it is for, or make it inactive',
        requestBody: body({
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 }, bank_name: { type: 'string', maxLength: 100 },
            account_hint: { type: 'string', maxLength: 20 }, purpose: { type: 'string', enum: PURPOSES },
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
        }),
        responses: { 200: ok('The bank account', bankAccount()), 404: err('Not found') },
      },
    },
    '/money-tieout/safe-movements': {
      get: {
        tags, security, operationId: 'listSafeMovements', parameters: monthParams(),
        summary: "The safe's movements of a month, newest first: counts, bank deposits and other cash in or out",
        responses: { 200: ok('Safe movements', { type: 'array', items: safeMovement() }) },
      },
      post: {
        tags, security, operationId: 'recordSafeMovement',
        summary: 'Record a safe movement. A count states what is in the safe and keeps the difference with what it should have held; the safe is tracked from its first count. A deposit names an active bank account. Nothing but a count may take out more than the safe holds (422 SAFE_INSUFFICIENT)',
        requestBody: body({
          type: 'object', required: ['kind', 'amount'],
          properties: {
            kind: { type: 'string', enum: KINDS }, amount: { type: 'number', minimum: 0 },
            bank_account_id: { type: 'integer', description: 'Required for a deposit' },
            moved_at: { type: 'string', format: 'date-time', description: 'Defaults to now; not in the future' },
            reference: { type: 'string', maxLength: 100 }, note: { type: 'string', maxLength: 500 },
          },
        }),
        responses: { 201: ok('The movement', safeMovement()), 404: err('Bank account not found'), 422: err('SAFE_NOT_COUNTED, SAFE_INSUFFICIENT, BANK_ACCOUNT_INACTIVE or invalid values') },
      },
    },
    '/money-tieout/safe-movements/{id}': {
      delete: {
        tags, security, operationId: 'removeSafeMovement', parameters: [idParam()],
        summary: 'Remove a safe movement recorded by mistake. The first count cannot be removed while other movements rest on it (409 SAFE_COUNT_IN_USE)',
        responses: { 200: ok('What was removed', obj({ id: { type: 'integer' }, kind: { type: 'string', enum: KINDS }, amount: num() })), 404: err('Not found'), 409: err('SAFE_COUNT_IN_USE') },
      },
    },
  };
}

module.exports = { moneyTieOutPaths };
