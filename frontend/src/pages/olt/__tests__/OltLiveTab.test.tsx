// The Live OLT tab: the saved login (password write-only), a connection test,
// and read-only lists straight from the OLT, each with the text it printed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/api/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => mocks.apiFetch(...a),
  ApiRequestError: class extends Error { status = 0; body: unknown = null; },
}));

import { OltLiveTab } from '../OltLiveTab';

const PROVISIONING = { line_profile_id: 20, srv_profile_id: 20, service_vlan: 200, user_vlan: null, gem_port: 2, native_vlan_eth_port: null, traffic_table_base: 200 };
const SAVED = { provisioning: PROVISIONING, configured: true, driver: 'huawei_ma5800', host: '10.20.0.5', port: 22, username: 'vigabss', has_password: true, legacy_algorithms: false, host_key_fingerprint: 'SHA256:abc', last_checked_at: null, last_check_ok: null, last_check_message: null };

function serve(connection: Record<string, unknown>) {
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/monitoring')) return { data: { available: false, enabled: false, last_run_at: null, last_status: null, can_change: false } };
    if (path.endsWith('/fibre-status')) return { data: [] };
    if (path.endsWith('/managed-onus') && !init?.method) return { data: [] };
    if (path.startsWith('/devices')) return { data: [{ id: 7, name: 'OLT Norte', model: 'MA5800-X7', ip_address: '10.20.0.5' }] };
    if (path.endsWith('/connection/test')) return { data: { system: { version: 'MA5800V100R019C10', patch: null, product: 'MA5800-X7', uptime: null, raw: 'VERSION : MA5800V100R019C10' }, boards: [{ slot: 1, board: 'H901GPHF', status: 'Normal', kind: 'pon' }], boards_raw: 'SlotID BoardName', connection: SAVED } };
    if (path.endsWith('/live/unregistered-onus')) return { data: { onus: [{ port: '0/1/0', serial_number: '48575443A1B2C3D4', model: 'HG8245H', found_at: '2026-01-05 10:00:00' }], raw: 'Number : 1' } };
    if (path.includes('/live/onus')) return { data: { port: '0/1/0', onus: [{ ont_id: 0, state: 'online', serial_number: '48575443A1B2C3D4', model: 'HG8245H', distance_m: 1500, rx_power_dbm: -18.52, tx_power_dbm: 2.31, description: 'contract-1001' }], reported_total: 1, reported_online: 1, raw: 'ONT ID' } };
    if (path.endsWith('/connection') && init?.method === 'PUT') return { data: SAVED };
    return { data: connection };
  });
}
const calls = () => mocks.apiFetch.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path}`);
const renderTab = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OltLiveTab /></QueryClientProvider>,
);

describe('Live OLT tab', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a new OLT asks for a login, and nothing live is offered until one is saved', async () => {
    serve({ configured: false });
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText('Management address');
    expect(screen.getByLabelText('Password')).toBeRequired();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.queryByText('ONUs waiting to be authorised')).toBeNull();

    await user.type(screen.getByLabelText('Management address'), '10.20.0.5');
    await user.type(screen.getByLabelText('User'), 'vigabss');
    await user.type(screen.getByLabelText('Password'), 's3cret');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(calls()).toContain('PUT /olt-management/7/connection'));
    const put = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ host: '10.20.0.5', port: 22, username: 'vigabss', legacy_algorithms: false, password: 's3cret' });
  });

  it('a saved password is not shown, and leaving it blank does not send one', async () => {
    serve(SAVED);
    const user = userEvent.setup();
    renderTab();
    const password = await screen.findByLabelText('Password');
    expect(password).toHaveValue('');
    expect(password).not.toBeRequired();
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(calls()).toContain('PUT /olt-management/7/connection'));
    const put = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).not.toHaveProperty('password');
  });

  it('tests the connection and shows the version, the boards and what the OLT printed', async () => {
    serve(SAVED);
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected: MA5800-X7, software MA5800V100R019C10')).toBeInTheDocument();
    expect(screen.getByText('H901GPHF')).toBeInTheDocument();
    expect(screen.getAllByText('Show what the OLT printed').length).toBeGreaterThan(0);
  });

  it('reads unregistered ONUs and a port only when asked', async () => {
    serve(SAVED);
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('ONUs waiting to be authorised');
    expect(calls().filter((c) => c.includes('/live/'))).toEqual([]);

    const read = screen.getAllByRole('button', { name: 'Read from the OLT' });
    await user.click(read[0]);
    expect(await screen.findByText('48575443A1B2C3D4')).toBeInTheDocument();
    await user.click(read[1]);
    expect(await screen.findByText('-18.52 dBm')).toBeInTheDocument();
    expect(calls()).toContain('GET /olt-management/7/live/onus?port=0%2F1%2F0');
  });
});
