// =============================================================================
// Reseller program, phase 4 (migration 007): the commission engine
// =============================================================================
// resellerCommissionService.syncResellerCommission reconciles one invoice's
// commission with its paid state inside the caller's transaction: earned
// (row + ledger -amount) when the invoice is paid, reversed (+amount) when it
// is not, restored when it is paid again; idempotent per transition. These
// tests run the real engine, and the real paid-status writers that call it,
// against an in-memory database (tests/helpers/commissionFakeDb.js) with a row
// lock manager, so concurrent hooks really wait for each other.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/models/Invoice');

const db = require('../src/config/database');
const Invoice = require('../src/models/Invoice');
const commissions = require('../src/services/resellerCommissionService');
const ledger = require('../src/services/resellerLedgerService');
const billingService = require('../src/services/billingService');
const paymentAllocationService = require('../src/services/paymentAllocationService');
const creditNoteApplicationService = require('../src/services/creditNoteApplicationService');
const { handleCommissionSql, ledgerCents } = require('./helpers/commissionFakeDb');

const ORG = 3;
const MASTER = 10; // top-level, 10%
const SUB = 11; // sub-reseller of MASTER, its own rate is ignored
const OTHER = 20; // another top-level, 5%
const ZERO = 30; // top-level with rate 0

const cents = (v) => Math.round(Number(v) * 100);

let state;
let locks;

function freshState() {
  return {
    orgCurrency: 'MXN',
    commissionsSince: null,
    resellers: {
      [MASTER]: { id: MASTER, organization_id: ORG, parent_id: null, commission_rate: '10.00', credit_limit: null, status: 'active' },
      [SUB]: { id: SUB, organization_id: ORG, parent_id: MASTER, commission_rate: '25.00', credit_limit: null, status: 'active' },
      [OTHER]: { id: OTHER, organization_id: ORG, parent_id: null, commission_rate: '5.00', credit_limit: null, status: 'active' },
      [ZERO]: { id: ZERO, organization_id: ORG, parent_id: null, commission_rate: '0.00', credit_limit: null, status: 'active' },
    },
    clients: {
      1: { id: 1, organization_id: ORG, reseller_id: MASTER },
      2: { id: 2, organization_id: ORG, reseller_id: SUB },
      3: { id: 3, organization_id: ORG, reseller_id: null },
      4: { id: 4, organization_id: ORG, reseller_id: ZERO },
      5: { id: 5, organization_id: ORG, reseller_id: OTHER },
    },
    // 1000.00 + 16% IVA = 1160.00: the commission is on the 1000.00.
    invoices: {},
    allocations: [],
    creditApplications: [],
    commissions: [],
    ledger: [],
    seq: { commission: 0, ledger: 0, allocation: 0 },
  };
}

function addInvoice(id, over = {}) {
  state.invoices[id] = {
    id, organization_id: ORG, client_id: 1, invoice_number: `F-${id}`, status: 'issued',
    subtotal: '1000.00', total: '1160.00', currency: 'MXN', paid_at: null, deleted_at: null, ...over,
  };
  return state.invoices[id];
}

const allocatedOn = (invoiceId) => state.allocations.filter((a) => a.invoice_id === invoiceId && !a.deleted_at)
  .reduce((t, a) => t + cents(a.amount), 0)
  + state.creditApplications.filter((a) => a.invoice_id === invoiceId && !a.deleted_at).reduce((t, a) => t + cents(a.amount), 0);

