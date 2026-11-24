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
  Polyline: () => <div data-testid="line" />,
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

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  permissions = ['devices.update'];
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => (init?.method ? { data: {} } : { data: tree() }));
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
