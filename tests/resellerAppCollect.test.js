// =============================================================================
// Reseller app, phase 2 (migration 004): a Punto de Venta collects cash
// =============================================================================
// A bound reseller user collects cash from any subscriber of the ISP within a
// credit limit, voids a same-day collection, prints a receipt and closes its
// cash box; org-level staff record the cash it hands in. The database is an
// in-memory fake with transaction snapshots, so a rollback really discards
// what the transaction wrote.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((_orgId, fn) => fn()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));
jest.mock('../src/services/businessEvents', () => ({
  emitPaymentReceived: jest.fn(),
  emitContractSuspended: jest.fn(),
  emitContractRestored: jest.fn(),
  emitSuspensionWarning: jest.fn(),
  emitTicketCreated: jest.fn(),
  emitMaintenanceScheduled: jest.fn(),
}));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const { handleCashBagSql } = require('./helpers/cashBagFakeDb');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const auditLog = require('../src/services/auditLog');
const repService = require('../src/services/repService');
const paymentAllocationService = require('../src/services/paymentAllocationService');
const { signCollectToken, verifyCollectToken } = require('../src/utils/collectToken');
const { maskName, parseLookupQuery } = require('../src/services/resellerCollectionService');
const { businessToday } = require('../src/utils/businessDate');
const app = require('../src/app');

const ORG = 1;
const USER = 7;
const COLLEAGUE = 8;

// ---------------------------------------------------------------------------
// In-memory organization
// ---------------------------------------------------------------------------
let state;
let snapshot;
let binding;
let groupName;
let failAllocation;
let stampedRep;

function freshState() {
  return {
    resellers: {
      // R1 (master) has sub-reseller R3; R2 is another master.
      1: { id: 1, organization_id: ORG, parent_id: null, level: 1, name: 'Tienda Lupita', status: 'active', commission_rate: '10.00', credit_limit: null },
      2: { id: 2, organization_id: ORG, parent_id: null, level: 1, name: 'Papelería Sol', status: 'active', commission_rate: '5.00', credit_limit: null },
      3: { id: 3, organization_id: ORG, parent_id: 1, level: 2, name: 'Lupita Norte', status: 'active', commission_rate: '0.00', credit_limit: null },
    },
    setting: null, // organization_settings.reseller_default_credit_limit
    clients: {
      31: { id: 31, organization_id: ORG, name: 'Ana Ruiz', phone: '722-555-0001', email: 'ana@example.com', address: 'Calle 1', status: 'active', reseller_id: 3 },
      21: { id: 21, organization_id: ORG, name: 'María López', phone: '(722) 555 0002', email: 'maria@example.com', address: 'Calle 2', status: 'suspended', reseller_id: 2 },
      41: { id: 41, organization_id: ORG, name: 'José Pérez', phone: '+52 1 722 555 0003', email: null, address: 'Calle 3', status: 'active', reseller_id: null },
    },
    invoices: {
      801: { id: 801, organization_id: ORG, client_id: 21, contract_id: 61, invoice_number: 'F-801', status: 'overdue', total: '300.00', currency: 'MXN', issue_date: '2026-09-01', due_date: '2026-09-10' },
      802: { id: 802, organization_id: ORG, client_id: 21, contract_id: 61, invoice_number: 'F-802', status: 'issued', total: '300.00', currency: 'MXN', issue_date: '2026-10-01', due_date: '2026-10-10' },
      811: { id: 811, organization_id: ORG, client_id: 31, contract_id: 62, invoice_number: 'F-811', status: 'issued', total: '450.00', currency: 'MXN', issue_date: '2026-10-01', due_date: '2026-10-10' },
    },
    payments: [],
    allocations: [],
    ledger: [],
    sessions: [],
    idempotency: [],
    // Cash bags (phase 3, tests/helpers/cashBagFakeDb.js): empty bags of R1.
    bags: [],
    events: [],
    assignments: [],
    seq: { payment: 500, alloc: 900, ledger: 100, session: 40, bag: 700, event: 0 },
  };
}

const clone = (v) => structuredClone(v);
const cents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const digits = (s) => String(s || '').replace(/[\s\-().+]/g, '');

function allocatedOn(invoiceId) {
  return state.allocations.filter((a) => a.invoice_id === invoiceId && !a.deleted_at)
    .reduce((s, a) => s + cents(a.amount), 0);
}
function balanceOf(inv) { return Math.max(0, cents(inv.total) - allocatedOn(inv.id)); }
function ledgerSum(resellerId) {
  return state.ledger.filter((e) => e.reseller_id === resellerId).reduce((s, e) => s + cents(e.amount), 0);
}
const PAYABLE = ['issued', 'sent', 'overdue'];