// The paid-status SQL of billingService, paymentAllocationService and
// creditNoteApplicationService, on the same state.
function handleBillingSql(s, p) {
  if (/AS allocated\s+FROM invoices i WHERE i\.id = \? AND i\.deleted_at IS NULL/.test(s)) {
    const inv = state.invoices[Number(p[0])];
    return [inv && !inv.deleted_at ? [{ total: inv.total, organization_id: inv.organization_id, allocated: (allocatedOn(inv.id) / 100).toFixed(2) }] : []];
  }
  if (/AS covered\s+FROM invoices i WHERE i\.id = \? AND i\.deleted_at IS NULL/.test(s)) {
    const inv = state.invoices[Number(p[0])];
    return [inv && !inv.deleted_at ? [{ total: inv.total, organization_id: inv.organization_id, covered: (allocatedOn(inv.id) / 100).toFixed(2) }] : []];
  }
  if (/^UPDATE invoices SET status = 'paid', paid_at = NOW\(\) WHERE id = \? AND status IN \('issued', 'sent', 'overdue'\)/.test(s)) {
    const inv = state.invoices[Number(p[0])];
    const changed = Boolean(inv && ['issued', 'sent', 'overdue'].includes(inv.status));
    if (changed) Object.assign(inv, { status: 'paid', paid_at: new Date() });
    return [{ affectedRows: changed ? 1 : 0 }];
  }
  if (/^UPDATE invoices SET status = 'issued', paid_at = NULL WHERE id = \? AND status = 'paid'/.test(s)) {
    const inv = state.invoices[Number(p[0])];
    const changed = Boolean(inv && inv.status === 'paid');
    if (changed) Object.assign(inv, { status: 'issued', paid_at: null });
    return [{ affectedRows: changed ? 1 : 0 }];
  }
  if (/^UPDATE invoices SET status = \?, paid_at = NOW\(\) WHERE id = \?/.test(s)) {
    Object.assign(state.invoices[Number(p[1])], { status: p[0], paid_at: new Date() });
    return [{ affectedRows: 1 }];
  }
  if (/SELECT SUM\(amount\) AS total_allocated FROM payment_allocations/.test(s)) {
    return [[{ total_allocated: (allocatedOn(Number(p[0])) / 100).toFixed(2) }, { total_allocated: null }]];
  }
  if (/^INSERT INTO payment_allocations/.test(s)) {
    const id = ++state.seq.allocation;
    state.allocations.push({ id, payment_id: p[0], invoice_id: p[1], amount: Number(p[2]).toFixed(2), deleted_at: null });
    return [{ insertId: id }];
  }
  if (/^SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = \? AND deleted_at IS (NOT )?NULL/.test(s)) {
    const deleted = /IS NOT NULL/.test(s);
    return [[...new Set(state.allocations.filter((a) => a.payment_id === p[0] && Boolean(a.deleted_at) === deleted).map((a) => a.invoice_id))]
      .map((invoice_id) => ({ invoice_id }))];
  }
  if (/^UPDATE payment_allocations SET deleted_at = NOW\(\) WHERE payment_id = \?/.test(s)) {
    state.allocations.filter((a) => a.payment_id === p[0] && !a.deleted_at).forEach((a) => { a.deleted_at = new Date(); });
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE payment_allocations SET deleted_at = NULL WHERE payment_id = \?/.test(s)) {
    state.allocations.filter((a) => a.payment_id === p[0] && a.deleted_at).forEach((a) => { a.deleted_at = null; });
    return [{ affectedRows: 1 }];
  }
  // credit notes (creditNoteApplicationService.syncApplication)
  if (/^SELECT id, invoice_id, amount FROM credit_note_applications WHERE credit_note_id = \?/.test(s)) {
    return [state.creditApplications.filter((a) => a.credit_note_id === p[0] && !a.deleted_at)];
  }
  if (/FROM invoices i WHERE i\.id = \? AND i\.organization_id <=> \? AND i\.client_id = \?/.test(s)) {
    const inv = state.invoices[Number(p[0])];
    if (!inv || inv.deleted_at || !['issued', 'sent', 'overdue', 'paid'].includes(inv.status)) return [[]];
    return [[{ id: inv.id, total: inv.total, status: inv.status, covered: (allocatedOn(inv.id) / 100).toFixed(2) }]];
  }
  if (/^UPDATE credit_note_applications SET deleted_at = NOW\(\) WHERE id = \?/.test(s)) {
    state.creditApplications.find((a) => a.id === p[0]).deleted_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO credit_note_applications/.test(s)) {
    const id = state.creditApplications.length + 1;
    state.creditApplications.push({ id, credit_note_id: p[0], invoice_id: Number(p[1]), amount: Number(p[2]).toFixed(2), deleted_at: null });
    return [{ insertId: id }];
  }
  if (/^UPDATE credit_notes SET status/.test(s)) return [{ affectedRows: 1 }];
  // reseller ledger reads (resellerLedgerService)
  if (/SUM\(amount\), 0\) AS balance\s+FROM reseller_ledger_entries/.test(s)) {
    return [[{ balance: (ledgerCents(state, Number(p[1])) / 100).toFixed(2) }]];
  }
  if (/FROM resellers WHERE id = \? AND organization_id = \? AND deleted_at IS NULL/.test(s)) {
    const r = state.resellers[Number(p[0])];
    return [r && r.organization_id === Number(p[1]) && !r.deleted_at ? [{ ...r }] : []];
  }
  if (/AS in_bags FROM cash_bags/.test(s)) return [[{ in_bags: '0.00' }]];
  if (/FROM organization_settings\s+WHERE organization_id = \? AND setting_key = 'reseller_default_credit_limit'/.test(s)) return [[]];
  return undefined;
}

// A row lock manager: `... FOR UPDATE` of an invoice waits while another
// transaction holds it, until that one commits or rolls back.
function lockManager() {
  const held = new Map(); // invoiceId -> { owner, waiters: [] }
  return {
    async acquire(key, owner) {
      for (;;) {
        const lock = held.get(key);
        if (!lock) { held.set(key, { owner, waiters: [] }); return; }
        if (lock.owner === owner) return;
        await new Promise((resolve) => lock.waiters.push(resolve));
      }
    },
    releaseAll(owner) {
      for (const [key, lock] of [...held]) {
        if (lock.owner !== owner) continue;
        held.delete(key);
        lock.waiters.forEach((w) => w());
      }
    },
  };
}

let txSeq = 0;
// One transaction: an exec bound to it, and commit/rollback that release its locks.
function transaction({ before } = {}) {
  const owner = ++txSeq;
  const statements = [];
  const exec = jest.fn(async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    statements.push(s);
    if (before) await before(s, params);
    const invoiceLock = /FROM invoices WHERE id = \? AND organization_id = \? FOR UPDATE/.test(s)
      || /^UPDATE invoices SET status/.test(s);
    if (invoiceLock) await locks.acquire(`invoice:${Number(/^UPDATE invoices SET status = \?/.test(s) ? params[1] : params[0])}`, owner);
    const answer = handleCommissionSql(state, s, params) ?? handleBillingSql(s, params);
    if (answer === undefined) throw new Error(`fake db: unhandled SQL: ${s.slice(0, 160)}`);
    return answer;
  });
  return {
    exec,
    statements,
    commit: async () => locks.releaseAll(owner),
    rollback: async () => locks.releaseAll(owner),
  };
}

