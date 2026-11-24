// The connection check on a contract: every hop from the customer up to the
// main NAS, and where a fault is, in words.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContractNetworkPath, type NetworkPath } from '../ContractNetworkPath';

const apiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const good = { state: 'good' as const, reasons: [] };
function path(extra: Partial<NetworkPath> = {}): NetworkPath {
  return {
    technology: 'wisp',
    hops: [
      { role: 'customer', device_id: 70, name: 'CPE Ana', type: 'outdoor_cpe', equipment: good, line: good },
      { role: 'access', device_id: 40, name: 'Sector Norte', type: 'ptmp_ap', equipment: good, line: good },
      { role: 'network', device_id: 30, name: 'PtP Cerro', type: 'ptp', equipment: good, line: good },
      { role: 'network', device_id: 20, name: 'Core', type: 'router', is_main: true, equipment: good, line: null },
    ],
    saturation: null, findings: [], conclusion: { side: 'none', state: 'good' }, reaches_main_nas: true, gaps: [], checked_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}
function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ContractNetworkPath contractId={9} /></QueryClientProvider>);
}

beforeEach(() => { apiFetch.mockReset(); });

describe('Connection check', () => {
  it('runs only when asked', async () => {
    apiFetch.mockResolvedValue({ data: path() });
    show();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Everything measured on this path is good.');
    expect(apiFetch).toHaveBeenCalledWith('/contracts/9/network-path');
  });

  it('lists the hops from the customer up to the main NAS', async () => {
    apiFetch.mockResolvedValue({ data: path() });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    const list = await screen.findByRole('list', { name: 'The path, from the customer up' });
    expect(within(list).getAllByRole('listitem').map(li => li.querySelector('strong')?.textContent)).toEqual(['CPE Ana', 'Sector Norte', 'PtP Cerro', 'Core']);
    expect(within(list).getByText(/Network · Main NAS/)).toBeInTheDocument();
  });

  it('says where the fault is and what was measured', async () => {
    const reasons = [{ code: 'capacity_live', value: 93, limit: 85, mbps: 112, capacity_mbps: 120 }];
    apiFetch.mockResolvedValue({ data: path({
      conclusion: { side: 'backhaul', state: 'degraded' },
      findings: [{ side: 'backhaul', state: 'degraded', part: 'line', device_id: 30, name: 'PtP Cerro', reasons }],
    }) });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('status')).toHaveTextContent("The fault is in our network, above the customer's sector or OLT.");
    const found = screen.getByRole('list', { name: 'What was found' });
    expect(found).toHaveTextContent('PtP Cerro (line): Degraded: traffic 112 Mbps is 93% of the 120 Mbps the radio can carry right now (limit 85%)');
  });

  it('a full plan is said as such, with the usage', async () => {
    apiFetch.mockResolvedValue({ data: path({
      conclusion: { side: 'customer_plan', state: 'degraded' },
      saturation: { mbps: 48, plan_mbps: 50, pct: 96, full: true },
      findings: [{ side: 'customer_plan', state: 'degraded', part: 'plan', device_id: null, name: 'Hogar 50', reasons: [{ code: 'plan_full', value: 96, limit: 90, mbps: 48, plan_mbps: 50 }] }],
    }) });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing is failing: the customer is using all the speed of their plan.');
    expect(screen.getByText('Using 48 Mbps of a 50 Mbps plan (96%).')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'What was found' })).toHaveTextContent('Hogar 50 (plan): Degraded: using 48 Mbps of a 50 Mbps plan (96%)');
  });

  it('what could not be checked is listed, naming the equipment', async () => {
    apiFetch.mockResolvedValue({ data: path({ conclusion: { side: 'unknown', state: 'unknown' }, gaps: ['not_measured:30', 'path_stops_before_main_nas'] }) });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('PtP Cerro is not measured (no recent SNMP readings).')).toBeInTheDocument();
    expect(screen.getByText('The path does not reach a main NAS. Place the equipment in the network tree.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not enough of this path is measured to say.');
  });

  it('a failed check says so', async () => {
    apiFetch.mockRejectedValue(new Error('boom'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection could not be checked.');
  });
});
