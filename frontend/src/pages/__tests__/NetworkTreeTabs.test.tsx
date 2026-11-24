// The network as a simple tree (one per main NAS), and one site's equipment
// on a map.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkTreeTab } from '../topology/NetworkTreeTab';
import { NetworkMapTab } from '../topology/NetworkMapTab';
import { branchIds, flatten, type TreeNode } from '../topology/networkTree';

let permissions = ['devices.update'];
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'staff', permissions } }) }));
vi.mock('@/auth/permissions', () => ({ can: (_u: unknown, p: string) => permissions.includes(p) }));

const apiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/MapTiles', () => ({ MapTiles: () => null }));

let mapClick: ((e: { latlng: { lat: number; lng: number } }) => void) | null = null;
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="map">{children}</div>,
  useMapEvents: (h: { click?: (e: { latlng: { lat: number; lng: number } }) => void }) => { mapClick = h.click ?? null; return null; },
  CircleMarker: ({ children, eventHandlers }: { children?: React.ReactNode; eventHandlers?: { click?: () => void } }) => (
    <div data-testid="marker" onClick={eventHandlers?.click}>{children}</div>
  ),
  // Like react-leaflet, only pathOptions is read: a bare `color` prop is ignored
  // after the line is first drawn.
  Polyline: ({ pathOptions }: { pathOptions?: { color?: string } }) => <div data-testid="line" data-color={pathOptions?.color ?? 'none'} />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const node = (id: number | string, name: string, type: string, extra: Partial<TreeNode> = {}): TreeNode => ({
  id, name, type, status: 'online', ip_address: null, site_id: 1, site_name: 'Tower', latitude: null, longitude: null, parent_id: null, children: [], ...extra,
});

function tree() {
  const olt = node(12, 'OLT 1', 'olt', { parent_id: 11 });
  const ptp = node(11, 'PtP north', 'ptp', { parent_id: 10, children: [olt], latitude: 19.4002, longitude: -99.1002 });
  const coreA = node(10, 'Core A', 'router', { kind: 'nas', nas_id: 1, is_main: true, make: 'mikrotik', children: [ptp], latitude: 19.4001, longitude: -99.1001 });
  const coreB = node(20, 'Core B', 'router', { kind: 'nas', nas_id: 2, is_main: true, site_id: 2, site_name: 'POP', children: [node(21, 'Switch B', 'switch', { parent_id: 20, site_id: 2 })] });
  return {
    trees: [coreA, coreB],
    unplaced: [node('nas-3', 'New NAS', 'router', { kind: 'nas', nas_id: 3, is_main: false, status: null }), node(30, 'Battery', 'battery_monitor')],
    sites: [{ id: 1, name: 'Tower', latitude: 19.4, longitude: -99.1 }, { id: 2, name: 'POP', latitude: null, longitude: null }],
  };
}

let health: { checked_at: string; limits: Record<string, number>; nodes: Record<string, unknown> };

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  permissions = ['devices.update'];
  apiFetch.mockReset();
  health = { checked_at: '2026-01-01T00:00:00Z', limits: {}, nodes: {} };
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method) return { data: {} };
    if (path === '/topology/health') return { data: health };
    if (path === '/topology/health/limits') return { data: { limits: { airtime_pct: 80, cpu_pct: 85 }, ranges: { airtime_pct: { default: 80, min: 10, max: 100 }, cpu_pct: { default: 85, min: 10, max: 100 } } } };
    if (path.endsWith('/ports')) return { data: { uplink_interface: null, uplink_capacity_mbps: null, ports: [{ interface: '3', up: true, rate_mbps: 412.5 }, { interface: '4', up: false, rate_mbps: null }] } };
    return { data: tree() };
  });
});

describe('tree helpers', () => {
  it('a branch is the node and everything under it', () => {
    const t = tree();
    expect([...branchIds(t.trees[0])]).toEqual([10, 11, 12]);
    expect(flatten(t.trees).map(n => n.id)).toEqual([10, 11, 12, 20, 21]);
  });
});

