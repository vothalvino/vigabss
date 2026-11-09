// =============================================================================
// Bolsas de efectivo (staff) — board, receive with the variance, register,
// hand over, void, carriers, and the reseller page's Bolsas and ledger tabs
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { configureAxe } from 'jest-axe';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import CashBagsPage from '../cashBags/CashBagsPage';
import { ResellerBagsTab } from '../resellers/ResellerBagsTab';
import { ResellerLedgerTab } from '../resellers/ResellerLedgerTab';

// Filling a picker past the 5,000 cap pages 51 times and renders 5,000
// options, which takes several seconds on CI with coverage on.
const CUT_LIST_TIMEOUT_MS = 30_000;

const ADMIN = { id: 1, role: 'admin', organization_currency: 'MXN', reseller_binding: null };

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), user: null as unknown }));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));

const READY = { id: 1, serial: 'A-0001', status: 'ready_for_pickup', reseller_id: 4, reseller_name: 'Punto Norte', carrier_user_id: null, carrier_name: null, declared_amount: '500.00', counted_amount: null, variance: null, currency: 'MXN', sealed_at: '2026-11-07T15:00:00Z', picked_up_at: null, received_at: null, created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-07T15:00:00Z' };
const TRANSIT = { ...READY, id: 2, serial: 'A-0002', status: 'in_transit', carrier_user_id: 30, carrier_name: 'Pedro Ruta', declared_amount: '800.00', picked_up_at: '2026-11-07T16:00:00Z' };
const RECEIVED = { ...READY, id: 3, serial: 'A-0003', status: 'received', declared_amount: '300.00', counted_amount: '290.00', variance: '-10.00', received_at: '2026-11-06T18:00:00Z' };
const STOCK = { ...READY, id: 4, serial: 'A-0004', status: 'in_stock', reseller_id: null, reseller_name: null, declared_amount: null, sealed_at: null };
const ALL = [READY, TRANSIT, RECEIVED, STOCK];
const SUMMARY = {
  counts: { in_stock: 1, with_carrier: 0, at_reseller: 0, ready_for_pickup: 1, in_transit: 1, received: 1, void: 0, lost: 0 },
  in_bags: '1300.00',
  resellers: [{ reseller_id: 4, reseller_name: 'Punto Norte', variance: -10, received_bags: 1 }, { reseller_id: 5, reseller_name: 'Punto Sur', variance: 0, received_bags: 2 }],
};
const CARRIERS = [{ user_id: 30, first_name: 'Pedro', last_name: 'Ruta', email: 'ruta@example.com', phone: '5550001', status: 'active', resellers: [{ id: 4, name: 'Punto Norte' }], bags_in_hand: { with_carrier: 3, in_transit: 1 } }];
const RESELLERS = [{ id: 4, name: 'Punto Norte' }, { id: 5, name: 'Punto Sur' }];
// Every point the assign form may pick: top-level resellers and collectors, not sub-resellers.
const POINTS = [
  { id: 4, name: 'Punto Norte', parent_id: null, kind: 'reseller' },
  { id: 5, name: 'Punto Sur', parent_id: null, kind: 'reseller' },
  { id: 6, name: 'Cobros Centro', parent_id: null, kind: 'collector' },
  { id: 7, name: 'Norte Chico', parent_id: 4, kind: 'reseller' },
];

type Handler = (path: string, init?: RequestInit) => unknown;
let override: Handler | null = null;

function respond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (override) {
    const r = override(path, init);
    if (r !== undefined) return r;
  }
  if (path.startsWith('/cash-bags?')) {
    const q = new URLSearchParams(path.split('?')[1]);
    const rows = ALL.filter(b => (!q.get('status') || b.status === q.get('status')) && (!q.get('reseller_id') || String(b.reseller_id) === q.get('reseller_id')));
    return { data: rows, meta: { total: rows.length, page: 1, limit: Number(q.get('limit')) } };
  }
  if (path === '/cash-bags/summary') return { data: SUMMARY };
  const detail = path.match(/^\/cash-bags\/(\d+)$/);
  if (detail && method === 'GET') {
    const bag = ALL.find(b => b.id === Number(detail[1]));
    return { data: { ...bag, events: [{ id: 1, from_status: 'at_reseller', to_status: 'ready_for_pickup', actor_name: 'Lupita', amount: bag?.declared_amount ?? null, note: null, created_at: '2026-11-07T15:00:00Z' }] } };
  }
  if (path === '/cash-bags/1/receive' && method === 'POST') {
    return { data: { bag: { ...READY, status: 'received', counted_amount: '480.00' }, ledger_entries: [{ id: 8, entry_type: 'adjustment', amount: 20, note: 'Declarado 500.00, contado 480.00', cash_bag_id: 1, cash_bag_serial: 'A-0001' }], summary: { balance: 20 } } };
  }
  if (path === '/cash-bags/2/receive' && method === 'POST') {
    // The count matches: the declared amount left the ledger at sealing, nothing more is posted.
    return { data: { bag: { ...TRANSIT, status: 'received', counted_amount: TRANSIT.declared_amount }, ledger_entries: [], summary: { balance: 0 } } };
  }
  if (path === '/cash-bags/4/void' && method === 'POST') return { data: { ...STOCK, status: 'void' } };
  if (path === '/cash-bags' && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    if (body.serial === 'A-0001') throw new ApiRequestError('Every serial is already registered.', 409, { error: { code: 'BAG_SERIALS_EXIST', message: 'Every serial is already registered.', details: { skipped: ['A-0001'] } } });
    if (body.serial) return { data: { created: [{ id: 9, serial: body.serial }], skipped: [] } };
    return { data: { created: [{ serial: 'A0003' }, { serial: 'A0004' }], skipped: ['A0001', 'A0002'] } };
  }
  if (path === '/cash-bags/handover' && method === 'POST') return { data: { bags: JSON.parse(String(init?.body)).serials.map((s: string) => ({ serial: s })) } };
  if (path === '/carriers' && method === 'GET') return { data: CARRIERS };
  if (path === '/carriers' && method === 'POST') return { data: { user_id: 31, email: JSON.parse(String(init?.body)).email } };
  if (path === '/carriers/30/resellers' && method === 'GET') return { data: [{ id: 4, name: 'Punto Norte' }] };
  if (path === '/carriers/30/resellers' && method === 'PUT') return { data: [] };
  if (path === '/carriers/assignable-resellers') return { data: RESELLERS, meta: { total: RESELLERS.length, truncated: false } };
  if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: RESELLERS };
  if (path === '/resellers?page=1&limit=100') return { data: POINTS, meta: { total: POINTS.length } };
  if (path === '/cash-bags/assign' && method === 'POST') return { data: { reseller_id: 5, reseller_name: 'Punto Sur', bags: JSON.parse(String(init?.body)).serials.map((serial: string) => ({ serial, status: 'at_reseller' })) } };
  if (path.startsWith('/resellers/4/bags?')) return { data: [RECEIVED, READY], meta: { total: 2, page: 1, limit: 25 }, summary: { variance: '-10.00' } };
  if (path.startsWith('/resellers/4/ledger?')) {
    return {
      data: [{ id: 5, entry_type: 'bag_sealed', amount: '-300.00', note: 'Bolsa A-0003 sellada', created_at: '2026-11-06T18:00:00Z', payment_id: null, cash_bag_id: 3, cash_bag_serial: 'A-0003' }],
      summary: { balance: '0.00', in_bags: '1300.00', cash_on_hand: '0.00', credit_limit: '2000.00', available_to_collect: '2000.00' },
      meta: { total: 1, page: 1, limit: 25 },
    };
  }
  throw new Error(`unexpected request ${method} ${path}`);
}