function handle(sql, params = []) {
  const s = String(sql);
  const bagAnswer = handleCashBagSql(state, s, params);
  if (bagAnswer !== undefined) return bagAnswer;
  // --- identity, scope, organization
  if (/FROM reseller_user_bindings b/.test(s)) return [binding ? [binding] : []];
  if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) return [groupName ? [{ group_name: groupName }] : []];
  if (/FROM resellers\s+WHERE organization_id = \? AND parent_id IN/.test(s)) {
    const parents = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => parents.includes(r.parent_id)).map((r) => ({ id: r.id }))];
  }
  if (/SELECT currency FROM organizations/.test(s)) return [[{ currency: 'MXN' }]];
  if (/FROM organization_settings/.test(s)) return [state.setting === null ? [] : [{ setting_value: state.setting }]];
  // --- resellers
  if (/FROM resellers\s+WHERE id = \? AND organization_id = \?/.test(s) || /^SELECT \* FROM resellers WHERE id = \? AND organization_id = \?/.test(s)) {
    const r = state.resellers[Number(params[0])];
    return [r && Number(params[1]) === ORG ? [{ ...r }] : []];
  }
  if (/UPDATE resellers SET/.test(s)) {
    const id = Number(params[params.length - 2]);
    const r = state.resellers[id];
    if (r && /credit_limit = IF\(\?, \?, credit_limit\)/.test(s) && params[params.length - 4]) r.credit_limit = params[params.length - 3];
    return [{ affectedRows: r ? 1 : 0 }];
  }
  if (/INSERT INTO resellers/.test(s)) return [{ insertId: 4 }];
  if (/GROUP BY reseller_id/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [ids.map((id) => ({ reseller_id: id, balance: fromCents(ledgerSum(id)) }))];
  }
  // --- reseller ledger
  if (/SUM\(amount\), 0\) AS balance\s+FROM reseller_ledger_entries/.test(s)) {
    return [[{ balance: fromCents(ledgerSum(Number(params[1]))) }]];
  }
  if (/INSERT INTO reseller_ledger_entries/.test(s)) {
    const [, resellerId, entryType, amount, currency, paymentId, cashSessionId, note, createdBy] = params;
    const id = ++state.seq.ledger;
    state.ledger.push({ id, reseller_id: resellerId, entry_type: entryType, amount: Number(amount).toFixed(2), currency, payment_id: paymentId, cash_session_id: cashSessionId, note, created_by: createdBy, created_at: new Date() });
    return [{ insertId: id }];
  }
  if (/FROM reseller_ledger_entries\s+WHERE organization_id = \? AND reseller_id = \? AND payment_id = \? AND entry_type = 'collection'/.test(s)) {
    return [state.ledger.filter((e) => e.reseller_id === Number(params[1]) && e.payment_id === Number(params[2]) && e.entry_type === 'collection')];
  }
  if (/FROM reseller_ledger_entries e\s+WHERE e\.organization_id = \? AND e\.cash_session_id = \?/.test(s)) {
    const rows = state.ledger.filter((e) => e.cash_session_id === Number(params[1]));
    return [[{
      expected_total: fromCents(rows.reduce((t, e) => t + cents(e.amount), 0)),
      collections_count: rows.filter((e) => e.entry_type === 'collection').length - rows.filter((e) => e.entry_type === 'collection_void').length,
    }]];
  }
  if (/FROM reseller_ledger_entries\s+WHERE organization_id = \? AND reseller_id = \?\s+ORDER BY/.test(s)) {
    return [state.ledger.filter((e) => e.reseller_id === Number(params[1])).slice().reverse()];
  }
  if (/COUNT\(\*\) AS total FROM reseller_ledger_entries/.test(s)) {
    return [[{ total: state.ledger.filter((e) => e.reseller_id === Number(params[1])).length }]];
  }
  if (/FROM reseller_ledger_entries WHERE id = \?/.test(s)) return [state.ledger.filter((e) => e.id === Number(params[0]))];
  // --- clients
  if (/FROM clients c\s+WHERE c\.organization_id = \? AND c\.deleted_at IS NULL AND \(/.test(s)) {
    let rest = params.slice(1);
    let byId = null;
    if (/c\.id = \?/.test(s)) { byId = Number(rest[0]); rest = rest.slice(1); }
    const phones = rest.map(String);
    return [Object.values(state.clients).filter((c) => c.id === byId || (phones.length && phones.includes(digits(c.phone))))
      .map(({ id, name, status, reseller_id: rid }) => ({ id, name, status, reseller_id: rid }))];
  }
  if (/FROM clients c\s+WHERE c\.id = \? AND c\.organization_id = \?/.test(s)) {
    const c = state.clients[Number(params[0])];
    const ids = params.slice(2).map(Number);
    return [c && ids.includes(c.reseller_id) ? [{ ...c }] : []];
  }
  if (/SELECT id, name, status, reseller_id FROM clients\s+WHERE id = \?/.test(s)) {
    const c = state.clients[Number(params[0])];
    return [c ? [{ id: c.id, name: c.name, status: c.status, reseller_id: c.reseller_id }] : []];
  }
  // --- invoices
  if (/SELECT id FROM invoices WHERE organization_id <=> \?/.test(s)) return [[]];
  if (/FROM invoices i\s+WHERE i\.organization_id = \? AND i\.client_id IN/.test(s)) {
    const ids = params.slice(1, params.length - PAYABLE.length).map(Number);
    return [Object.values(state.invoices).filter((i) => ids.includes(i.client_id) && PAYABLE.includes(i.status))
      .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id - b.id)
      .map((i) => ({ ...i, balance: fromCents(balanceOf(i)) }))];
  }
  if (/AS balance_due\s+FROM invoices i\s+WHERE i\.client_id = \? AND i\.organization_id = \?/.test(s)) {
    const clientId = Number(params[0]);
    const only = params.slice(2 + PAYABLE.length).map(Number);
    return [Object.values(state.invoices)
      .filter((i) => i.client_id === clientId && PAYABLE.includes(i.status) && (!only.length || only.includes(i.id)))
      .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id - b.id)
      .map((i) => ({ ...i, balance_due: fromCents(balanceOf(i)) }))];
  }
  if (/AS remaining\s+FROM invoices i/.test(s)) {
    const clientId = Number(params[0]);
    const total = Object.values(state.invoices).filter((i) => i.client_id === clientId && PAYABLE.includes(i.status))
      .reduce((t, i) => t + balanceOf(i), 0);
    return [[{ remaining: fromCents(total) }]];
  }
  if (/AS allocated\s+FROM invoices i WHERE i\.id = \?/.test(s)) {
    const inv = state.invoices[Number(params[0])];
    return [inv ? [{ total: inv.total, allocated: fromCents(allocatedOn(inv.id)) }] : []];
  }
  if (/UPDATE invoices SET status = \?/.test(s)) { state.invoices[Number(params[1])].status = params[0]; return [{ affectedRows: 1 }]; }
  if (/UPDATE invoices SET status = 'issued'/.test(s)) {
    const inv = state.invoices[Number(params[0])];
    if (inv && inv.status === 'paid') inv.status = 'issued';
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE invoices SET status = 'paid'/.test(s)) { state.invoices[Number(params[0])].status = 'paid'; return [{ affectedRows: 1 }]; }
  // --- allocations
  if (/INSERT INTO payment_allocations/.test(s)) {
    if (failAllocation) throw new Error('allocation exploded');
    const id = ++state.seq.alloc;
    state.allocations.push({ id, payment_id: params[0], invoice_id: params[1], amount: Number(params[2]).toFixed(2), deleted_at: null });
    return [{ insertId: id }];
  }
  if (/SELECT SUM\(amount\) AS total_allocated FROM payment_allocations/.test(s)) {
    return [[{ total_allocated: fromCents(allocatedOn(Number(params[0]))) }, { total_allocated: null }]];
  }
  if (/SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = \?/.test(s)) {
    const live = /deleted_at IS NOT NULL/.test(s) ? false : true;
    return [[...new Set(state.allocations.filter((a) => a.payment_id === Number(params[0]) && (live ? !a.deleted_at : a.deleted_at)).map((a) => a.invoice_id))].map((invoice_id) => ({ invoice_id }))];
  }
  if (/UPDATE payment_allocations SET deleted_at = NOW\(\) WHERE payment_id = \?/.test(s)) {
    for (const a of state.allocations) if (a.payment_id === Number(params[0]) && !a.deleted_at) a.deleted_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/FROM payment_allocations pa\s+JOIN payments p/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [state.allocations.filter((a) => ids.includes(a.payment_id)).map((a) => ({ payment_id: a.payment_id, invoice_number: state.invoices[a.invoice_id].invoice_number }))];
  }
  if (/FROM payment_allocations pa\s+JOIN invoices i/.test(s)) {
    const includeDeleted = params[2] === 1;
    return [state.allocations.filter((a) => a.payment_id === Number(params[1]) && (includeDeleted || !a.deleted_at))
      .map((a) => ({ invoice_number: state.invoices[a.invoice_id].invoice_number, amount: a.amount }))];
  }
  // --- client balance ledger
  if (/client_balance_ledger/.test(s)) return [{ affectedRows: 1, insertId: 1 }];
  // --- payments
  if (/INSERT INTO payments/.test(s)) {
    const [, clientId, amount, currency, forma, notes, paymentDate, recordedBy, resellerId] = params;
    const id = ++state.seq.payment;
    state.payments.push({
      id, organization_id: ORG, client_id: clientId, amount: Number(amount).toFixed(2), currency, payment_method: 'cash',
      sat_forma_pago: forma, notes, payment_date: paymentDate, recorded_by: recordedBy, reseller_id: resellerId,
      status: 'completed', created_at: new Date(), deleted_at: null,
    });
    return [{ insertId: id }];
  }
  if (/FROM payments\s+WHERE id = \? AND organization_id = \? AND reseller_id = \?\s+FOR UPDATE/.test(s)) {
    return [state.payments.filter((p) => p.id === Number(params[0]) && p.reseller_id === Number(params[2])).map((p) => ({ ...p }))];
  }
  if (/UPDATE payments SET status = 'cancelled'/.test(s)) {
    const p = state.payments.find((x) => x.id === Number(params[0]) && !x.deleted_at);
    if (p) { p.status = 'cancelled'; p.deleted_at = new Date(); }
    return [{ affectedRows: p ? 1 : 0 }];
  }
  if (/SUM\(p\.amount\), 0\) AS total\s+FROM payments p/.test(s)) {
    const total = state.payments.filter((p) => p.reseller_id === Number(params[1]) && p.status === 'completed' && !p.deleted_at
      && p.created_at >= params[2] && p.created_at < params[3]).reduce((t, p) => t + cents(p.amount), 0);
    return [[{ total: fromCents(total) }]];
  }
  if (/FROM payments p\s+LEFT JOIN clients c/.test(s) && /LEFT JOIN resellers r/.test(s)) {
    const p = state.payments.find((x) => x.id === Number(params[0]) && x.reseller_id === Number(params[2]));
    if (!p) return [[]];
    const c = state.clients[p.client_id];
    return [[{
      ...p, client_name: c.name, client_reseller_id: c.reseller_id, reseller_name: state.resellers[p.reseller_id].name,
      org_name: 'Fibra Valle', org_legal_name: 'Fibra Valle SA de CV', org_tax_id: null, org_locale: 'MX',
      org_phone: '722 000 0000', org_address: 'Av. Hidalgo 10', org_city: 'Toluca', org_state: 'México',
    }]];
  }
  if (/FROM payments p\s+LEFT JOIN clients c/.test(s)) {
    const rid = Number(params[1]);
    return [state.payments.filter((p) => p.reseller_id === rid && p.created_at >= params[2] && p.created_at < params[3]).reverse().map((p) => {
      const c = state.clients[p.client_id];
      const entry = state.ledger.find((e) => e.payment_id === p.id && e.entry_type === 'collection');
      const session = entry && state.sessions.find((x) => x.id === entry.cash_session_id);
      return {
        ...p, client_name: c.name, client_reseller_id: c.reseller_id, cash_session_id: entry ? entry.cash_session_id : null,
        cash_session_status: session ? session.status : null, cash_session_user_id: session ? session.agent_user_id : null,
      };
    })];
  }
  if (/COUNT\(\*\) AS total FROM payments p/.test(s)) {
    return [[{ total: state.payments.filter((p) => p.reseller_id === Number(params[1])).length }]];
  }
  if (/AS reseller_voided\s+FROM payments p/.test(s)) {
    return [state.payments.filter((p) => p.id === Number(params[0])).map((p) => ({
      id: p.id, status: p.status,
      reseller_voided: state.ledger.some((e) => e.payment_id === p.id && e.entry_type === 'collection_void') ? 1 : 0,
    }))];
  }
  if (/^UPDATE `payments` SET deleted_at = NULL/.test(s)) {
    const p = state.payments.find((x) => x.id === Number(params[0]) && x.deleted_at);
    if (p) p.deleted_at = null;
    return [{ affectedRows: p ? 1 : 0 }];
  }
  if (/FROM cfdi_documents d/.test(s)) return [stampedRep ? [{ id: 5, uuid: 'A1B2C3D4-0000-0000-0000-000000000001', sat_status: 'vigente' }] : []];
  if (/FROM organization_mx_profiles/.test(s)) return [[{ rfc: 'FVA010101AA1', razon_social: 'Fibra Valle SA de CV' }]];
  if (/SELECT first_name, last_name FROM users/.test(s)) return [[{ first_name: 'Lupita', last_name: 'Gómez' }]];
  // --- cash sessions
  if (/FROM cash_reconciliation_sessions\s+WHERE organization_id = \? AND agent_user_id = \? AND status = 'open'/.test(s)) {
    return [state.sessions.filter((x) => x.agent_user_id === Number(params[1]) && x.status === 'open').slice(-1)];
  }
  if (/FROM cash_reconciliation_sessions\s+WHERE organization_id = \? AND agent_user_id = \? AND status <> 'open'/.test(s)) {
    return [state.sessions.filter((x) => x.agent_user_id === Number(params[1]) && x.status !== 'open').reverse()];
  }
  if (/INSERT INTO cash_reconciliation_sessions/.test(s)) {
    const id = ++state.seq.session;
    state.sessions.push({ id, organization_id: ORG, agent_user_id: params[1], status: 'open', opened_at: new Date(Date.now() - 1000), closed_at: null, expected_total: null, counted_total: null, variance: null });
    return [{ insertId: id }];
  }
  if (/SELECT status, agent_user_id FROM cash_reconciliation_sessions\s+WHERE id = \?/.test(s)) {
    return [state.sessions.filter((x) => x.id === Number(params[0])).map((x) => ({ status: x.status, agent_user_id: x.agent_user_id }))];
  }
  if (/SELECT \* FROM cash_reconciliation_sessions\s+WHERE id = \?/.test(s) || /^SELECT \* FROM cash_reconciliation_sessions WHERE id = \?/.test(s)) {
    return [state.sessions.filter((x) => x.id === Number(params[0])).map((x) => ({ ...x }))];
  }
  if (/INSERT INTO cash_reconciliation_session_payments/.test(s)) {
    const session = state.sessions.find((x) => x.id === Number(params[0]));
    session.frozen = state.payments.filter((p) => p.recorded_by === Number(params[2]) && p.status === 'completed' && !p.deleted_at)
      .reduce((t, p) => t + cents(p.amount), 0);
    return [{ affectedRows: 1 }];
  }
  if (/AS expected_total\s+FROM cash_reconciliation_session_payments/.test(s)) {
    const session = state.sessions.find((x) => x.id === Number(params[0]));
    return [[{ expected_total: fromCents(session.frozen || 0) }]];
  }
  if (/UPDATE cash_reconciliation_sessions\s+SET expected_total/.test(s)) {
    const [expected, counted, variance, id] = params;
    const session = state.sessions.find((x) => x.id === Number(id));
    Object.assign(session, { expected_total: Number(expected).toFixed(2), counted_total: Number(counted).toFixed(2), variance: Number(variance).toFixed(2), status: 'closed', closed_at: new Date() });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE cash_reconciliation_sessions SET notes/.test(s)) return [{ affectedRows: 1 }];
  // --- idempotency
  if (/FROM idempotency_keys/.test(s) && /^\s*SELECT/.test(s)) {
    return [state.idempotency.filter((k) => k.key === params[1]).map((k) => ({ response_code: 201, response_body: k.body }))];
  }
  if (/INSERT INTO idempotency_keys/.test(s)) { state.idempotency.push({ key: params[1], body: JSON.parse(params[2]) }); return [{ affectedRows: 1 }]; }
  if (/UPDATE idempotency_keys/.test(s)) {
    const k = state.idempotency.find((x) => x.key === params[2]);
    if (k) k.body = JSON.parse(params[0]);
    return [{ affectedRows: 1 }];
  }
  if (/DELETE FROM idempotency_keys/.test(s)) return [{ affectedRows: 0 }];
  // --- /me counts
  if (/AS active_clients/.test(s)) return [[{ active_clients: 1, suspended_clients: 0 }]];
  if (/AS open_leads/.test(s)) return [[{ open_leads: 0 }]];
  if (/AS overdue_clients/.test(s)) return [[{ overdue_clients: 0 }]];
  // --- staff payments list
  if (/^SELECT \* FROM `payments`/.test(s)) return [state.payments.map((p) => ({ ...p }))];
  if (/COUNT\(\*\) AS total FROM `payments`/.test(s)) return [[{ total: state.payments.length }]];
  if (/SELECT id, name FROM resellers WHERE organization_id = \? AND id IN/.test(s)) {
    return [params.slice(1).map(Number).map((id) => ({ id, name: state.resellers[id]?.name })).filter((r) => r.name)];
  }
  return [[]];
}

