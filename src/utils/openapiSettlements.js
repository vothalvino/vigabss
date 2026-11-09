// =============================================================================
// OpenAPI paths and schemas of the reseller program, phase 5 (migration 008):
// statements (estados de cuenta), settlement and the commission gap sweep.
// Merged into the spec by src/utils/openapi.js; routes in
// src/routes/resellers.js and src/routes/resellerAppStatements.js.
// =============================================================================

const STATEMENT_STATUSES = ['draft', 'approved', 'settled', 'void'];
const ENTRY_TYPES = ['collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout', 'collection_fee', 'collection_fee_reversal'];

const nullableString = (format) => (format ? { type: ['string', 'null'], format } : { type: ['string', 'null'] });
const nullableInteger = () => ({ type: ['integer', 'null'] });

function obj(properties, required = Object.keys(properties)) {
  return { type: 'object', required, properties };
}
function ok(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}
function err(description) {
  return {
    description,
    content: { 'application/json': { schema: obj({
      error: obj({
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      }, ['code', 'message']),
    }) } },
  };
}
function body(schema, description, required = true) {
  return { description, required, content: { 'application/json': { schema } } };
}
const pdf = () => ({ description: 'The statement as PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } });
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'integer' } });
const pageParam = () => ({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } });
const limitParam = () => ({ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } });
const security = [{ bearerAuth: [] }];
const ymd = () => ({ type: 'string', format: 'date' });
const period = () => obj({ period_start: ymd(), period_end: ymd() });

function statementSchema() {
  return obj({
    id: { type: 'integer' },
    reseller_id: { type: 'integer' },
    reseller_name: nullableString(),
    period_start: { ...ymd(), description: 'First business day (organization time zone)' },
    period_end: { ...ymd(), description: 'Last business day, inclusive' },
    currency: { type: 'string' },
    opening_balance: { type: 'number', description: 'SUM of the ledger before the period' },
    totals: obj(Object.fromEntries(ENTRY_TYPES.map((t) => [t, { type: 'number' }]))),
    closing_balance: { type: 'number', description: 'opening_balance + every total; positive: the reseller owes the ISP, negative: the ISP owes the reseller' },
    entry_count: { type: 'integer' },
    sweep_earned: { type: 'integer', description: 'Missing commissions the gap sweep booked (or restored) before it was generated' },
    sweep_reversed: { type: 'integer', description: 'Stale commissions the gap sweep reversed before it was generated' },
    status: { type: 'string', enum: STATEMENT_STATUSES },
    generated_by: nullableInteger(),
    generated_at: nullableString('date-time'),
    approved_by: nullableInteger(),
    approved_at: nullableString('date-time'),
    settled_by: nullableInteger(),
    settled_at: nullableString('date-time'),
    bank_ref: nullableString(),
    settlement_entry_id: { type: ['integer', 'null'], description: 'The deposit or payout line settling posted' },
    voided_at: nullableString('date-time'),
    notes: nullableString(),
  });
}

function sweepSchema() {
  return obj({
    earned: { type: 'integer' },
    restored: { type: 'integer' },
    reversed: { type: 'integer' },
    unchanged: { type: 'integer', description: 'Candidates that earn nothing by the rules (another currency, a rate of 0)' },
    failed: { type: 'integer' },
    truncated: { type: 'boolean', description: 'More candidates than one sweep reconciles; run it again' },
  });
}

function listOf(item, extraMeta = {}) {
  return obj({
    data: { type: 'array', items: item },
    meta: obj({ total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, ...extraMeta }),
  });
}

/**
 * The phase 5 paths. `ledgerEntrySchema(staff)` and `ledgerSummarySchema(staff)`
 * are the reseller ledger schemas of src/utils/openapi.js.
 */