describe('Tree tab', () => {
  it('shows one tree per main NAS with its branches, and what is not placed', async () => {
    show(<NetworkTreeTab />);
    const a = await screen.findByRole('region', { name: 'Core A' });
    expect(within(a).getByText('PtP north')).toBeInTheDocument();
    expect(within(a).getByText('OLT 1')).toBeInTheDocument();
    expect(within(a).queryByText('Switch B')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Core B' })).getByText('Switch B')).toBeInTheDocument();
    expect(screen.getByText('Not placed yet (2)')).toBeInTheDocument();
    expect(screen.getByText('Battery')).toBeInTheDocument();
  });

  it('with several networks, one can be chosen', async () => {
    show(<NetworkTreeTab />);
    fireEvent.change(await screen.findByLabelText('Network'), { target: { value: '20' } });
    expect(screen.queryByRole('region', { name: 'Core A' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Core B' })).toBeInTheDocument();
  });

  it('places unplaced equipment under a parent', async () => {
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('Battery')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Place under…' }));
    fireEvent.change(within(row).getByLabelText('Place Battery under'), { target: { value: '11' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/topology/tree/parent', { method: 'PUT', body: JSON.stringify({ node: 30, parent: 11 }) }));
  });

  it('moving never offers the equipment itself or what hangs from it', async () => {
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('PtP north')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button', { name: 'Move…' })[0]);
    const options = within(within(row).getByLabelText('Place PtP north under')).getAllByRole('option').map(o => o.getAttribute('value'));
    expect(options).toEqual(['', '10', '20', '21']);
  });

  it('marks a NAS as main, and a main NAS can be unmarked but not moved', async () => {
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('New NAS')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Make main NAS' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/topology/tree/main-nas/3', { method: 'PUT', body: JSON.stringify({ main: true }) }));
    const head = within(screen.getByRole('region', { name: 'Core B' })).getByText('Core B').parentElement as HTMLElement;
    expect(within(head).getByRole('button', { name: 'Not a main NAS' })).toBeInTheDocument();
    expect(within(head).queryByRole('button', { name: 'Move…' })).toBeNull();
  });

  it('is read-only without permission to change devices', async () => {
    permissions = [];
    show(<NetworkTreeTab />);
    await screen.findByText('Battery');
    expect(screen.queryByRole('button', { name: 'Place under…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make main NAS' })).toBeNull();
  });

  it('says how to start when no NAS is main', async () => {
    apiFetch.mockResolvedValue({ data: { trees: [], unplaced: [], sites: [] } });
    show(<NetworkTreeTab />);
    expect(await screen.findByText(/No NAS is marked as main yet/)).toBeInTheDocument();
  });
});

describe('health colours on the tree', () => {
  const sick = () => {
    health.nodes = {
      10: { equipment: { state: 'good', reasons: [] }, uplink: null },
      11: { equipment: { state: 'good', reasons: [] }, uplink: { state: 'degraded', reasons: [{ code: 'airtime', value: 87, limit: 80 }] } },
      12: { equipment: { state: 'degraded', reasons: [{ code: 'cpu', value: 97, limit: 85 }] }, uplink: { state: 'off', reasons: [{ code: 'port_down' }] } },
    };
  };

  it('each line carries its state, and what is wrong is written out, not only coloured', async () => {
    sick();
    show(<NetworkTreeTab />);
    const ptp = (await screen.findByText('PtP north')).closest('li') as HTMLElement;
    await waitFor(() => expect(ptp.getAttribute('data-line')).toBe('degraded'));
    expect(within(ptp).getByText('Line to what feeds it: Degraded: airtime 87% (limit 80%)')).toBeInTheDocument();
    const olt = screen.getByText('OLT 1').closest('li') as HTMLElement;
    expect(olt.getAttribute('data-line')).toBe('off');
    expect(within(olt).getByText('Line to what feeds it: Off: the port is down')).toBeInTheDocument();
    expect(within(olt).getByText('Equipment: Degraded: CPU 97% (limit 85%)')).toBeInTheDocument();
    expect(within(olt).getByRole('img', { name: 'Equipment: Degraded: CPU 97% (limit 85%)' })).toBeInTheDocument();
  });

  it('a saturated sector says what it carries against what it can carry now, and who carries the most', async () => {
    health.nodes = { 21: {
      equipment: { state: 'degraded', reasons: [{ code: 'capacity_live', value: 94.4, limit: 85, mbps: 85, capacity_mbps: 90 }], top_clients: [{ device_id: 72, name: 'CPE Luis', mbps: 60 }, { device_id: 71, name: 'CPE Ana', mbps: 20 }] },
      uplink: { state: 'good', reasons: [] },
    } };
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('Switch B')).closest('li') as HTMLElement;
    expect(await within(row).findByText('Equipment: Degraded: traffic 85 Mbps is 94.4% of the 90 Mbps the radio can carry right now (limit 85%)')).toBeInTheDocument();
    expect(within(row).getByText('Carrying the most right now: CPE Luis 60 Mbps, CPE Ana 20 Mbps')).toBeInTheDocument();
    expect(row.getAttribute('data-line')).toBe('good');
  });

  it('equipment that is not measured is grey, never green', async () => {
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('Switch B')).closest('li') as HTMLElement;
    expect(row.getAttribute('data-line')).toBe('unknown');
    expect(within(row).getByRole('img', { name: 'Equipment: Not measured' })).toBeInTheDocument();
  });

  it('the tree still shows when health cannot be read', async () => {
    apiFetch.mockImplementation(async (path: string) => { if (path === '/topology/health') throw new Error('down'); return { data: tree() }; });
    show(<NetworkTreeTab />);
    expect(await screen.findByText('PtP north')).toBeInTheDocument();
  });

  it('the port facing the parent and the capacity are chosen per line', async () => {
    show(<NetworkTreeTab />);
    const row = (await screen.findByText('PtP north')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button', { name: 'Line…' })[0]);
    const form = await screen.findByRole('form', { name: 'Line from PtP north to what feeds it' });
    expect(within(form).getByRole('option', { name: 'Port 3 · 412.5 Mbps' })).toBeInTheDocument();
    expect(within(form).getByRole('option', { name: 'Port 4 · down' })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Port facing what feeds it'), { target: { value: '3' } });
    fireEvent.change(within(form).getByLabelText('Capacity (Mbps)'), { target: { value: '1000' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/topology/health/devices/11/uplink', {
      method: 'PUT', body: JSON.stringify({ uplink_interface: '3', uplink_capacity_mbps: 1000 }),
    }));
  });

  it('limits are changed by someone who may change settings; only what changed is sent', async () => {
    permissions = ['devices.update', 'settings.update'];
    show(<NetworkTreeTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Limits for the colours' }));
    const form = await screen.findByRole('form', { name: 'Limits for the colours' });
    fireEvent.change(within(form).getByLabelText('Airtime in use, % (at or above)'), { target: { value: '65' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/topology/health/limits', { method: 'PUT', body: JSON.stringify({ airtime_pct: 65 }) }));
  });

  it('without that permission the limits are shown but cannot be changed', async () => {
    show(<NetworkTreeTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Limits for the colours' }));
    const form = await screen.findByRole('form', { name: 'Limits for the colours' });
    expect(within(form).getByLabelText('CPU, % (at or above)')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Save limits' })).toBeNull();
  });
});

describe('Network map tab: one map per main NAS', () => {
  it('shows the chosen main NAS\'s tree only, with a line to what feeds each piece', async () => {
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '10' } });
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    expect(screen.getAllByTestId('line')).toHaveLength(1);
    const pending = screen.getByRole('region', { name: 'Not on the map yet' });
    expect(within(pending).getByText('OLT 1')).toBeInTheDocument();
    // Another network's equipment and equipment not in any tree stay out.
    expect(screen.queryByText('Switch B')).toBeNull();
    expect(screen.queryByText('Battery')).toBeNull();
  });

  it('a line takes the colour of its health, also when the health arrives after the map is drawn', async () => {
    let release: (v: unknown) => void = () => {};
    const later = new Promise(r => { release = r; });
    const base = apiFetch.getMockImplementation() as (path: string, init?: RequestInit) => Promise<unknown>;
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/topology/health') { await later; return { data: { checked_at: 'x', limits: {}, nodes: { 11: { equipment: { state: 'good', reasons: [] }, uplink: { state: 'degraded', reasons: [{ code: 'airtime', value: 90, limit: 80 }] } } } } }; }
      return base(path, init);
    });
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '10' } });
    // Drawn before the health is known: grey.
    expect(screen.getByTestId('line').getAttribute('data-color')).toBe('#9ca3af');
    release(null);
    await waitFor(() => expect(screen.getByTestId('line').getAttribute('data-color')).toBe('#eab308'));
  });

  it('places equipment where the map is clicked', async () => {
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '10' } });
    const row = screen.getByText('OLT 1').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Place on the map' }));
    expect(screen.getByText(/Click the map where OLT 1 is/)).toBeInTheDocument();
    mapClick?.({ latlng: { lat: 19.40031234567, lng: -99.1003 } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/topology/tree/position', {
      method: 'PUT', body: JSON.stringify({ node: 12, latitude: 19.4003123, longitude: -99.1003 }),
    }));
  });

  it('a click on the map does nothing until something is being placed', async () => {
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '10' } });
    mapClick?.({ latlng: { lat: 1, lng: 1 } });
    expect(apiFetch.mock.calls.every(([, init]) => !init)).toBe(true);
  });

  it('a network with nothing placed says what to do', async () => {
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '20' } });
    expect(screen.getByText(/Nothing under Core B is on the map yet/)).toBeInTheDocument();
    expect(screen.queryAllByTestId('marker')).toHaveLength(0);
  });

  it('with one main NAS there is nothing to choose: its map opens directly', async () => {
    const one = tree();
    apiFetch.mockResolvedValue({ data: { ...one, trees: [one.trees[0]] } });
    show(<NetworkMapTab />);
    await waitFor(() => expect(screen.getAllByTestId('marker')).toHaveLength(2));
    expect(screen.queryByLabelText('Main NAS')).toBeNull();
  });

  it('without a main NAS, says where to mark one', async () => {
    apiFetch.mockResolvedValue({ data: { trees: [], unplaced: [], sites: [] } });
    show(<NetworkMapTab />);
    expect(await screen.findByText(/No NAS is marked as main yet/)).toBeInTheDocument();
  });

  it('is read-only without permission to change devices', async () => {
    permissions = [];
    show(<NetworkMapTab />);
    fireEvent.change(await screen.findByLabelText('Main NAS'), { target: { value: '10' } });
    expect(screen.queryByRole('button', { name: 'Place on the map' })).toBeNull();
  });
});