const mockQuery = jest.fn(async (sql, params) => handle(sql, params));

function tokenFor(role) {
  return jwt.sign({ sub: USER, email: `${role}@example.com`, role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}
const COLLECTOR = ['reseller_app.use', 'reseller_app.signup', 'reseller_app.collect'];
function asBoundReseller(permissions = COLLECTOR, resellerId = 1) {
  groupName = 'reseller_admin';
  binding = { reseller_id: resellerId, live_reseller_id: resellerId, reseller_name: state.resellers[resellerId].name };
  User.findById.mockResolvedValue({ id: USER, email: 'r@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('billing');
}
// Another login bound to the same reseller.
function asColleague(permissions = COLLECTOR, resellerId = 1) {
  groupName = 'reseller_admin';
  binding = { reseller_id: resellerId, live_reseller_id: resellerId, reseller_name: state.resellers[resellerId].name };
  User.findById.mockResolvedValue({ id: COLLEAGUE, email: 'c@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return jwt.sign({ sub: COLLEAGUE, email: 'colleague@example.com', role: 'billing', orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}
function asOrgAdmin(extra = ['reseller_ledger.view', 'reseller_ledger.manage']) {
  groupName = 'admin';
  binding = undefined;
  User.findById.mockResolvedValue({ id: USER, email: 'a@example.com', status: 'active', role: 'support', organization_id: ORG });
  User.getPermissions.mockResolvedValue(['resellers.view', 'resellers.create', 'resellers.update', 'payments.view', ...extra]);
  return tokenFor('support');
}

const auth = (r, token) => r.set('Authorization', `Bearer ${token}`);
const get = (path, token) => auth(request(app).get(`/api/v1${path}`), token);
const post = (path, token, body = {}, headers = {}) => {
  let r = auth(request(app).post(`/api/v1${path}`), token);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
};
const put = (path, token, body = {}) => auth(request(app).put(`/api/v1${path}`), token).send(body);
const tokenForClient = (clientId, rootResellerId = 1, nowMs) => signCollectToken({ orgId: ORG, clientId, rootResellerId }, nowMs);

let conn;
beforeEach(() => {
  jest.resetAllMocks();
  state = freshState();
  snapshot = null;
  binding = undefined;
  groupName = undefined;
  failAllocation = false;
  stampedRep = false;
  db.withTenantContext.mockImplementation((_orgId, fn) => fn());
  mockQuery.mockImplementation(async (sql, params) => handle(sql, params));
  db.query.mockImplementation(mockQuery);
  conn = {
    beginTransaction: jest.fn(async () => { snapshot = clone(state); }),
    query: jest.fn(mockQuery),
    execute: jest.fn(mockQuery),
    commit: jest.fn(async () => { snapshot = null; }),
    rollback: jest.fn(async () => { if (snapshot) { state = snapshot; snapshot = null; } }),
    release: jest.fn(),
  };
  db.getConnection.mockResolvedValue(conn);
  jest.spyOn(paymentAllocationService, 'reconnectIfSuspended').mockResolvedValue(false);
  jest.spyOn(repService, 'maybeGenerateRep').mockResolvedValue({ generated: false, reason: 'NO_PPD_CFDI' });
});
afterEach(() => jest.restoreAllMocks());

async function collect(token, body, headers) {
  return post('/reseller-app/payments', token, body, headers);
}

// ---------------------------------------------------------------------------
describe('collect token', () => {
  test('binds the organization, the client and the collecting reseller', () => {
    const t = tokenForClient(21);
    expect(verifyCollectToken(t, { orgId: ORG, rootResellerId: 1 })).toEqual({ ok: true, clientId: 21 });
    expect(verifyCollectToken(t, { orgId: 2, rootResellerId: 1 }).ok).toBe(false);
    expect(verifyCollectToken(t, { orgId: ORG, rootResellerId: 2 }).ok).toBe(false);
  });

  test('expires after 15 minutes', () => {
    const t = tokenForClient(21, 1, Date.now() - 16 * 60 * 1000);
    expect(verifyCollectToken(t, { orgId: ORG, rootResellerId: 1 })).toEqual({ ok: false, reason: 'expired' });
  });

  test.each([
    ['tampered', () => { const t = tokenForClient(21); const [p, s] = t.split('.'); const body = JSON.parse(Buffer.from(p, 'base64url')); body.c = 31; return `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`; }, 'COLLECT_TOKEN_INVALID'],
    ['expired', () => tokenForClient(21, 1, Date.now() - 20 * 60 * 1000), 'COLLECT_TOKEN_EXPIRED'],
    ["another reseller's", () => tokenForClient(21, 2), 'COLLECT_TOKEN_INVALID'],
    ['garbage', () => 'not-a-token', 'COLLECT_TOKEN_INVALID'],
  ])('a %s token is refused and nothing is written', async (_name, make, code) => {
    const res = await collect(asBoundReseller(), { collect_token: make(), amount: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(code);
    expect(state.payments).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
  });
});

describe('lookup', () => {
  test('masks a client outside the subtree and sends no contact data', async () => {
    const res = await get('/reseller-app/collect/lookup?q=%2321', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [hit] = res.body.data;
    expect(hit).toMatchObject({ own: false, client_number: 21, name: 'Ma*** Ló***', status: 'suspended', amount_due: 600 });
    expect(hit.open_invoices.map((i) => i.id)).toEqual([801, 802]);
    for (const key of ['phone', 'email', 'address', 'reseller_id']) expect(hit).not.toHaveProperty(key);
    expect(JSON.stringify(res.body)).not.toMatch(/maria@example\.com|555|Calle/);
    expect(verifyCollectToken(hit.collect_token, { orgId: ORG, rootResellerId: 1 })).toEqual({ ok: true, clientId: 21 });
  });

  test('finds an own client by phone however it is written, with the full name', async () => {
    const res = await get(`/reseller-app/collect/lookup?q=${encodeURIComponent('+52 (722) 555-0001')}`, asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ own: true, client_number: 31, name: 'Ana Ruiz' })]);
    const [[sql, params]] = mockQuery.mock.calls.filter(([q]) => /FROM clients c\s+WHERE c\.organization_id = \? AND c\.deleted_at IS NULL AND \(/.test(q));
    // The whole organization, never a single reseller's clients.
    expect(sql).not.toMatch(/reseller_id IN/);
    expect(params[0]).toBe(ORG);
    expect(params).toEqual(expect.arrayContaining(['7225550001', '527225550001', '5217225550001']));
  });

  test('a stored +52 1 mobile number matches the 10 digits', async () => {
    const res = await get('/reseller-app/collect/lookup?q=7225550003', asBoundReseller());
    expect(res.body.data.map((c) => c.client_number)).toEqual([41]);
    expect(res.body.data[0].name).toBe('Jo*** Pé***');
  });

  test('a name or partial text is not a lookup', async () => {
    const res = await get('/reseller-app/collect/lookup?q=Mar', asBoundReseller());
    expect(res.status).toBe(422);
    expect(parseLookupQuery('12')).toEqual({ clientId: 12, phones: [] });
    expect(parseLookupQuery('# 12')).toEqual({ clientId: 12, phones: [] });
    expect(maskName('Ñandú Álvarez')).toBe('Ña*** Ál***');
  });

  test('needs reseller_app.collect, and org-level staff are refused', async () => {
    expect((await get('/reseller-app/collect/lookup?q=21', asBoundReseller(['reseller_app.use']))).status).toBe(403);
    expect((await get('/reseller-app/collect/lookup?q=21', asOrgAdmin(['reseller_app.collect']))).status).toBe(403);
  });

  test('collect/client/:id serves an own client and 404s any other', async () => {
    const token = asBoundReseller();
    const own = await get('/reseller-app/collect/client/31', token);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ own: true, client_number: 31, name: 'Ana Ruiz', amount_due: 450 });
    expect((await get('/reseller-app/collect/client/21', token)).status).toBe(404);
  });
});

describe('a collection', () => {
  test('posts the payment, allocates it oldest first, opens the cash box and books the ledger together', async () => {
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 450, note: 'pago en tienda' }, { 'Idempotency-Key': 'attempt-0001' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      payment_id: 501, amount: 450,
      allocated: [{ invoice_id: 801, amount: 300 }, { invoice_id: 802, amount: 150 }],
      client_number: 21, client_name: 'Ma*** Ló***', reconnected: false,
      receipt_url: '/reseller-app/payments/501/receipt',
    });
    expect(state.payments).toEqual([expect.objectContaining({
      id: 501, client_id: 21, amount: '450.00', currency: 'MXN', payment_method: 'cash', sat_forma_pago: '01',
      status: 'completed', recorded_by: USER, reseller_id: 1, notes: 'pago en tienda', payment_date: businessToday(),
    })]);
    expect(state.invoices[801].status).toBe('paid');
    expect(state.invoices[802].status).toBe('issued');
    expect(state.sessions).toEqual([expect.objectContaining({ id: 41, agent_user_id: USER, status: 'open' })]);
    expect(state.ledger).toEqual([expect.objectContaining({ reseller_id: 1, entry_type: 'collection', amount: '450.00', payment_id: 501, cash_session_id: 41 })]);
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    // The reseller row is locked before anything is read or written.
    const first = conn.execute.mock.calls[0][0];
    expect(first).toMatch(/FROM resellers[\s\S]*FOR UPDATE/);
  });

  test('a sub-reseller user collects for its top-level reseller', async () => {
    state.clients[31].reseller_id = 3;
    // R1's limit applies, and what R1 already holds counts against it.
    state.resellers[1].credit_limit = '500.00';
    state.ledger.push({ id: 1, reseller_id: 1, entry_type: 'collection', amount: '400.00', payment_id: null, cash_session_id: null });
    const sub = () => asBoundReseller(COLLECTOR, 3);
    const tokenOf3 = signCollectToken({ orgId: ORG, clientId: 31, rootResellerId: 3 });
    const refused = await collect(sub(), { collect_token: tokenOf3, amount: 150 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CREDIT_LIMIT', available_to_collect: 100 });

    const res = await collect(sub(), { collect_token: tokenOf3, amount: 50 });
    expect(res.status).toBe(201);
    expect(res.body.data.client_name).toBe('Ana Ruiz');
    expect(state.payments[0].reseller_id).toBe(1);
    expect(state.ledger.filter((e) => e.payment_id === res.body.data.payment_id)).toEqual([
      expect.objectContaining({ reseller_id: 1, entry_type: 'collection', amount: '50.00' }),
    ]);
    expect(ledgerSum(3)).toBe(0);

    // Everything the sub-reseller user reads is R1's: /me, /ledger, the
    // day's list, the receipt; and it can void its own collection.
    const me = await get('/reseller-app/me', sub());
    expect(me.body.data.reseller.id).toBe(3);
    expect(me.body.data.money).toMatchObject({ balance: 450, credit_limit: 500, available_to_collect: 50, collected_today: 50 });
    expect((await get('/reseller-app/ledger', sub())).body.summary).toMatchObject({ balance: 450, credit_limit: 500 });
    expect((await get('/reseller-app/payments', sub())).body.data).toEqual([expect.objectContaining({ id: res.body.data.payment_id, voidable: true })]);
    expect((await get(`/reseller-app/payments/${res.body.data.payment_id}/receipt`, sub())).status).toBe(200);
    const voided = await post(`/reseller-app/payments/${res.body.data.payment_id}/void`, sub(), { reason: 'me equivoqué' });
    expect(voided.status).toBe(200);
    expect(ledgerSum(1)).toBe(40000);
  });

  test('a sub-reseller user cannot collect while its own reseller is suspended', async () => {
    state.resellers[3].status = 'suspended';
    const res = await collect(asBoundReseller(COLLECTOR, 3), {
      collect_token: signCollectToken({ orgId: ORG, clientId: 31, rootResellerId: 3 }), amount: 50,
    });
    expect(res.status).toBe(403);
    expect(state.payments).toHaveLength(0);
  });

  test("the client's invoices are locked before the transaction's first plain read (DAL-04)", async () => {
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100 });
    expect(res.status).toBe(201);
    const onTx = conn.execute.mock.calls.map(([q]) => String(q));
    const invoiceLock = onTx.findIndex((q) => /SELECT id FROM invoices WHERE organization_id <=> \?[\s\S]*FOR UPDATE/.test(q));
    const firstPlainRead = onTx.findIndex((q) => /^\s*(\/\*[\s\S]*?\*\/\s*)?SELECT/.test(q) && !/FOR UPDATE\s*$/.test(q.trim()));
    expect(invoiceLock).toBeGreaterThan(0);
    expect(firstPlainRead).toBeGreaterThan(invoiceLock);
    // Reseller first, then the invoices: one lock order.
    expect(onTx.findIndex((q) => /FROM resellers[\s\S]*FOR UPDATE/.test(q))).toBeLessThan(invoiceLock);
    const lockCall = conn.execute.mock.calls[invoiceLock];
    expect(lockCall[1]).toEqual([ORG, 21]);
  });

  test('invoice_ids pays only those invoices', async () => {
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300, invoice_ids: [802] });
    expect(res.status).toBe(201);
    expect(res.body.data.allocated).toEqual([{ invoice_id: 802, amount: 300 }]);
    expect(state.invoices[801].status).toBe('overdue');
  });

  test('an invoice that is not an open invoice of the client is 422 and nothing is written', async () => {
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100, invoice_ids: [811] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVOICE_NOT_PAYABLE');
    expect(state.payments).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
  });

  test('a failed allocation rolls back the payment, the ledger line and the new session', async () => {
    failAllocation = true;
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100 });
    expect(res.status).toBe(500);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(state.payments).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(repService.maybeGenerateRep).not.toHaveBeenCalled();
  });

  test('reconnects and generates the REP after commit, and their failures do not fail the collection', async () => {
    paymentAllocationService.reconnectIfSuspended.mockRejectedValue(new Error('RADIUS down'));
    repService.maybeGenerateRep.mockRejectedValue(new Error('PAC down'));
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    expect(res.status).toBe(201);
    expect(res.body.data.reconnected).toBeNull();
    expect(paymentAllocationService.reconnectIfSuspended).toHaveBeenCalledWith(expect.objectContaining({ id: 801 }), USER, ORG);
    expect(repService.maybeGenerateRep).toHaveBeenCalledWith(501, 801, 300, ORG, USER);
    const committed = conn.commit.mock.invocationCallOrder[0];
    expect(paymentAllocationService.reconnectIfSuspended.mock.invocationCallOrder[0]).toBeGreaterThan(committed);
    expect(repService.maybeGenerateRep.mock.invocationCallOrder[0]).toBeGreaterThan(committed);
    expect(state.payments).toHaveLength(1);
  });

  test('reports a reconnection', async () => {
    paymentAllocationService.reconnectIfSuspended.mockResolvedValue(true);
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 600 });
    expect(res.body.data.reconnected).toBe(true);
  });

  test('a retry with the same Idempotency-Key answers the first result and collects once', async () => {
    const token = asBoundReseller();
    const body = { collect_token: tokenForClient(21), amount: 100 };
    const first = await collect(token, body, { 'Idempotency-Key': 'attempt-0002' });
    const again = await collect(token, body, { 'Idempotency-Key': 'attempt-0002' });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(state.payments).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });

  test('a retry after the collect token expired still replays, and a malformed key is 422', async () => {
    const token = asBoundReseller();
    const first = await collect(token, { collect_token: tokenForClient(21), amount: 100 }, { 'Idempotency-Key': 'attempt-0003' });
    const late = await collect(token, { collect_token: tokenForClient(21, 1, Date.now() - 20 * 60 * 1000), amount: 100 }, { 'Idempotency-Key': 'attempt-0003' });
    expect(late.status).toBe(201);
    expect(late.body.data.payment_id).toBe(first.body.data.payment_id);
    expect(state.payments).toHaveLength(1);
    const bad = await collect(token, { collect_token: tokenForClient(21), amount: 100 }, { 'Idempotency-Key': 'x y' });
    expect(bad.status).toBe(422);
  });

  test('a suspended reseller cannot collect', async () => {
    state.resellers[1].status = 'suspended';
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100 });
    expect(res.status).toBe(403);
    expect(state.payments).toHaveLength(0);
  });

  test('the amount must be positive with at most 2 decimals', async () => {
    const token = asBoundReseller();
    expect((await collect(token, { collect_token: tokenForClient(21), amount: 0 })).status).toBe(422);
    expect((await collect(token, { collect_token: tokenForClient(21), amount: 10.005 })).status).toBe(422);
    expect((await collect(token, { collect_token: tokenForClient(21), amount: '10' })).status).toBe(422);
  });

  test('org-level staff cannot collect through the reseller app', async () => {
    const res = await collect(asOrgAdmin(['reseller_app.collect']), { collect_token: tokenForClient(21), amount: 10 });
    expect(res.status).toBe(403);
  });
});