function renderPage(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

const calls = (method: string, path: string) =>
  mocks.apiFetch.mock.calls.filter(([p, init]) => p === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } }, runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  mocks.user = ADMIN;
  override = null;
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => respond(path, init));
});
afterEach(async () => { await i18n.changeLanguage('en'); });

describe('board', () => {
  it('shows ready, on their way, received and the per-reseller differences', async () => {
    renderPage(<CashBagsPage />);
    const ready = await screen.findByRole('region', { name: /Ready for pickup/ });
    expect(await within(ready).findByText('A-0001')).toBeInTheDocument();
    const transit = screen.getByRole('region', { name: /On their way/ });
    expect(await within(transit).findByText('A-0002')).toBeInTheDocument();
    expect(within(transit).getByText(/Pedro Ruta/)).toBeInTheDocument();
    const received = screen.getByRole('region', { name: /Received \(recent\)/ });
    expect(await within(received).findByText('$10.00 short')).toBeInTheDocument();
    const diff = screen.getByRole('region', { name: 'Differences' });
    expect(await within(diff).findByText('Punto Norte')).toBeInTheDocument();
    // A reseller whose bags match is not a difference.
    expect(within(diff).queryByText('Punto Sur')).not.toBeInTheDocument();
    expect(calls('GET', '/cash-bags?status=ready_for_pickup&page=1&limit=20')).toHaveLength(1);
  });

  it('filters every column by reseller and serial', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await screen.findByRole('option', { name: 'Punto Sur' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '5');
    await user.type(screen.getByLabelText('Serial'), 'a-0');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/cash-bags?status=in_transit&reseller_id=5&serial=A-0&page=1&limit=20'));
  });

  it('explains a refused transition in the reader\'s language', async () => {
    override = (path, init) => {
      if (path === '/cash-bags/1/receive' && init?.method === 'POST') {
        throw new ApiRequestError('Bag A-0001 is received and cannot be received.', 409, { error: { code: 'BAG_INVALID_TRANSITION', message: 'Bag A-0001 is received and cannot be received.' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Receive bag A-0001' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Counted cash');
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm receipt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This bag is no longer in a state that allows this.');
  });

  it('receives a short bag: shows the declared amount and the difference before confirming', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Receive bag A-0001' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('$500.00', { selector: 'strong' })).toBeInTheDocument();
    expect(within(dialog).getByText(/brought it in person/)).toBeInTheDocument();
    const counted = within(dialog).getByLabelText('Counted cash');
    expect(counted).toHaveValue('500.00');
    expect(within(dialog).getByText('Matches')).toBeInTheDocument();
    await user.clear(counted);
    await user.type(counted, '480');
    expect(within(dialog).getByText('$20.00 short')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(within(dialog).getByText("This records an adjustment of $20.00 on Punto Norte's account for the difference. The declared $500.00 was taken off when the bag was sealed.")).toBeInTheDocument();
    expect(calls('POST', '/cash-bags/1/receive')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm receipt' }));

    expect(await within(dialog).findByText('Bag A-0001 received.')).toBeInTheDocument();
    expect(bodyOf(calls('POST', '/cash-bags/1/receive')[0])).toEqual({ counted_amount: 480 });
    const lines = within(dialog).getByRole('list', { name: 'Movements recorded' });
    expect(lines).toHaveTextContent('Adjustment: $20.00');
    expect(lines).not.toHaveTextContent('Cash handed in');
  });

  it('says when the reseller filter is cut, outside the filter label', async () => {
    const TOTAL = 5200;
    override = (path) => {
      const m = path.match(/^\/resellers\?parent_id=null&page=(\d+)&limit=100$/);
      if (!m) return undefined;
      const start = (Number(m[1]) - 1) * 100;
      const data = Array.from({ length: Math.max(0, Math.min(100, TOTAL - start)) }, (_, i) => ({ id: start + i + 1, name: `Punto ${start + i + 1}`, parent_id: null }));
      return { data, meta: { total: TOTAL, page: Number(m[1]), limit: 100 } };
    };
    renderPage(<CashBagsPage />);
    const note = await screen.findByRole('note', {}, { timeout: CUT_LIST_TIMEOUT_MS - 5_000 });
    expect(note).toHaveTextContent('Showing the first 5000 of 5200 resellers.');
    // The notice is not part of the filter's label, so it is not in its name.
    const select = screen.getByRole('combobox', { name: 'Reseller' });
    expect(note.closest('label')).toBeNull();
    expect(select.closest('label')).not.toContainElement(note);
  }, CUT_LIST_TIMEOUT_MS);

  it('shows an over bag as over, and an equal one posts no difference', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Receive bag A-0002' }));
    const dialog = await screen.findByRole('dialog');
    const counted = await within(dialog).findByLabelText('Counted cash');
    await user.clear(counted);
    await user.type(counted, '810.5');
    expect(within(dialog).getByText('$10.50 over')).toBeInTheDocument();
    await user.clear(counted);
    await user.type(counted, '800');
    // The server takes a note of at most 400 characters (receiveSchema).
    const note = within(dialog).getByLabelText('Note (optional)');
    expect(note).toHaveAttribute('maxLength', '400');
    await user.click(note);
    await user.paste('x'.repeat(450));
    expect(note).toHaveValue('x'.repeat(400));
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(within(dialog).getByText("The count matches: nothing more is posted. The declared $800.00 was taken off Punto Norte's account when the bag was sealed.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm receipt' }));
    expect(await within(dialog).findByText("Nothing more was posted to the reseller's account: the count matches what was declared.")).toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Movements recorded' })).not.toBeInTheDocument();
  });

  it("shows the cash in sealed bags as already off the resellers' accounts", async () => {
    renderPage(<CashBagsPage />);
    expect(await screen.findByText("Cash in bags awaiting pickup or on their way: $1,300.00 (already taken off the resellers' accounts).")).toBeInTheDocument();
  });

  it("the lost dialog says the reseller will not owe the bag and the loss is the company's", async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    const all = await screen.findByRole('region', { name: 'All bags' });
    await user.click(await within(all).findByRole('button', { name: 'Open bag A-0001' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Mark lost' }));
    expect(within(dialog).getByText(/the reseller will not owe it and the loss is the company's/)).toBeInTheDocument();
  });

  it('opens a bag with its history and voids it with a reason', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    const all = await screen.findByRole('region', { name: 'All bags' });
    await user.click(await within(all).findByRole('button', { name: 'Open bag A-0004' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Lupita/)).toBeInTheDocument();
    // A bag in stock has no declared money: void, not lost, not receive.
    expect(within(dialog).queryByRole('button', { name: 'Mark lost' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Receive' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Void' }));
    await user.click(within(dialog).getByRole('button', { name: 'Void bag' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Write a reason of 3 to 500 characters.');
    await user.type(within(dialog).getByLabelText('Reason'), 'Damaged');
    await user.click(within(dialog).getByRole('button', { name: 'Void bag' }));
    expect(await within(dialog).findByText('Bag A-0004 voided.')).toBeInTheDocument();
    expect(bodyOf(calls('POST', '/cash-bags/4/void')[0])).toEqual({ reason: 'Damaged' });
  });

  it('registers a range, previewing it and reporting serials that already existed', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Register bags' }));
    const form = screen.getByRole('form', { name: 'Register bags' });
    await user.click(within(form).getByRole('radio', { name: 'A range' }));
    await user.type(within(form).getByLabelText('Prefix'), 'a');
    await user.type(within(form).getByLabelText('To'), '4');
    expect(form).toHaveTextContent('4 bags: A0001 … A0004');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('2 bags registered. 2 already existed: A0001, A0002');
    expect(bodyOf(calls('POST', '/cash-bags')[0])).toEqual({ prefix: 'A', from: 1, to: 4, pad: 4 });
  });

  it('says when the one serial was registered already', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Register bags' }));
    const form = screen.getByRole('form', { name: 'Register bags' });
    await user.type(within(form).getByLabelText('Bag number'), 'A-0001');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Every serial is already registered: A-0001');
  });

  it('refuses a range above 500 bags', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Register bags' }));
    const form = screen.getByRole('form', { name: 'Register bags' });
    await user.click(within(form).getByRole('radio', { name: 'A range' }));
    await user.type(within(form).getByLabelText('To'), '501');
    await user.click(within(form).getByRole('button', { name: 'Register' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('At most 500 bags per range.');
    expect(calls('POST', '/cash-bags')).toHaveLength(0);
  });

  it('assigns bags straight to a point, or with a carrier that serves it, and names the ones refused', async () => {
    override = (path, init) => {
      if ((path === '/cash-bags/assign' || path === '/cash-bags/handover') && init?.method === 'POST' && JSON.parse(String(init.body)).serials.includes('A-0001')) {
        throw new ApiRequestError('Not in stock', 422, { error: { code: 'BAGS_NOT_IN_STOCK', message: 'Not in stock', details: { failed: ['A-0001'] } } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('button', { name: 'Assign bags' }));
    const form = screen.getByRole('form', { name: 'Assign bags to a point' });
    const point = within(form).getByLabelText('Point (reseller or collector)');
    await within(form).findByRole('option', { name: 'Punto Sur' });
    // Top-level resellers and collectors; a sub-reseller seals on its parent's bags.
    expect(within(point).getAllByRole('option').map(o => o.textContent)).toEqual(['— Choose a point —', 'Punto Norte', 'Punto Sur', 'Cobros Centro (collector)']);
    await user.type(within(form).getByLabelText(/Bag numbers/), 'a-0004, A-0001');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose the point the bags are for.');

    // Directly (the default): no carrier needed.
    await user.selectOptions(point, '5');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('These bags are not in stock: A-0001.');
    await user.clear(within(form).getByLabelText(/Bag numbers/));
    await user.type(within(form).getByLabelText(/Bag numbers/), 'a-0004');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('1 bag assigned to Punto Sur.');
    expect(bodyOf(calls('POST', '/cash-bags/assign')[1])).toEqual({ reseller_id: 5, serials: ['A-0004'] });

    // With a carrier: only the ones that serve the point.
    await user.click(within(form).getByRole('radio', { name: 'Send with a carrier' }));
    expect(await within(form).findByText(/No carrier serves this point yet/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Carrier')).toBeDisabled();
    await user.selectOptions(point, '4');
    expect(within(within(form).getByLabelText('Carrier')).getAllByRole('option').map(o => o.textContent)).toEqual(['— Choose a carrier —', 'Pedro Ruta']);
    await user.type(within(form).getByLabelText(/Bag numbers/), 'a-0004');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose the carrier that takes them.');
    await user.selectOptions(within(form).getByLabelText('Carrier'), '30');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('1 bag handed to Pedro Ruta for Punto Norte.');
    expect(bodyOf(calls('POST', '/cash-bags/handover')[0])).toEqual({ carrier_user_id: 30, reseller_id: 4, serials: ['A-0004'] });
  });

  it('offers only viewing with cash_bags.view alone', async () => {
    mocks.user = { id: 2, role: 'billing', organization_currency: 'MXN', permissions: ['cash_bags.view'] };
    renderPage(<CashBagsPage />);
    expect(await screen.findByText('A-0001')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Carriers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register bags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign bags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive bag A-0001' })).not.toBeInTheDocument();
    expect(calls('GET', '/carriers')).toHaveLength(0);
  });
});

describe('carriers', () => {
  it('lists the carriers and creates one with the reseller-login fields and a phone', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Carriers' }));
    const row = (await screen.findByRole('cell', { name: 'Pedro Ruta' })).closest('tr')!;
    expect(row).toHaveTextContent('Punto Norte');
    expect(row).toHaveTextContent('3');

    const form = screen.getByRole('form', { name: 'Create a carrier' });
    await user.click(within(form).getByRole('button', { name: 'Create carrier' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Fill in first name, last name, email and password.');
    await user.type(within(form).getByLabelText('First name'), 'Ana');
    await user.type(within(form).getByLabelText('Last name'), 'Vía');
    await user.type(within(form).getByLabelText('Email'), 'ana.via@example.com');
    await user.type(within(form).getByLabelText('Phone (optional)'), '5550002');
    await user.type(within(form).getByLabelText('Password'), 'Secreta-12345');
    await user.click(within(form).getByRole('button', { name: 'Create carrier' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Carrier created for ana.via@example.com.');
    expect(bodyOf(calls('POST', '/carriers')[0])).toEqual({ first_name: 'Ana', last_name: 'Vía', email: 'ana.via@example.com', password: 'Secreta-12345', phone: '5550002' });
  });

  it('shows the server refusal of a carrier login as is', async () => {
    override = (path, init) => {
      if (path === '/carriers' && init?.method === 'POST') throw new ApiRequestError('Email already in use', 409, { error: { code: 'CONFLICT', message: 'Email already in use' } });
      return undefined;
    };
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Carriers' }));
    const form = screen.getByRole('form', { name: 'Create a carrier' });
    await user.type(within(form).getByLabelText('First name'), 'Ana');
    await user.type(within(form).getByLabelText('Last name'), 'Vía');
    await user.type(within(form).getByLabelText('Email'), 'ana.via@example.com');
    await user.type(within(form).getByLabelText('Password'), 'x');
    await user.click(within(form).getByRole('button', { name: 'Create carrier' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Email already in use');
  });

  it('assigns top-level resellers to a carrier', async () => {
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Carriers' }));
    await user.click(await screen.findByRole('button', { name: 'Assign resellers to Pedro Ruta' }));
    const panel = screen.getByRole('region', { name: 'Resellers Pedro Ruta serves' });
    expect(await within(panel).findByRole('checkbox', { name: 'Punto Norte' })).toBeChecked();
    await user.click(within(panel).getByRole('checkbox', { name: 'Punto Sur' }));
    await user.click(within(panel).getByRole('button', { name: 'Save (2 resellers)' }));
    await waitFor(() => expect(calls('PUT', '/carriers/30/resellers')).toHaveLength(1));
    expect(bodyOf(calls('PUT', '/carriers/30/resellers')[0])).toEqual({ reseller_ids: [4, 5] });
    // The picker lists every top-level reseller from the carriers endpoint,
    // not the first 100-row page of /resellers (which needs resellers.view).
    expect(calls('GET', '/carriers/assignable-resellers')).toHaveLength(1);
  });

  it('assigns with carriers.manage alone, and offers no carrier login without users.create', async () => {
    mocks.user = { id: 2, role: 'billing', organization_currency: 'MXN', permissions: ['cash_bags.view', 'carriers.manage'] };
    // Without resellers.view the staff reseller list is refused.
    override = (path) => {
      if (path.startsWith('/resellers?')) throw new ApiRequestError('Forbidden', 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      return undefined;
    };
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Carriers' }));
    await user.click(await screen.findByRole('button', { name: 'Assign resellers to Pedro Ruta' }));
    const panel = screen.getByRole('region', { name: 'Resellers Pedro Ruta serves' });
    expect(await within(panel).findByRole('checkbox', { name: 'Punto Sur' })).not.toBeChecked();
    expect(screen.queryByRole('form', { name: 'Create a carrier' })).not.toBeInTheDocument();
  });

  it('says when the reseller list is cut', async () => {
    override = (path) => (path === '/carriers/assignable-resellers' ? { data: RESELLERS, meta: { total: 2500, truncated: true } } : undefined);
    const user = userEvent.setup();
    renderPage(<CashBagsPage />);
    await user.click(await screen.findByRole('tab', { name: 'Carriers' }));
    await user.click(await screen.findByRole('button', { name: 'Assign resellers to Pedro Ruta' }));
    expect(await screen.findByRole('note')).toHaveTextContent('Showing the first 2 resellers by name.');
  });
});

describe('reseller page tabs', () => {
  it('Bolsas lists a reseller bags with the total difference and opens a history', async () => {
    const user = userEvent.setup();
    renderPage(<ResellerBagsTab resellerId={4} resellerName="Punto Norte" />);
    const total = await screen.findByRole('region', { name: 'Total difference of received bags' });
    expect(total).toHaveTextContent('$10.00 short');
    await user.click(screen.getByRole('button', { name: 'History of bag A-0003' }));
    expect(await within(await screen.findByRole('dialog')).findByText(/Lupita/)).toBeInTheDocument();
  });

  it('Bags assigns bags in stock to this point without picking it again', async () => {
    const user = userEvent.setup();
    renderPage(<ResellerBagsTab resellerId={4} resellerName="Punto Norte" />);
    await user.click(await screen.findByRole('button', { name: 'Assign bags' }));
    const form = screen.getByRole('form', { name: 'Assign bags to Punto Norte' });
    expect(within(form).queryByLabelText('Point (reseller or collector)')).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Bag numbers/), 'a-0004');
    await user.click(within(form).getByRole('button', { name: 'Assign bags' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('1 bag assigned to Punto Norte.');
    expect(bodyOf(calls('POST', '/cash-bags/assign')[0])).toEqual({ reseller_id: 4, serials: ['A-0004'] });
    // No reseller list is read: the point is this page's.
    expect(mocks.apiFetch.mock.calls.some(([p]) => String(p).startsWith('/resellers?'))).toBe(false);
  });

  it('Bags offers no Assign bags without cash_bags.manage', async () => {
    mocks.user = { id: 2, role: 'billing', organization_currency: 'MXN', permissions: ['cash_bags.view'] };
    renderPage(<ResellerBagsTab resellerId={4} resellerName="Punto Norte" />);
    await screen.findByText('A-0003');
    expect(screen.queryByRole('button', { name: 'Assign bags' })).not.toBeInTheDocument();
  });

  it('Movimientos names the bag of a seal and shows what bags hold, apart from what the reseller owes', async () => {
    renderPage(<ResellerLedgerTab resellerId={4} />);
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Cash to hand in').nextElementSibling).toHaveTextContent('$0.00');
    expect(within(summary).getByText('In bags awaiting pickup or on their way').nextElementSibling).toHaveTextContent('$1,300.00');
    // Cash on hand is the balance now: not shown twice.
    expect(within(summary).queryByText('Cash outside bags')).not.toBeInTheDocument();
    expect(screen.getByText('Bag sealed')).toBeInTheDocument();
    expect(screen.getByText('Bag A-0003')).toBeInTheDocument();
    expect(screen.getByText('-$300.00')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations on the board and the receive dialog', async () => {
    const user = userEvent.setup();
    const view = renderPage(<CashBagsPage />);
    await screen.findByText('A-0001');
    expect(await axe(view.container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Receive bag A-0001' }));
    await within(await screen.findByRole('dialog')).findByLabelText('Counted cash');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
