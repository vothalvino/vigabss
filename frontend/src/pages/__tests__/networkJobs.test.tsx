// =============================================================================
// NET-26 — network jobs the UI starts are run, or refused with the reason
// =============================================================================
// Discovery scans, AP commands and firmware campaigns were stored and never
// executed. The pages now follow what the executors do: discovery shows
// progress, its results and onboarding; AP commands offer only what can run;
// a firmware campaign is launched explicitly. A refusal shows the API reason.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: { GET: (...a: unknown[]) => mocks.get(...a), POST: (...a: unknown[]) => mocks.post(...a), PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

import { DiscoveryScanList } from '../DiscoveryScanList';
import { WirelessManagementPage } from '../WirelessManagementPage';
import { CpeManagementPage } from '../CpeManagementPage';

const ok = (data: unknown) => Promise.resolve({ data, error: undefined });
const fail = (code: string, message: string) => Promise.resolve({ data: undefined, error: { error: { code, message } } });

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('discovery scans', () => {
  const scan = { id: 4, name: 'POP 1', cidr_ranges: '["192.168.5.0/29"]', snmp_version: 'v2c', snmp_port: 161, status: 'running', total_hosts: 6, scanned_hosts: 3, discovered_hosts: 1, created_at: '2026-11-03T00:00:00Z' };
  const result = { id: 9, ip_address: '192.168.5.1', hostname: 'pop-1', manufacturer: 'MikroTik', model: 'RB4011', device_type: 'router', status: 'pending_review' };

  beforeEach(() => {
    mocks.get.mockImplementation((path: string) => (path === '/discovery-scans/{id}/results'
      ? ok({ data: [result] })
      : ok({ data: [scan], meta: { total: 1, page: 1, limit: 25 } })));
    mocks.post.mockImplementation(() => ok({ data: {} }));
  });

  it('shows progress, cancels a running scan and onboards a result', async () => {
    wrap(<DiscoveryScanList />);
    expect(await screen.findByText('3 / 6')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/discovery-scans/{id}/cancel', { params: { path: { id: 4 } } }));

    fireEvent.click(screen.getByRole('button', { name: 'Results' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('MikroTik RB4011')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Onboard' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      '/discovery-scans/{id}/results/{resultId}/onboard', { params: { path: { id: 4, resultId: 9 } } },
    ));
  });
});

describe('AP commands', () => {
  beforeEach(() => {
    mocks.get.mockImplementation((path: string) => ok(path === '/devices'
      ? { data: [{ id: 3, name: 'AP-1' }], meta: { total: 1 } }
      : { data: [], meta: { total: 0 } }));
  });

  it('offers only reboot, the command a driver can run, and shows a refusal', async () => {
    mocks.post.mockImplementation(() => fail('VALIDATION_ERROR', 'This device has no active router driver config that can run this command'));
    wrap(<WirelessManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'AP Commands' }));
    fireEvent.click(await screen.findByRole('button', { name: /New Command/ }));

    const type = screen.getByRole('combobox', { name: /Command Type/i }) as HTMLSelectElement;
    expect([...type.options].map(o => o.value)).toEqual(['reboot']);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This device has no active router driver config that can run this command')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith('/wireless/ap-commands', { body: expect.objectContaining({ command_type: 'reboot' }) });
  });
});

describe('firmware campaigns', () => {
  const campaign = { id: 5, name: 'HG8245H V5', firmware_version_id: 2, status: 'scheduled', scheduled_at: null, total_devices: 0, completed_devices: 0, failed_devices: 0 };

  it('launches a scheduled campaign and shows why a launch was refused', async () => {
    mocks.get.mockImplementation(() => ok({ data: [campaign], meta: { total: 1, page: 1, limit: 25 } }));
    mocks.post.mockImplementation(() => fail('VALIDATION_ERROR', "No CPE of this organization matches the campaign's targets"));
    wrap(<CpeManagementPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Campaigns' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/cpe-management/firmware-campaigns/{id}/launch', { params: { path: { id: 5 } } }));
    expect(await screen.findByRole('alert')).toHaveTextContent("No CPE of this organization matches the campaign's targets");
  });
});