describe('cash bags free the limit (phase 3)', () => {
  const emptyBag = (id, serial) => ({
    id, organization_id: ORG, serial, status: 'at_reseller', reseller_id: 1, carrier_user_id: null,
    declared_amount: null, counted_amount: null, currency: 'MXN', notes: null, created_by: 1, deleted_at: null,
  });

  test('a reseller at its limit is told to fill a bag, seals one and collects again', async () => {
    state.resellers[1].credit_limit = '300.00';
    state.invoices[801].total = '1000.00';
    state.bags.push(emptyBag(701, 'BAG-1'));
    const token = asBoundReseller([...COLLECTOR, 'reseller_app.bags']);
    expect((await collect(token, { collect_token: tokenForClient(21), amount: 300 })).status).toBe(201);
    const refused = await collect(token, { collect_token: tokenForClient(21), amount: 50 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CREDIT_LIMIT', available_to_collect: 0, empty_bags: 1 });
    expect(refused.body.error.details).toMatchObject({ cash_on_hand: 300, in_bags: 0, empty_bags: 1 });
    expect(refused.body.error.message).toMatch(/fill a cash bag/);

    // Sealing books nothing and frees the limit at once.
    const sealed = await post('/reseller-app/bags/seal', token, { serial: 'bag-1', declared_amount: 300 });
    expect(sealed.status).toBe(200);
    expect(sealed.body.data.summary).toMatchObject({ balance: 300, in_bags: 300, cash_on_hand: 0, available_to_collect: 300, empty_bags: 0 });
    expect(state.ledger.map((e) => e.entry_type)).toEqual(['collection']);

    const again = await collect(token, { collect_token: tokenForClient(21), amount: 300 });
    expect(again.status).toBe(201);
    // What it owes still counts the bag until the ISP receives it.
    const me = await get('/reseller-app/me', token);
    expect(me.body.data.money).toMatchObject({ balance: 600, in_bags: 300, cash_on_hand: 300, available_to_collect: 0 });
  });

  test('a collection whose cash is sealed in a bag can no longer be voided', async () => {
    state.bags.push(emptyBag(701, 'BAG-1'));
    const token = asBoundReseller([...COLLECTOR, 'reseller_app.bags']);
    const res = await collect(token, { collect_token: tokenForClient(21), amount: 300 });
    expect((await post('/reseller-app/bags/seal', token, { serial: 'BAG-1', declared_amount: 250 })).status).toBe(200);
    const voided = await post(`/reseller-app/payments/${res.body.data.payment_id}/void`, token, { reason: 'cliente se arrepintió' });
    expect(voided.status).toBe(409);
    expect(voided.body.error.code).toBe('CASH_SEALED_IN_BAG');
    expect(state.payments[0].status).toBe('completed');
    expect(state.ledger.map((e) => e.entry_type)).toEqual(['collection']);
  });

  test('without empty bags the refusal says so', async () => {
    state.resellers[1].credit_limit = '100.00';
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100.01 });
    expect(res.status).toBe(409);
    expect(res.body.error.empty_bags).toBe(0);
    expect(res.body.error.message).toMatch(/wait for empty cash bags/);
  });

  test('a seal waits for the reseller lock a collection holds: both lock the reseller row first', async () => {
    state.resellers[1].credit_limit = '300.00';
    state.bags.push(emptyBag(701, 'BAG-1'));
    const token = asBoundReseller([...COLLECTOR, 'reseller_app.bags']);
    await collect(token, { collect_token: tokenForClient(21), amount: 100 });
    await post('/reseller-app/bags/seal', token, { serial: 'BAG-1', declared_amount: 100 });
    const locks = conn.execute.mock.calls.map(([q]) => String(q)).filter((q) => /FOR UPDATE/.test(q));
    const firstOf = (re) => locks.findIndex((q) => re.test(q));
    // The collection's lock comes first in its transaction, and so does the seal's.
    expect(locks[0]).toMatch(/FROM resellers/);
    const sealLocks = locks.slice(locks.findIndex((q, i) => i > 0 && /FROM resellers/.test(q)));
    expect(sealLocks[0]).toMatch(/FROM resellers/);
    expect(sealLocks[1]).toMatch(/FROM cash_bags/);
    expect(firstOf(/FROM cash_bags/)).toBeGreaterThan(firstOf(/FROM resellers/));
  });
});