function settlementPaths({ ledgerEntrySchema, ledgerSummarySchema }) {
  const withLines = (staff) => obj({
    data: statementSchema(),
    lines: { type: 'array', items: ledgerEntrySchema(staff), description: 'The period\'s ledger lines, oldest first' },
    meta: obj({ total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } }),
  });
  const staffOnly = err('Reseller-bound callers cannot use the statement administration');
  const sidParams = [idParam(), idParam('sid')];
  const draftOnly = err('SETTLEMENT_NOT_DRAFT: only a draft');
  return {
    '/resellers/{id}/settlements': {
      get: { tags: ['Resellers'], summary: "A top-level reseller's statements (estados de cuenta), newest period first; meta.default_period is the previous business month. Org-level staff with reseller_settlements.view", operationId: 'listResellerSettlements', security, parameters: [idParam(), { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: STATEMENT_STATUSES } }, pageParam(), limitParam()], responses: { 200: ok('Statements', listOf(statementSchema(), { default_period: period() })), 403: staffOnly, 404: err('Reseller not found'), 422: err('Unknown status') } },
      post: { tags: ['Resellers'], summary: 'Generate a draft statement of a closed period (default: the previous business month). The commission gap sweep runs first; the figures are rebuilt from the ledger. Org-level staff with reseller_settlements.manage', operationId: 'generateResellerSettlement', security, parameters: [idParam()], requestBody: body({ type: 'object', properties: { period_start: ymd(), period_end: ymd(), notes: { type: 'string', maxLength: 500 } } }, 'The period (both or neither)', false), responses: { 201: ok('Draft statement and the sweep result', obj({ data: statementSchema(), sweep: sweepSchema() })), 403: staffOnly, 404: err('Reseller not found'), 409: err('SETTLEMENT_PERIOD_OVERLAP: another statement of the reseller covers part of the period'), 422: err('NOT_TOP_LEVEL, PERIOD_INVALID, PERIOD_NOT_ENDED, PERIOD_TOO_LONG or a malformed date') } },
    },
    '/resellers/{id}/settlements/{sid}': {
      get: { tags: ['Resellers'], summary: 'One statement and a page of the ledger lines of its period', operationId: 'getResellerSettlement', security, parameters: [...sidParams, pageParam(), limitParam()], responses: { 200: ok('Statement', withLines(true)), 403: staffOnly, 404: err('Statement not found') } },
    },
    '/resellers/{id}/settlements/{sid}/pdf': {
      get: { tags: ['Resellers'], summary: 'The statement as PDF', operationId: 'getResellerSettlementPdf', security, parameters: sidParams, responses: { 200: pdf(), 403: staffOnly, 404: err('Statement not found') } },
    },
    '/resellers/{id}/settlements/{sid}/regenerate': {
      post: { tags: ['Resellers'], summary: 'Run the gap sweep and recompute a draft. reseller_settlements.manage', operationId: 'regenerateResellerSettlement', security, parameters: sidParams, responses: { 200: ok('Draft statement and the sweep result', obj({ data: statementSchema(), sweep: sweepSchema() })), 403: staffOnly, 404: err('Statement not found'), 409: draftOnly } },
    },
    '/resellers/{id}/settlements/{sid}/discard': {
      post: { tags: ['Resellers'], summary: 'Discard a draft (status void, kept for the audit trail); its period is free again. reseller_settlements.manage', operationId: 'discardResellerSettlement', security, parameters: sidParams, responses: { 200: ok('Discarded statement', obj({ data: statementSchema() })), 403: staffOnly, 404: err('Statement not found'), 409: draftOnly } },
    },
    '/resellers/{id}/settlements/{sid}/approve': {
      post: { tags: ['Resellers'], summary: 'Approve a draft: recompute it from the ledger and freeze it (recomputed: the figures differed from the draft). reseller_settlements.approve', operationId: 'approveResellerSettlement', security, parameters: sidParams, responses: { 200: ok('Approved statement', obj({ data: statementSchema(), recomputed: { type: 'boolean' } })), 403: staffOnly, 404: err('Statement not found'), 409: draftOnly } },
    },
    '/resellers/{id}/settlements/{sid}/settle': {
      post: { tags: ['Resellers'], summary: 'Settle an approved statement with a bank reference: a deposit line of the closing balance when the reseller owed the ISP, a payout line when the ISP owed it, nothing at 0. The deposit and payout caps hold against the current balance (SETTLEMENT_EXCEEDS_BALANCE when that money already moved); record_only marks it settled without a line. reseller_settlements.manage', operationId: 'settleResellerSettlement', security, parameters: sidParams, requestBody: body(obj({ bank_ref: { type: 'string', minLength: 1, maxLength: 100 }, record_only: { type: 'boolean' } }, ['bank_ref']), 'The settlement'), responses: { 200: ok('Settled statement', obj({ data: statementSchema(), entry_id: nullableInteger(), summary: ledgerSummarySchema(true) })), 403: staffOnly, 404: err('Statement not found'), 409: err('SETTLEMENT_NOT_APPROVED or SETTLEMENT_EXCEEDS_BALANCE'), 422: err('bank_ref is missing') } },
    },
    '/resellers/{id}/commissions/sweep': {
      post: { tags: ['Resellers'], summary: 'The commission gap sweep of a top-level reseller: books the commission of a paid invoice of its subtree that has none (paid at or after the go-live point) and reverses a standing commission whose invoice is no longer paid, each in its own transaction. reseller_settlements.manage', operationId: 'sweepResellerCommissions', security, parameters: [idParam()], responses: { 200: ok('Sweep result', obj({ data: sweepSchema() })), 403: staffOnly, 404: err('Reseller not found'), 422: err('A sub-reseller: sweep its parent') } },
    },
    '/reseller-app/statements': {
      get: { tags: ['Reseller App'], summary: "The collecting (top-level) reseller's approved and settled statements, newest first. Needs reseller_app.statements", operationId: 'listResellerAppStatements', security, parameters: [pageParam(), limitParam()], responses: { 200: ok('Statements', listOf(statementSchema())), 403: err('Not a reseller account, or no reseller_app.statements') } },
    },
    '/reseller-app/statements/{sid}': {
      get: { tags: ['Reseller App'], summary: 'One approved or settled statement of the reseller and a page of its lines', operationId: 'getResellerAppStatement', security, parameters: [idParam('sid'), pageParam(), limitParam()], responses: { 200: ok('Statement', withLines(false)), 403: err('Not a reseller account, or no reseller_app.statements'), 404: err('Not an approved statement of this reseller') } },
    },
    '/reseller-app/statements/{sid}/pdf': {
      get: { tags: ['Reseller App'], summary: 'One approved or settled statement of the reseller as PDF', operationId: 'getResellerAppStatementPdf', security, parameters: [idParam('sid')], responses: { 200: pdf(), 403: err('Not a reseller account, or no reseller_app.statements'), 404: err('Not an approved statement of this reseller') } },
    },
  };
}

module.exports = { settlementPaths, STATEMENT_STATUSES };
