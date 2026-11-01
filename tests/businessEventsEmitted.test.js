// =============================================================================
// ASY-08 — documented business events are emitted
// =============================================================================
// notificationHooks listened for invoice.created, payment.received,
// contract.suspended / .restored, suspension.warning, ticket.created and
// maintenance.scheduled, and the integration docs list them as webhook events,
// but nothing emitted them. The only contract.suspended emit (bulk.js) sent
// { contractId } where the hook reads contract.id, so it threw and was
// swallowed. Integrations, SSE and portal push never saw an invoice or a
// payment.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/services/smsTransport', () => ({ queueSms: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/services/webhookService', () => ({ dispatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/routes/events', () => ({ broadcast: jest.fn() }));

const db = require('../src/config/database');
const eventBus = require('../src/services/eventBus');
const emailTransport = require('../src/services/emailTransport');
const smsTransport = require('../src/services/smsTransport');
const webhookService = require('../src/services/webhookService');
const businessEvents = require('../src/services/businessEvents');

const ROOT = path.join(__dirname, '..');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}
const SOURCES = sourceFiles(path.join(ROOT, 'src')).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

const HELPER_FOR = {
  'invoice.created': 'emitInvoiceCreated',
  'payment.received': 'emitPaymentReceived',
  'contract.suspended': 'emitContractSuspended',
  'contract.restored': 'emitContractRestored',
  'ticket.created': 'emitTicketCreated',
  'maintenance.scheduled': 'emitMaintenanceScheduled',
};

describe('every documented webhook event has an emitter', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'api-and-integrations.md'), 'utf8');
  const table = doc.slice(doc.indexOf('### Webhook Events'), doc.indexOf('### Inbound Payment-Provider Webhooks'));
  const documented = [...table.matchAll(/^\| `([a-z_.]+)` \|/gm)].map((m) => m[1]);

  test('the table was read', () => {
    expect(documented).toEqual(expect.arrayContaining(Object.keys(HELPER_FOR)));
  });

  test.each(documented)('%s', (event) => {
    const helper = HELPER_FOR[event];
    if (helper) {
      // Called from at least one place other than the helper module itself.
      const callers = SOURCES.filter(({ file, text }) => !file.endsWith('businessEvents.js') && text.includes(`.${helper}(`));
      expect(callers.length).toBeGreaterThan(0);
    } else {
      const emitted = SOURCES.some(({ file, text }) => text.includes(`emit('${event}'`)
        || (file.endsWith('deviceStatusService.js') && text.includes(`'${event}'`)));
      expect(emitted).toBe(true);
    }
  });

  test('bulk suspension no longer emits a malformed contract.suspended', () => {
    const bulk = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'bulk.js'), 'utf8');
    expect(bulk).not.toMatch(/emit\('contract\.suspended'/);
    for (const [file, fn] of [['services/suspensionService.js', 'emitContractSuspended'], ['services/suspensionService.js', 'emitContractRestored'], ['services/radiusService.js', 'emitContractSuspended']]) {
      expect(fs.readFileSync(path.join(ROOT, 'src', file), 'utf8')).toMatch(new RegExp(`\\.${fn}\\(`));
    }
  });
});

describe('payloads match what the hooks read', () => {
  let seen;
  beforeEach(() => {
    jest.clearAllMocks();
    eventBus.removeAllListeners();
    seen = [];
    eventBus.on('*', (payload) => { seen.push(payload); });
    db.query.mockImplementation(async (sql) => {
      if (/FROM contracts WHERE id = \?/.test(sql)) return [[{ id: 5, client_id: 9, organization_id: 3, status: 'suspended' }]];
      if (/FROM invoices WHERE id = \?/.test(sql)) return [[{ id: 70, client_id: 9, invoice_number: 'F-70', total: '580.00', currency: 'MXN' }]];
      if (/FROM invoice_items/.test(sql)) return [[{ description: 'Plan', amount: '500.00' }]];
      if (/FROM payments WHERE id = \?/.test(sql)) return [[{ id: 11, client_id: 9, amount: '580.00', currency: 'MXN' }]];
      if (/FROM tickets WHERE id = \?/.test(sql)) return [[{ id: 21, organization_id: 3, subject: 'No service', client_id: 9 }]];
      return [[]];
    });
  });
  afterAll(() => eventBus.removeAllListeners());

  test('contract.suspended carries the contract row and its organization', async () => {
    await businessEvents.emitContractSuspended(5, { invoiceId: 70 });
    await new Promise(setImmediate);
    expect(seen[0]).toMatchObject({ event: 'contract.suspended', organizationId: 3, contract: { id: 5 }, invoice: { id: 70 } });
  });

  test('invoice.created and payment.received carry their rows', async () => {
    await businessEvents.emitInvoiceCreated(3, 70);
    await businessEvents.emitPaymentReceived(3, 11);
    await new Promise(setImmediate);
    expect(seen.map((e) => e.event)).toEqual(['invoice.created', 'payment.received']);
    expect(seen[0]).toMatchObject({ invoice: { id: 70 }, items: [{ description: 'Plan' }] });
    expect(seen[1]).toMatchObject({ payment: { id: 11 } });
    expect(seen[0].client).toBeUndefined(); // the subscriber is not messaged again
  });

  test('a failure to load never reaches the caller', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(businessEvents.emitTicketCreated(3, 21)).resolves.toBeUndefined();
  });

  test('nothing is loaded when nothing listens', async () => {
    eventBus.removeAllListeners();
    await businessEvents.emitInvoiceCreated(3, 70);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('hooks', () => {
  beforeAll(() => {
    eventBus.removeAllListeners();
    require('../src/services/notificationHooks').registerHooks();
  });
  afterAll(() => eventBus.removeAllListeners());
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue([[]]);
  });

  test('a suspension warning already emailed gets only its SMS', async () => {
    await eventBus.emit('suspension.warning', {
      organizationId: 3, emailSent: true, daysOverdue: 25,
      contract: { id: 5, client_id: 9 }, client: { id: 9, name: 'Ana', email: 'ana@example.com', phone: '+525511112222' },
      invoice: { id: 70, invoice_number: 'F-70', total: '580.00', currency: 'MXN' },
    });
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
    expect(smsTransport.queueSms).toHaveBeenCalledWith(expect.objectContaining({ to: '+525511112222', clientId: 9 }));
  });

  test('a maintenance window is announced to integrations, not to every subscriber', async () => {
    await eventBus.emit('maintenance.scheduled', {
      organizationId: 3, notifyClients: false,
      maintenance: { id: 4, title: 'OLT swap', scheduled_at: '2026-11-10T06:00:00Z', estimated_duration_minutes: 60 },
    });
    expect(webhookService.dispatch).toHaveBeenCalledWith(3, 'maintenance.scheduled', expect.objectContaining({ id: 4 }));
    expect(db.query.mock.calls.some(([sql]) => /FROM clients/.test(sql))).toBe(false);
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });

  test('contract.suspended from a suspension reaches the webhook', async () => {
    await eventBus.emit('contract.suspended', { organizationId: 3, contract: { id: 5, client_id: 9 }, invoice: null, mode: 'suspend' });
    expect(webhookService.dispatch).toHaveBeenCalledWith(3, 'contract.suspended', { id: 5, client_id: 9 });
  });
});