describe('credit limit', () => {
  test('the organization default (2000.00) applies when the reseller has none; exactly at the limit is allowed', async () => {
    state.invoices[801].total = '3000.00';
    const token = asBoundReseller();
    const atLimit = await collect(token, { collect_token: tokenForClient(21), amount: 2000 });
    expect(atLimit.status).toBe(201);
    const over = await collect(token, { collect_token: tokenForClient(21), amount: 0.01 });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: 'CREDIT_LIMIT', available_to_collect: 0 });
    expect(state.payments).toHaveLength(1);
  });

  test('the organization setting replaces the default', async () => {
    state.setting = '500.00';
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 500.01 });
    expect(res.status).toBe(409);
    expect(res.body.error.available_to_collect).toBe(500);
    expect(res.body.error.details).toMatchObject({ credit_limit: 500, cash_on_hand: 0 });
  });

  test("the reseller's own limit wins over the organization default", async () => {
    state.setting = '5000.00';
    state.resellers[1].credit_limit = '100.00';
    const token = asBoundReseller();
    expect((await collect(token, { collect_token: tokenForClient(21), amount: 100.01 })).status).toBe(409);
    expect((await collect(token, { collect_token: tokenForClient(21), amount: 100 })).status).toBe(201);
  });

  test('a deposit lowers the balance and frees capacity', async () => {
    state.resellers[1].credit_limit = '300.00';
    const reseller = asBoundReseller();
    expect((await collect(reseller, { collect_token: tokenForClient(21), amount: 300 })).status).toBe(201);
    expect((await collect(reseller, { collect_token: tokenForClient(21), amount: 100 })).status).toBe(409);

    const deposit = await post('/resellers/1/ledger', asOrgAdmin(), { entry_type: 'deposit', amount: 200, note: 'entregó en oficina' });
    expect(deposit.status).toBe(201);
    expect(deposit.body.data).toMatchObject({ entry_type: 'deposit', amount: -200, note: 'entregó en oficina' });
    expect(deposit.body.summary).toMatchObject({ balance: 100, credit_limit: 300, available_to_collect: 200, credit_limit_override: 300 });
    expect(state.payments).toHaveLength(1); // a deposit is never a payment
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'reseller_deposit', tableName: 'reseller_ledger_entries' }));

    const me = await get('/reseller-app/me', asBoundReseller());
    expect(me.body.data.money).toEqual({
      currency: 'MXN', balance: 100, in_bags: 0, cash_on_hand: 100, credit_limit: 300, available_to_collect: 200, collected_today: 300,
      empty_bags: 0, bags_ready_for_pickup: 0, bags_in_transit: 0,
    });
    expect((await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 200 })).status).toBe(201);
  });
});

