// =============================================================================
// GQL-10 — balances in different currencies are listed, never added 1:1
// =============================================================================
// computeClientBalance summed invoice balances, payment remainders and credit
// notes as plain numbers whatever their currency, then labelled the sum with
// the organization's currency. Every consumer quoted that figure.

jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => [[{ next_due: null }]]),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/clientBalanceService', () => ({ computeClientBalance: jest.fn() }));

const { computeClientBalance } = require('../src/services/clientBalanceService');
const whatsapp = require('../src/services/whatsappCapabilityService');
const supportBilling = require('../src/services/supportBillingModule');

const MIXED = {
  balance: null,
  currency: null,
  mixedCurrency: true,
  balances: [{ currency: 'MXN', balance: 500 }, { currency: 'USD', balance: -20 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  computeClientBalance.mockResolvedValue(MIXED);
  jest.spyOn(whatsapp, 'payableInvoice').mockResolvedValue(null);
});

test('WhatsApp quotes each currency separately', async () => {
  const text = await whatsapp.balanceText(4, 12);
  expect(text).toContain('balance is *500.00 MXN*, with a credit of *20.00 USD*');
  expect(text).not.toMatch(/480/);
});

test('the AI billing answer quotes each currency separately', async () => {
  const out = await supportBilling.handle('billing', { customer: { id: 12 } }, '¿cuál es mi saldo?', 4);
  expect(out.response).toBe('Tu saldo actual es $500.00 MXN y $-20.00 USD.');
  expect(out.actionData).toEqual({ balances: [{ balance: '500.00', currency: 'MXN' }, { balance: '-20.00', currency: 'USD' }] });
});

test('the AI billing answer reuses a mixed balance already in the context', async () => {
  const out = await supportBilling.handle('billing', { customer: { id: 12 }, billing: MIXED }, 'saldo', 4);
  expect(computeClientBalance).not.toHaveBeenCalled();
  expect(out.response).toContain('$500.00 MXN');
});