// The connection db.getConnection hands out (refreshInvoicePaidStatus or a
// void without a caller transaction opens one of its own).
function wirePool() {
  db.getConnection.mockImplementation(async () => {
    const tx = transaction();
    return {
      beginTransaction: jest.fn(async () => {}),
      execute: tx.exec,
      query: tx.exec,
      commit: jest.fn(tx.commit),
      rollback: jest.fn(tx.rollback),
      release: jest.fn(),
      statements: tx.statements,
    };
  });
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const answer = handleCommissionSql(state, s, params) ?? handleBillingSql(s, params);
    return answer === undefined ? [[]] : answer;
  });
}

async function sync(invoiceId, opts) {
  const tx = transaction();
  const out = await commissions.syncResellerCommission(tx.exec, invoiceId, ORG, opts);
  await tx.commit();
  return out;
}

const pay = (id) => Object.assign(state.invoices[id], { status: 'paid', paid_at: new Date() });
const unpay = (id) => Object.assign(state.invoices[id], { status: 'issued', paid_at: null });
const lines = (resellerId) => state.ledger.filter((e) => e.reseller_id === resellerId).map((e) => [e.entry_type, e.amount]);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  locks = lockManager();
  wirePool();
});

// -----------------------------------------------------------------------------
// The engine
// -----------------------------------------------------------------------------
describe('syncResellerCommission', () => {
  test('a paid invoice earns rate % of its subtotal (IVA excluded): one row and one ledger line', async () => {
    addInvoice(100);
    pay(100);
    const out = await sync(100);
    expect(out).toMatchObject({ action: 'earned', resellerId: MASTER, amount: 100 });
    expect(state.commissions).toEqual([expect.objectContaining({
      organization_id: ORG, reseller_id: MASTER, invoice_id: 100, client_id: 1,
      commission_rate: '10.00', base_amount: '1000.00', invoice_total: '1160.00', commission_amount: '100.00',
      currency: 'MXN', status: 'earned', reversed_at: null,
    })]);
    expect(state.ledger).toEqual([expect.objectContaining({
      reseller_id: MASTER, entry_type: 'commission', amount: '-100.00', currency: 'MXN',
      invoice_id: 100, commission_id: state.commissions[0].id, created_by: null, payment_id: null,
    })]);
  });

  test('rounds to cents half up with the money helpers', async () => {
    addInvoice(101, { subtotal: '258.62', total: '300.00' });
    state.resellers[MASTER].commission_rate = '7.35';
    pay(101);
    await sync(101);
    // 258.62 x 7.35% = 19.00857 -> 19.01
    expect(state.commissions[0].commission_amount).toBe('19.01');
    expect(lines(MASTER)).toEqual([['commission', '-19.01']]);
  });

  test('syncing a paid invoice again (paying twice, a repeated hook) posts nothing more', async () => {
    addInvoice(100);
    pay(100);
    await sync(100);
    const again = await sync(100);
    expect(again).toMatchObject({ action: 'none', commissionId: state.commissions[0].id });
    expect(state.commissions).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });

  test('un-paying writes one reversal; paying again restores the same row with a new line', async () => {
    addInvoice(100);
    pay(100);
    await sync(100);
    unpay(100);
    expect(await sync(100)).toMatchObject({ action: 'reversed', amount: 100 });
    expect(await sync(100)).toEqual({ action: 'none' });
    expect(state.commissions[0]).toMatchObject({ status: 'reversed' });
    expect(state.commissions[0].reversed_at).toBeInstanceOf(Date);
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    expect(ledgerCents(state, MASTER)).toBe(0);

    pay(100);
    expect(await sync(100)).toMatchObject({ action: 'restored', commissionId: state.commissions[0].id });
    expect(state.commissions).toHaveLength(1);
    expect(state.commissions[0]).toMatchObject({ status: 'earned', reversed_at: null });
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00'], ['commission', '-100.00']]);
    expect(ledgerCents(state, MASTER)).toBe(-10000);
    expect(state.ledger.every((e) => e.commission_id === state.commissions[0].id && e.invoice_id === 100)).toBe(true);
  });

  test('a restored commission is recomputed at the rate in force when it is paid again', async () => {
    addInvoice(100);
    pay(100);
    await sync(100);
    unpay(100);
    await sync(100);
    state.resellers[MASTER].commission_rate = '12.00';
    pay(100);
    await sync(100);
    expect(state.commissions[0]).toMatchObject({ commission_rate: '12.00', commission_amount: '120.00' });
    expect(ledgerCents(state, MASTER)).toBe(-12000);
  });

  test("a sub-reseller's client earns at the top-level reseller's rate, on the top-level account", async () => {
    addInvoice(102, { client_id: 2 });
    pay(102);
    await sync(102);
    expect(state.commissions).toEqual([expect.objectContaining({ reseller_id: MASTER, client_id: 2, commission_rate: '10.00', commission_amount: '100.00' })]);
    expect(lines(SUB)).toEqual([]);
    expect(lines(MASTER)).toEqual([['commission', '-100.00']]);
  });

  test.each([
    ['a client without a reseller', { client_id: 3 }, () => {}],
    ['a top-level rate of 0', { client_id: 4 }, () => {}],
    ['a zero subtotal', { subtotal: '0.00', total: '0.00' }, () => {}],
    ['an invoice in another currency than the organization', { currency: 'USD' }, () => {}],
    ['a deleted reseller', {}, () => { state.resellers[MASTER].deleted_at = new Date(); }],
  ])('%s earns nothing (no row, no line)', async (_name, over, setup) => {
    setup();
    addInvoice(103, over);
    pay(103);
    expect(await sync(103)).toEqual({ action: 'none' });
    expect(state.commissions).toEqual([]);
    expect(state.ledger).toEqual([]);
  });

  test('a deleted sub-reseller earns nothing: its clients belong to no live reseller', async () => {
    state.resellers[SUB].deleted_at = new Date();
    addInvoice(104, { client_id: 2 });
    pay(104);
    expect(await sync(104)).toEqual({ action: 'none' });
  });

  describe('go-live (organization setting reseller_commissions_since, migration 007)', () => {
    test('an invoice paid before it earns nothing, and neither does one without paid_at (imported history)', async () => {
      state.commissionsSince = '2026-11-01 12:00:00';
      addInvoice(105, { status: 'paid', paid_at: new Date('2026-11-01T11:59:59Z') });
      addInvoice(106, { status: 'paid', paid_at: null });
      expect(await sync(105)).toEqual({ action: 'none' });
      expect(await sync(106)).toEqual({ action: 'none' });
      expect(state.commissions).toEqual([]);
    });

    test('without the setting (an organization created after the upgrade) an invoice without paid_at still earns nothing', async () => {
      state.commissionsSince = null;
      addInvoice(120, { status: 'paid', paid_at: null });
      expect(await sync(120)).toEqual({ action: 'none' });
      expect(state.commissions).toEqual([]);
    });

    test("without the setting the organization's creation is the go-live point", async () => {
      state.commissionsSince = null;
      state.orgCreatedAt = new Date('2026-11-01T12:00:00Z');
      addInvoice(121, { status: 'paid', paid_at: new Date('2026-10-15T00:00:00Z') });
      addInvoice(122, { status: 'paid', paid_at: new Date('2026-11-02T00:00:00Z') });
      expect(await sync(121)).toEqual({ action: 'none' });
      expect(await sync(122)).toMatchObject({ action: 'earned' });
    });

    test('an invoice paid at or after it earns', async () => {
      state.commissionsSince = '2026-11-01 12:00:00';
      addInvoice(107, { status: 'paid', paid_at: new Date('2026-11-01T12:00:00Z') });
      expect(await sync(107)).toMatchObject({ action: 'earned' });
    });

    test('a historical paid invoice that is un-paid and paid again after go-live earns then', async () => {
      state.commissionsSince = '2026-11-01 12:00:00';
      addInvoice(108, { status: 'paid', paid_at: new Date('2026-10-01T00:00:00Z') });
      unpay(108);
      expect(await sync(108)).toEqual({ action: 'none' }); // nothing stood
      pay(108); // paid_at = now, after go-live
      expect(await sync(108)).toMatchObject({ action: 'earned' });
    });
  });

  test('a deleted invoice, or one the caller is deleting (unpaid), reverses its commission', async () => {
    addInvoice(109);
    pay(109);
    await sync(109);
    expect(await sync(109, { unpaid: true })).toMatchObject({ action: 'reversed' });
    pay(109);
    await sync(109);
    state.invoices[109].deleted_at = new Date();
    expect(await sync(109)).toMatchObject({ action: 'reversed' });
    expect(lines(MASTER).map(([t]) => t)).toEqual(['commission', 'commission_reversal', 'commission', 'commission_reversal']);
  });

  test('a commission stays with the reseller that earned it when the client moves; a new payment earns for the new one', async () => {
    addInvoice(110);
    pay(110);
    await sync(110);
    state.clients[1].reseller_id = OTHER;
    expect(await sync(110)).toMatchObject({ action: 'none', resellerId: MASTER });
    unpay(110);
    expect(await sync(110)).toMatchObject({ action: 'reversed', resellerId: MASTER });
    pay(110);
    expect(await sync(110)).toMatchObject({ action: 'earned', resellerId: OTHER, amount: 50 });
    expect(ledgerCents(state, MASTER)).toBe(0);
    expect(ledgerCents(state, OTHER)).toBe(-5000);
    expect(state.commissions.map((c) => [c.reseller_id, c.status])).toEqual([[MASTER, 'reversed'], [OTHER, 'earned']]);
  });

  test('an invoice of another organization is not touched', async () => {
    addInvoice(111, { organization_id: 99 });
    pay(111);
    expect(await sync(111)).toEqual({ action: 'none' });
    expect(state.commissions).toEqual([]);
  });

  test('undefined organization throws; a NULL organization (single-tenant) has no reseller ledger', async () => {
    const tx = transaction();
    await expect(commissions.syncResellerCommission(tx.exec, 1, undefined)).rejects.toThrow(/requires an orgId/);
    await expect(commissions.syncResellerCommission(tx.exec, 1, null)).resolves.toEqual({ action: 'none' });
    expect(tx.exec).not.toHaveBeenCalled();
  });

  describe('locks (ARCHITECTURE.md, "Reseller commissions")', () => {
    test('locks the invoice first, reads the commission row by a record lock, and takes reseller rows in share mode only', async () => {
      addInvoice(112);
      pay(112);
      const tx = transaction();
      await commissions.syncResellerCommission(tx.exec, 112, ORG);
      expect(tx.statements[0]).toMatch(/FROM invoices WHERE id = \? AND organization_id = \? FOR UPDATE/);
      expect(tx.statements.filter((q) => /FROM resellers/.test(q) && /FOR UPDATE/.test(q))).toEqual([]);
      expect(tx.statements.some((q) => /FROM resellers WHERE id = \? AND organization_id = \? AND deleted_at IS NULL LOCK IN SHARE MODE/.test(q))).toBe(true);
      // No locking read of a missing commission key (a gap lock): the row is
      // found by a plain read, then locked by primary key once it exists.
      expect(tx.statements.filter((q) => /FROM reseller_commissions/.test(q) && /invoice_id = \?/.test(q) && /FOR UPDATE/.test(q))).toEqual([]);
    });

    test('two hooks for the same paid invoice at once post one commission and one line', async () => {
      addInvoice(113);
      pay(113);
      const a = transaction();
      const b = transaction();
      const run = async (tx) => {
        const out = await commissions.syncResellerCommission(tx.exec, 113, ORG);
        await tx.commit();
        return out;
      };
      const [first, second] = await Promise.all([run(a), run(b)]);
      expect([first.action, second.action].sort()).toEqual(['earned', 'none']);
      expect(state.commissions).toHaveLength(1);
      expect(state.ledger).toHaveLength(1);
    });

    test('two hooks for the same un-paid invoice at once post one reversal', async () => {
      addInvoice(114);
      pay(114);
      await sync(114);
      unpay(114);
      const run = async (tx) => {
        const out = await commissions.syncResellerCommission(tx.exec, 114, ORG);
        await tx.commit();
        return out;
      };
      const results = await Promise.all([run(transaction()), run(transaction())]);
      expect(results.map((r) => r.action).sort()).toEqual(['none', 'reversed']);
      expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    });

    test('a stale snapshot that misses a commission another transaction committed hits the unique key and posts nothing', async () => {
      addInvoice(115);
      pay(115);
      await sync(115);
      // This transaction's snapshot predates the row: its plain read sees none.
      const stale = transaction();
      const realExec = stale.exec.getMockImplementation();
      stale.exec.mockImplementation(async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT id, reseller_id FROM reseller_commissions WHERE organization_id = \? AND invoice_id = \?$/.test(s)) return [[]];
        return realExec(sql, params);
      });
      const out = await commissions.syncResellerCommission(stale.exec, 115, ORG);
      expect(out).toMatchObject({ action: 'none', commissionId: state.commissions[0].id });
      expect(stale.statements.some((q) => /^INSERT INTO reseller_commissions/.test(q))).toBe(true);
      expect(state.commissions).toHaveLength(1);
      expect(state.ledger).toHaveLength(1);
    });

    test('an un-pay whose snapshot predates the commission still reverses it: the rows are found by a current read', async () => {
      // An unapply's first plain read fixed its snapshot; a gateway capture
      // then paid the invoice and committed its commission; the unapply
      // takes the invoice back to issued. Its snapshot shows no commission row.
      addInvoice(117);
      pay(117);
      await sync(117);
      unpay(117);
      const stale = transaction();
      const realExec = stale.exec.getMockImplementation();
      stale.exec.mockImplementation(async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^SELECT id, reseller_id FROM reseller_commissions WHERE organization_id = \? AND invoice_id = \?$/.test(s)) return [[]];
        return realExec(sql, params);
      });
      expect(await commissions.syncResellerCommission(stale.exec, 117, ORG)).toMatchObject({ action: 'reversed', resellerId: MASTER, amount: 100 });
      expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
      expect(state.commissions[0].status).toBe('reversed');
      // Lock order: the resellers it books to (share mode), then the locking
      // read of the invoice's commission rows.
      const shareLock = stale.statements.findIndex((q) => /SELECT id FROM resellers WHERE organization_id = \? AND id IN \(.*\) ORDER BY id LOCK IN SHARE MODE/.test(q));
      const currentRead = stale.statements.findIndex((q) => /FROM reseller_commissions WHERE organization_id = \? AND invoice_id = \? ORDER BY id FOR UPDATE/.test(q));
      expect(shareLock).toBeGreaterThan(0);
      expect(currentRead).toBeGreaterThan(shareLock);
    });

    test('the reversal share-locks the reseller of a row the client has moved away from, and its current one, in id order', async () => {
      addInvoice(118);
      pay(118);
      await sync(118);
      state.clients[1].reseller_id = OTHER;
      unpay(118);
      const tx = transaction();
      await commissions.syncResellerCommission(tx.exec, 118, ORG);
      const i = tx.statements.findIndex((q) => /SELECT id FROM resellers WHERE organization_id = \? AND id IN/.test(q));
      expect(tx.exec.mock.calls[i][1]).toEqual([ORG, MASTER, OTHER]);
      expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    });

    test('an un-paid invoice of a client without a reseller, and no row, takes no lock beyond the invoice', async () => {
      addInvoice(119, { client_id: 3 });
      const tx = transaction();
      expect(await commissions.syncResellerCommission(tx.exec, 119, ORG)).toEqual({ action: 'none' });
      expect(tx.statements.filter((q) => /FOR UPDATE|LOCK IN SHARE MODE/.test(q))).toEqual([tx.statements[0]]);
    });

    test('a reversal whose conditional UPDATE finds the row already reversed posts nothing', async () => {
      addInvoice(116);
      pay(116);
      await sync(116);
      unpay(116);
      const tx = transaction();
      const realExec = tx.exec.getMockImplementation();
      // The row read as standing, but another transaction reversed it first.
      tx.exec.mockImplementation(async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (/^UPDATE reseller_commissions SET status = 'reversed'/.test(s)) {
          state.commissions[0].reversed_at = new Date();
          state.commissions[0].status = 'reversed';
        }
        return realExec(sql, params);
      });
      expect(await commissions.syncResellerCommission(tx.exec, 116, ORG)).toEqual({ action: 'none' });
      expect(lines(MASTER)).toEqual([['commission', '-100.00']]);
    });
  });

  test('the balance is the sum of the ledger lines (summaryFor)', async () => {
    addInvoice(117);
    addInvoice(118, { subtotal: '500.00', total: '580.00' });
    state.ledger.push({ id: 900, organization_id: ORG, reseller_id: MASTER, entry_type: 'collection', amount: '1160.00' });
    pay(117);
    await sync(117);
    pay(118);
    await sync(118);
    unpay(118);
    await sync(118);
    const summary = await ledger.summaryFor(ORG, MASTER);
    expect(summary.balance).toBe((ledgerCents(state, MASTER)) / 100);
    expect(summary.balance).toBe(1060); // 1160 collected - 100 kept; the 50 was reversed
    expect(summary).toMatchObject({ cash_on_hand: 1060 });
  });
});