describe('void', () => {
  async function collected(amount = 300) {
    const res = await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount });
    expect(res.status).toBe(201);
    return res.body.data.payment_id;
  }

  test('reverses the allocations, cancels the payment and books collection_void', async () => {
    const id = await collected(300);
    expect(state.invoices[801].status).toBe('paid');
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'monto equivocado' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ payment_id: id, status: 'voided', amount: 300 });
    expect(state.payments[0]).toMatchObject({ status: 'cancelled' });
    expect(state.payments[0].deleted_at).toBeTruthy();
    expect(state.allocations.every((a) => a.deleted_at)).toBe(true);
    expect(state.invoices[801].status).toBe('issued');
    expect(state.ledger.map((e) => [e.entry_type, e.amount])).toEqual([['collection', '300.00'], ['collection_void', '-300.00']]);
    expect(state.ledger[1]).toMatchObject({ payment_id: id, cash_session_id: 41, note: 'monto equivocado' });
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'void', tableName: 'payments', recordId: id }));
    // Voiding again is a conflict.
    expect((await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'otra vez' })).status).toBe(409);
  });

  test('books the amount the reseller took, even after staff edited the payment', async () => {
    const id = await collected(300);
    state.payments[0].amount = '250.00';
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'monto equivocado' });
    expect(res.status).toBe(200);
    expect(res.body.data.amount).toBe(300);
    expect(state.ledger.map((e) => [e.entry_type, e.amount])).toEqual([['collection', '300.00'], ['collection_void', '-300.00']]);
    expect(ledgerSum(1)).toBe(0);
  });

  test("a colleague bound to the same reseller cannot void another user's collection", async () => {
    const id = await collected(300);
    const list = await get('/reseller-app/payments', asColleague());
    expect(list.body.data).toEqual([expect.objectContaining({ id, status: 'completed', voidable: false })]);
    const res = await post(`/reseller-app/payments/${id}/void`, asColleague(), { reason: 'no es mío' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_YOUR_COLLECTION');
    expect(state.payments[0]).toMatchObject({ status: 'completed', deleted_at: null });
    expect(state.ledger).toHaveLength(1);
    // Its collector still sees it voidable.
    expect((await get('/reseller-app/payments', asBoundReseller())).body.data[0].voidable).toBe(true);
  });

  test('staff cannot restore a voided collection', async () => {
    const id = await collected(300);
    expect((await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'monto equivocado' })).status).toBe(200);
    const res = await post(`/payments/${id}/restore`, asOrgAdmin(['payments.update']));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_VOIDED_BY_RESELLER');
    expect(state.payments[0].deleted_at).toBeTruthy();
    expect(state.allocations.every((a) => a.deleted_at)).toBe(true);
    expect(state.invoices[801].status).toBe('issued');
  });

  test('staff cannot restore any payment that is not completed', async () => {
    state.payments.push({ id: 77, organization_id: ORG, client_id: 21, amount: '10.00', status: 'cancelled', deleted_at: new Date() });
    const res = await post('/payments/77/restore', asOrgAdmin(['payments.update']));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_RESTORABLE');
    expect(state.payments.find((p) => p.id === 77).deleted_at).toBeTruthy();
  });

  test("another reseller's collection is 404", async () => {
    const id = await collected();
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(COLLECTOR, 2), { reason: 'no es mío' });
    expect(res.status).toBe(404);
    expect(state.payments[0].status).toBe('completed');
  });

  test('a collection from another day is 409', async () => {
    const id = await collected();
    state.payments[0].created_at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'tarde' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOID_WINDOW_CLOSED');
  });

  test('a collection whose cash box is closed is 409', async () => {
    const id = await collected();
    state.sessions[0].status = 'closed';
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'caja cerrada' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CASH_SESSION_CLOSED');
  });

  test('a collection reported to SAT with a REP is 409', async () => {
    const id = await collected();
    stampedRep = true;
    const res = await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: 'con REP' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_HAS_REP');
    expect(state.ledger).toHaveLength(1);
    expect(state.allocations.some((a) => !a.deleted_at)).toBe(true);
  });

  test('a reason is required', async () => {
    const id = await collected();
    expect((await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), {})).status).toBe(422);
    expect((await post(`/reseller-app/payments/${id}/void`, asBoundReseller(), { reason: '  a ' })).status).toBe(422);
  });
});

describe('collections list, receipt and cash box', () => {
  test("today's list shows own and masked names, invoices and whether it can be voided", async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    await collect(asBoundReseller(), { collect_token: tokenForClient(31), amount: 50 });
    const res = await get('/reseller-app/payments', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: 502, client_number: 31, client_name: 'Ana Ruiz', own: true, amount: 50, status: 'completed', voidable: true, cash_session_id: 41 }),
      expect.objectContaining({ id: 501, client_number: 21, client_name: 'Ma*** Ló***', own: false, amount: 300, invoice_numbers: ['F-801'], status: 'completed' }),
    ]);
    expect(res.body.meta).toMatchObject({ total: 2, date: businessToday() });
    expect((await get('/reseller-app/payments?date=2026-13-40', asBoundReseller())).status).toBe(422);
  });

  test('the receipt is in Spanish for an MX organization and masks a non-own client', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    const res = await get('/reseller-app/payments/501/receipt', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      receipt_number: 'PV-000501', status: 'completed',
      isp: { name: 'Fibra Valle SA de CV', rfc: 'FVA010101AA1' },
      collected_by: { reseller_name: 'Tienda Lupita', user_name: 'Lupita Gómez' },
      client: { number: 21, name: 'Ma*** Ló***', own: false },
      amount: 300, currency: 'MXN', payment_method: 'cash',
      allocations: [{ invoice_number: 'F-801', amount: 300 }],
      remaining_balance: 300,
      legend: 'Cobrado por Tienda Lupita a nombre de Fibra Valle SA de CV. El pago queda registrado con Fibra Valle SA de CV.',
    });
    const lines = res.body.data.plain_text.split('\n');
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    expect(res.body.data.plain_text).not.toMatch(/María|maria@example/);
  });

  test("another reseller's receipt is 404", async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    expect((await get('/reseller-app/payments/501/receipt', asBoundReseller(COLLECTOR, 2))).status).toBe(404);
  });

  test('the cash box shows the open session net of voids, and closing it computes the variance', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    await collect(asBoundReseller(), { collect_token: tokenForClient(31), amount: 50 });
    await post('/reseller-app/payments/502/void', asBoundReseller(), { reason: 'error de captura' });
    const open = await get('/reseller-app/cash-session', asBoundReseller());
    expect(open.body.data.current).toMatchObject({ id: 41, expected_total: 300, collections_count: 1 });
    expect(open.body.data.recent).toEqual([]);

    const closed = await post('/reseller-app/cash-session/close', asBoundReseller(), { counted_total: 290, notes: 'faltaron 10' });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ id: 41, expected_total: 300, counted_total: 290, variance: -10, status: 'closed' });
    // Closing does not touch the ledger: the cash is still to be handed in.
    expect(state.ledger.reduce((t, e) => t + cents(e.amount), 0)).toBe(30000);

    const after = await get('/reseller-app/cash-session', asBoundReseller());
    expect(after.body.data.current).toBeNull();
    expect(after.body.data.recent).toEqual([expect.objectContaining({ id: 41, variance: -10 })]);
    expect((await post('/reseller-app/cash-session/close', asBoundReseller(), { counted_total: 0 })).status).toBe(409);
    // The next collection opens a new session.
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 10 });
    expect(state.sessions.map((x) => x.status)).toEqual(['closed', 'open']);
  });

  test('the ledger lists entries newest first with the summary', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 300 });
    const res = await get('/reseller-app/ledger', asBoundReseller());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ entry_type: 'collection', amount: 300, payment_id: 501 })]);
    expect(res.body.summary).toEqual({ balance: 300, in_bags: 0, cash_on_hand: 300, credit_limit: 2000, available_to_collect: 1700 });
  });
});