// -----------------------------------------------------------------------------
// The paid-state writers call it, in both directions, in their transaction
// -----------------------------------------------------------------------------
describe('every writer of the paid state syncs the commission', () => {
  test('an allocation that pays the invoice off (applyAllocation -> finalizeIfFullyPaid) earns it once', async () => {
    const inv = addInvoice(200);
    const tx = transaction();
    const payment = { id: 50, organization_id: ORG, client_id: 1, currency: 'MXN', status: 'completed' };
    const first = await paymentAllocationService.applyAllocation(tx.exec, { payment, invoice: { ...inv }, amount: 600 });
    expect(first.becamePaid).toBe(false);
    expect(state.commissions).toEqual([]);
    const second = await paymentAllocationService.applyAllocation(tx.exec, { payment: { ...payment, id: 51 }, invoice: { ...inv }, amount: 560 });
    expect(second.becamePaid).toBe(true);
    await tx.commit();
    expect(state.invoices[200].status).toBe('paid');
    expect(state.commissions).toHaveLength(1);
    expect(lines(MASTER)).toEqual([['commission', '-100.00']]);
    // The sync ran on the allocation's own transaction.
    expect(tx.statements.some((q) => /^INSERT INTO reseller_commissions/.test(q))).toBe(true);
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('allocateAcrossInvoices pays several invoices and earns each once', async () => {
    addInvoice(201);
    addInvoice(202, { client_id: 1 });
    const tx = transaction();
    const payment = { id: 52, organization_id: ORG, client_id: 1, currency: 'MXN' };
    const invoices = [201, 202].map((id) => ({ ...state.invoices[id], balance_due: '1160.00' }));
    const out = await paymentAllocationService.allocateAcrossInvoices(tx.exec, { payment, amount: 2320, invoices });
    await tx.commit();
    expect(out.justPaidInvoices.map((i) => i.id)).toEqual([201, 202]);
    expect(state.commissions.map((c) => c.invoice_id)).toEqual([201, 202]);
    expect(ledgerCents(state, MASTER)).toBe(-20000);
  });

  test('refreshInvoicePaidStatus: covered -> paid earns, uncovered -> issued reverses, nothing else syncs', async () => {
    addInvoice(203);
    state.allocations.push({ id: 1, payment_id: 60, invoice_id: 203, amount: '1160.00', deleted_at: null });
    const tx = transaction();
    expect(await billingService.refreshInvoicePaidStatus(203, tx.exec)).toBe(true);
    expect(await billingService.refreshInvoicePaidStatus(203, tx.exec)).toBe(false); // already paid: no sync
    state.allocations[0].deleted_at = new Date();
    expect(await billingService.refreshInvoicePaidStatus(203, tx.exec)).toBe(true);
    await tx.commit();
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
  });

  test('refreshInvoicePaidStatus never marks a void, cancelled or draft invoice paid (a restore reviving allocations a void released)', async () => {
    for (const [id, status] of [[204, 'void'], [205, 'cancelled'], [206, 'draft']]) {
      addInvoice(id, { status });
      state.allocations.push({ id, payment_id: 61, invoice_id: id, amount: '1160.00', deleted_at: null });
      const tx = transaction();
      expect(await billingService.refreshInvoicePaidStatus(id, tx.exec)).toBe(false);
      expect(state.invoices[id].status).toBe(status);
    }
    expect(state.commissions).toEqual([]);
  });

  test('without a caller transaction, refreshInvoicePaidStatus opens one for the recompute and the sync', async () => {
    addInvoice(207);
    state.allocations.push({ id: 2, payment_id: 62, invoice_id: 207, amount: '1160.00', deleted_at: null });
    await billingService.refreshInvoicePaidStatus(207);
    const conn = await db.getConnection.mock.results[0].value;
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
    expect(conn.statements.some((q) => /^INSERT INTO reseller_commissions/.test(q))).toBe(true);
    expect(state.commissions).toHaveLength(1);
  });

  test('deleting a payment (reversePaymentAllocations) re-opens every invoice first, then reverses each commission', async () => {
    addInvoice(208);
    addInvoice(209, { client_id: 5 });
    for (const id of [208, 209]) {
      state.allocations.push({ id, payment_id: 63, invoice_id: id, amount: '1160.00', deleted_at: null });
      pay(id);
      await sync(id);
    }
    const tx = transaction();
    await billingService.reversePaymentAllocations(63, tx.exec);
    await tx.commit();
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    expect(lines(OTHER)).toEqual([['commission', '-50.00'], ['commission_reversal', '50.00']]);
    // Both invoice updates (their row locks) come before the first reseller lock.
    const lastInvoiceUpdate = Math.max(...tx.statements.map((q, i) => (/^UPDATE invoices SET status/.test(q) ? i : -1)));
    const firstResellerRead = tx.statements.findIndex((q) => /FROM reseller_commissions|FROM resellers/.test(q));
    expect(lastInvoiceUpdate).toBeLessThan(firstResellerRead);

    // Restoring the payment pays them again and restores both commissions.
    const restore = transaction();
    await billingService.restorePaymentAllocations(63, restore.exec);
    await restore.commit();
    expect(ledgerCents(state, MASTER)).toBe(-10000);
    expect(ledgerCents(state, OTHER)).toBe(-5000);
    expect(state.commissions).toHaveLength(2);
  });

  test('a credit note that covers the invoice earns, and cancelling it reverses', async () => {
    addInvoice(210);
    const note = { id: 70, client_id: 1, invoice_id: 210, total: '1160.00', status: 'issued', deleted_at: null };
    const tx = transaction();
    await creditNoteApplicationService.syncApplication(tx.exec, note, ORG);
    expect(state.invoices[210].status).toBe('paid');
    expect(lines(MASTER)).toEqual([['commission', '-100.00']]);
    await creditNoteApplicationService.syncApplication(tx.exec, { ...note, status: 'cancelled' }, ORG);
    await tx.commit();
    expect(state.invoices[210].status).toBe('issued');
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
  });

  test('a credit note moved to another invoice reverses the first and earns the second, both invoices updated first', async () => {
    addInvoice(211);
    addInvoice(212, { client_id: 1 });
    const note = { id: 71, client_id: 1, invoice_id: 211, total: '1160.00', status: 'issued', deleted_at: null };
    const first = transaction();
    await creditNoteApplicationService.syncApplication(first.exec, note, ORG);
    await first.commit();
    const tx = transaction();
    await creditNoteApplicationService.syncApplication(tx.exec, { ...note, invoice_id: 212, status: 'applied' }, ORG);
    await tx.commit();
    expect(state.commissions.map((c) => [c.invoice_id, c.status])).toEqual([[211, 'reversed'], [212, 'earned']]);
    expect(ledgerCents(state, MASTER)).toBe(-10000);
    const lastInvoiceUpdate = Math.max(...tx.statements.map((q, i) => (/^UPDATE invoices SET status/.test(q) ? i : -1)));
    const firstCommissionRead = tx.statements.findIndex((q) => /FROM reseller_commissions/.test(q));
    expect(lastInvoiceUpdate).toBeLessThan(firstCommissionRead);
  });

  test('voiding or SAT-cancelling a paid invoice reverses its commission in a transaction of its own', async () => {
    addInvoice(213, { status: 'paid', paid_at: new Date() });
    await sync(213);
    Invoice.findByIdOrFail.mockResolvedValue({ ...state.invoices[213] });
    Invoice.update.mockImplementation(async (id, { status }) => {
      Object.assign(state.invoices[id], { status });
      return { ...state.invoices[id] };
    });
    await billingService.cancelInvoiceForSat(213, ORG, null);
    expect(state.invoices[213].status).toBe('cancelled');
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    const conn = await db.getConnection.mock.results[0].value;
    expect(conn.commit).toHaveBeenCalled();
  });

  test('voiding an invoice that was not paid syncs and posts nothing', async () => {
    addInvoice(214);
    Invoice.findByIdOrFail.mockResolvedValue({ ...state.invoices[214] });
    Invoice.update.mockImplementation(async (id, { status }) => {
      Object.assign(state.invoices[id], { status });
      return { ...state.invoices[id] };
    });
    await billingService.voidInvoiceById(214, ORG, 1);
    expect(state.invoices[214].status).toBe('void');
    expect(state.commissions).toEqual([]);
    expect(state.ledger).toEqual([]);
  });

  test('a SAT cancellation that read the invoice unpaid still reverses a commission a concurrent payment earned before its UPDATE', async () => {
    addInvoice(215);
    // The cancellation reads the invoice as issued (no lock) ...
    Invoice.findByIdOrFail.mockResolvedValue({ ...state.invoices[215] });
    Invoice.update.mockImplementation(async (id, { status }) => {
      // ... a gateway capture pays it and commits its commission ...
      pay(id);
      await sync(id);
      // ... then the cancellation's UPDATE lands.
      Object.assign(state.invoices[id], { status });
      return { ...state.invoices[id] };
    });
    await billingService.cancelInvoiceForSat(215, ORG, null);
    expect(state.invoices[215].status).toBe('cancelled');
    expect(lines(MASTER)).toEqual([['commission', '-100.00'], ['commission_reversal', '100.00']]);
    expect(state.commissions[0].status).toBe('reversed');
  });
});

// -----------------------------------------------------------------------------
// No paid-state writer outside the hooked ones
// -----------------------------------------------------------------------------
describe('the paid-state writers are the hooked ones', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (f.name !== 'scripts') walk(p); } else if (f.name.endsWith('.js')) files.push(p);
    }
  }(SRC));

  test('only the shared recomputes write invoices.status = paid / back to issued, and each syncs the commission', () => {
    const writers = files.filter((f) => /UPDATE invoices SET status/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f)).sort();
    expect(writers).toEqual([
      'services/billingService.js',
      'services/creditNoteApplicationService.js',
      'services/paymentAllocationService.js',
    ]);
    for (const f of writers) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf8')).toMatch(/resellerCommission/);
    }
  });

  test('the generic invoice status writes (void, SAT cancel, hand edits, delete, restore) sync too', () => {
    const billing = fs.readFileSync(path.join(SRC, 'services/billingService.js'), 'utf8');
    const settle = billing.slice(billing.indexOf('async function settleInvoiceTerminal'));
    expect(settle).toMatch(/syncResellerCommissionBestEffort\(existing\.id, orgId\)/);
    const invoices = fs.readFileSync(path.join(SRC, 'routes/invoices.js'), 'utf8');
    expect(invoices).toMatch(/afterUpdate: async \(record, req, exec\) => \{\s+await require\('\.\.\/services\/resellerCommissionService'\)\.syncResellerCommission\(exec, record\.id, req\.orgId\);/);
    expect(invoices).toMatch(/syncResellerCommission\(exec, old\.id, req\.orgId, \{ unpaid: true \}\)/);
    expect(invoices).toMatch(/afterRestore: async \(record, req, exec\) => \{[\s\S]{0,240}await billingService\.refreshInvoicePaidStatus\(record\.id, exec\);\s+await require\('\.\.\/services\/resellerCommissionService'\)\.syncResellerCommission\(exec, record\.id, req\.orgId\);/);
    // The void / SAT cancel sync is not gated on the unlocked read of the status.
    expect(settle).not.toMatch(/if \(existing\.status === 'paid'\)/);
    // A hand edit cannot write paid_at (the go-live point).
    expect(invoices).toMatch(/beforeUpdate: async \(old, req, exec\) => \{[\s\S]{0,600}delete req\.body\.paid_at;/);
    expect(invoices).toMatch(/transactionalAfterHooks: true,\s+fatalAfterHooks: true,/);
  });

  test('the old recordCommission is gone and nothing writes reseller_commissions but the engine', () => {
    const writers = files.filter((f) => /(INSERT INTO|UPDATE) reseller_commissions/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(writers).toEqual(['services/resellerCommissionService.js']);
    const appenders = files.filter((f) => /entryType: '(commission|commission_reversal)'|'commission_reversal', amount/.test(fs.readFileSync(f, 'utf8')));
    expect(appenders.map((f) => path.relative(SRC, f))).toEqual(['services/resellerCommissionService.js']);
  });
});

describe('commission figures', () => {
  test('commissionThisMonth sums the standing commissions earned since the first of the business month', async () => {
    addInvoice(300);
    addInvoice(301);
    pay(300);
    await sync(300);
    pay(301);
    await sync(301);
    unpay(301);
    await sync(301);
    state.commissions.push({ id: 99, organization_id: ORG, reseller_id: MASTER, invoice_id: 1, commission_amount: '70.00', reversed_at: null, earned_at: new Date('2020-01-01T00:00:00Z') });
    expect(await commissions.commissionThisMonth(ORG, MASTER)).toBe(100);
  });

  test('commissionAmount works on DECIMAL strings exactly', () => {
    expect(commissions.commissionAmount('1234.57', '10.50')).toBe(129.63);
    expect(commissions.commissionAmount('0.05', '10.00')).toBe(0.01);
    expect(commissions.commissionAmount('100.00', '0.00')).toBe(0);
  });
});