describe('staff side', () => {
  test('ledger endpoints need reseller_ledger.view / .manage and org-level access', async () => {
    expect((await get('/resellers/1/ledger', asOrgAdmin([]))).status).toBe(403);
    expect((await post('/resellers/1/ledger', asOrgAdmin(['reseller_ledger.view']), { entry_type: 'deposit', amount: 1 })).status).toBe(403);
    expect((await get('/resellers/1/ledger', asBoundReseller([...COLLECTOR, 'resellers.view', 'reseller_ledger.view']))).status).toBe(403);
    expect((await post('/resellers/1/ledger', asBoundReseller([...COLLECTOR, 'reseller_ledger.manage']), { entry_type: 'deposit', amount: 1 })).status).toBe(403);
    const ok = await get('/resellers/1/ledger', asOrgAdmin());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ data: [], summary: { balance: 0, credit_limit: 2000, available_to_collect: 2000, credit_limit_override: null } });
  });

  test('deposit and adjustment rules', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 100 });
    const admin = asOrgAdmin();
    const tooMuch = await post('/resellers/1/ledger', admin, { entry_type: 'deposit', amount: 100.01 });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('DEPOSIT_EXCEEDS_BALANCE');
    expect((await post('/resellers/1/ledger', admin, { entry_type: 'deposit', amount: -5 })).status).toBe(422);
    expect((await post('/resellers/1/ledger', admin, { entry_type: 'adjustment', amount: -5 })).status).toBe(422);
    expect((await post('/resellers/1/ledger', admin, { entry_type: 'adjustment', amount: 0, note: 'x' })).status).toBe(422);
    expect((await post('/resellers/1/ledger', admin, { entry_type: 'collection', amount: 5 })).status).toBe(422);
    expect((await post('/resellers/3/ledger', admin, { entry_type: 'deposit', amount: 5 })).status).toBe(422);
    const adj = await post('/resellers/1/ledger', admin, { entry_type: 'adjustment', amount: -2.5, note: 'redondeo' });
    expect(adj.status).toBe(201);
    expect(adj.body.summary.balance).toBe(97.5);
    expect(state.ledger.map((e) => e.entry_type)).toEqual(['collection', 'adjustment']);
  });

  test('a bound user cannot set credit_limit; org-level staff can, and null restores the default', async () => {
    const bound = asBoundReseller([...COLLECTOR, 'resellers.create', 'resellers.update']);
    expect((await post('/resellers', bound, { name: 'Sub', parent_id: 1, credit_limit: 99999 })).status).toBe(403);
    expect((await put('/resellers/3', bound, { credit_limit: 99999 })).status).toBe(403);
    expect((await put('/resellers/3', bound, { credit_limit: null })).status).toBe(403);
    expect(mockQuery.mock.calls.filter(([q]) => /UPDATE resellers SET|INSERT INTO resellers/.test(q))).toHaveLength(0);

    const admin = asOrgAdmin();
    const set = await put('/resellers/1', admin, { credit_limit: 750 });
    expect(set.status).toBe(200);
    expect(state.resellers[1].credit_limit).toBe(750);
    expect(set.body.data).toMatchObject({ credit_limit: 750, effective_credit_limit: 750, balance: 0 });
    const cleared = await put('/resellers/1', admin, { credit_limit: null });
    expect(cleared.body.data).toMatchObject({ credit_limit: null, effective_credit_limit: 2000 });
    expect((await put('/resellers/1', admin, { credit_limit: 1.234 })).status).toBe(422);

    const created = await post('/resellers', admin, { name: 'Nueva', credit_limit: 1500 });
    expect(created.status).toBe(201);
    const [[, params]] = mockQuery.mock.calls.filter(([q]) => /INSERT INTO resellers/.test(q));
    expect(params[params.length - 1]).toBe(1500);
  });

  test('the reseller list carries credit_limit, effective_credit_limit and balance', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 120 });
    mockQuery.mockImplementation(async (sql, params) => {
      if (/SELECT r\.\*, p\.name AS parent_name/.test(sql)) return [[{ ...state.resellers[1] }, { ...state.resellers[2], credit_limit: '50.00' }]];
      if (/COUNT\(\*\) AS total FROM resellers r/.test(sql)) return [[{ total: 2 }]];
      return handle(sql, params);
    });
    const res = await get('/resellers', asOrgAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: 1, credit_limit: null, effective_credit_limit: 2000, balance: 120 }),
      expect.objectContaining({ id: 2, credit_limit: '50.00', effective_credit_limit: 50, balance: 0 }),
    ]);
  });

  test('the staff payments list carries reseller_name and filters by reseller_id', async () => {
    await collect(asBoundReseller(), { collect_token: tokenForClient(21), amount: 120 });
    const res = await get('/payments?reseller_id=1', asOrgAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: 501, reseller_id: 1, reseller_name: 'Tienda Lupita' });
    const [[sql, params]] = mockQuery.mock.calls.filter(([q]) => /^SELECT \* FROM `payments`/.test(q));
    expect(sql).toMatch(/`reseller_id` = \?|reseller_id = \?/);
    expect(params).toEqual(expect.arrayContaining([ORG]));
  });

  test('staff cannot set reseller_id on a payment', async () => {
    const Payment = require('../src/models/Payment');
    expect(Payment.fillable).not.toContain('reseller_id');
    expect(Payment.filterableColumns).toContain('reseller_id');
  });

  test('the fence still keeps a bound user out of the staff payments API', async () => {
    const token = asBoundReseller([...COLLECTOR, 'payments.view', 'payments.create', 'cash_reconciliation.view']);
    expect((await get('/payments', token)).status).toBe(403);
    expect((await post('/payments', token, { client_id: 21, amount: 10, payment_method: 'cash' })).status).toBe(403);
    expect((await get('/cash-reconciliation/sessions', token)).status).toBe(403);
  });
});

describe('organization default credit limit', () => {
  test('is a registered per-organization setting with amount validation', () => {
    const { ORG_SETTING_DEFS } = require('../src/services/settingsCatalog');
    const def = ORG_SETTING_DEFS.reseller_default_credit_limit;
    expect(def.default).toBe('2000.00');
    for (const ok of ['0', '2000', '2000.5', '1500.25']) expect(def.validate(ok)).toBeNull();
    for (const bad of ['-1', '12.345', 'mil', '', ' 10', '1e3']) expect(def.validate(bad)).not.toBeNull();
  });

  test('a stored value that is not an amount falls back to the default', async () => {
    state.setting = 'garbage';
    const res = await get('/reseller-app/ledger', asBoundReseller());
    expect(res.body.summary.credit_limit).toBe(2000);
  });
});

describe('the ledger is append-only', () => {
  test('no source file updates or deletes reseller_ledger_entries', () => {
    const fs = require('fs');
    const path = require('path');
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && /(UPDATE|DELETE FROM)\s+reseller_ledger_entries/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('lookup budget', () => {
  test('is tight per window and capped per day, per collecting reseller', async () => {
    expect(config.rateLimit.resellerLookup).toBe(30);
    expect(config.rateLimit.resellerLookupDaily).toBe(300);
    // Reseller 2 is used here only, so the window starts empty.
    const token = asBoundReseller(COLLECTOR, 2);
    for (let i = 1; i <= 30; i += 1) {
      expect((await get(`/reseller-app/collect/lookup?q=%23${i}`, token)).status).toBe(200);
    }
    const res = await get('/reseller-app/collect/lookup?q=%2331', token);
    expect(res.status).toBe(429);
  });
});
