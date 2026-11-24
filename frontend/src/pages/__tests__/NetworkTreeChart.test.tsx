// The network tree drawn as a chart: where the boxes go, which branches start
// open, and that lines take the colour of their health.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NetworkTreeTab } from '../topology/NetworkTreeTab';
import { NetworkTreeChart } from '../topology/NetworkTreeChart';
import { BOX, countBelow, edgePath, layout, openByDefault } from '../topology/treeChart';
import type { TreeNode } from '../topology/networkTree';

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'staff', permissions: ['devices.update'] } }) }));
vi.mock('@/auth/permissions', () => ({ can: () => true }));
const apiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const node = (id: number, name: string, type: string, children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({
  id, name, type, status: 'online', ip_address: null, site_id: 1, site_name: 'Tower', latitude: null, longitude: null, parent_id: null, children, ...extra,
});
const small = () => node(1, 'Core', 'router', [
  node(2, 'PtP north', 'ptp', [node(4, 'Sector 1', 'ptmp_ap'), node(5, 'Sector 2', 'ptmp_ap')]),
  node(3, 'Switch', 'switch', [node(6, 'OLT 1', 'olt')]),
], { kind: 'nas', nas_id: 1, is_main: true });
// 3 towers of 20 sectors each: 64 boxes, more than open at once.
const large = () => node(1, 'Core', 'router', [100, 200, 300].map(base => node(base, `Tower ${base}`, 'ptp',
  Array.from({ length: 20 }, (_, i) => node(base + i + 1, `Sector ${base + i + 1}`, 'ptmp_ap')))), { kind: 'nas', nas_id: 1, is_main: true });

let health: { checked_at: string; limits: Record<string, number>; nodes: Record<string, unknown> };
let trees: TreeNode[];
const good = { state: 'good', reasons: [] };
const boxes = (c: HTMLElement) => [...c.querySelectorAll('[data-box]')].map(el => el.getAttribute('data-box'));

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
  trees = [small()];
  health = { checked_at: '2026-01-01T00:00:00Z', limits: {}, nodes: {} };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/topology/health') return { data: health };
    if (path === '/topology/health/limits') return { data: { limits: {}, ranges: {} } };
    return { data: { trees, unplaced: [], sites: [] } };
  });
});

describe('chart layout', () => {
  it('puts each level in its own column and a parent beside the middle of what it feeds', () => {
    const placed = layout(small(), () => true);
    const at = (id: number) => placed.items.find(i => i.node.id === id)!;
    const step = BOX.height + BOX.gapY;
    expect([at(1).x, at(2).x, at(4).x]).toEqual([0, BOX.width + BOX.gapX, 2 * (BOX.width + BOX.gapX)]);
    expect([at(4).y, at(5).y, at(6).y]).toEqual([0, step, 2 * step]);
    expect(at(2).y).toBe(step / 2);
    expect(at(3).y).toBe(2 * step);
    expect(at(1).y).toBe((at(2).y + at(3).y) / 2);
    expect(placed.height).toBe(3 * step - BOX.gapY);
    expect(placed.width).toBe(2 * (BOX.width + BOX.gapX) + BOX.width);
  });

  it('a closed branch takes one row and still says how many are under it', () => {
    const placed = layout(small(), n => n.id !== 2);
    expect(placed.items.map(i => i.node.id)).toEqual([1, 2, 3, 6]);
    const ptp = placed.items.find(i => i.node.id === 2)!;
    expect([ptp.open, ptp.below]).toEqual([false, 2]);
    expect(countBelow(small())).toBe(5);
  });

  it('a line leaves the right of the parent and enters the left of the child', () => {
    const placed = layout(small(), () => true);
    const sector = placed.items.find(i => i.node.id === 5)!;
    const path = edgePath(sector);
    expect(path.startsWith(`M ${sector.parent!.x + BOX.width} ${sector.parent!.y + BOX.height / 2}`)).toBe(true);
    expect(path.endsWith(`${sector.x} ${sector.y + BOX.height / 2}`)).toBe(true);
    expect(edgePath(placed.items[0])).toBe('');
  });

  it('opens everything in a small tree', () => {
    expect([...openByDefault(small(), () => false)].sort()).toEqual([1, 2, 3]);
  });

  it('in a large tree opens only the main NAS and the way to a problem', () => {
    expect([...openByDefault(large(), () => false)]).toEqual([1]);
    expect([...openByDefault(large(), n => n.id === 207)].sort()).toEqual([1, 200]);
  });
});

describe('Tree chart', () => {
  it('draws every piece as a box and colours each line by its health', async () => {
    health.nodes = {
      2: { equipment: good, uplink: { state: 'degraded', reasons: [{ code: 'capacity_live', value: 95, limit: 90 }] } },
      3: { equipment: good, uplink: good },
      6: { equipment: { state: 'off', reasons: [{ code: 'offline' }] }, uplink: { state: 'off', reasons: [{ code: 'offline' }] } },
    };
    const { container } = show(<NetworkTreeChart trees={trees} />);
    await waitFor(() => expect(container.querySelector('[data-to="6"]')?.getAttribute('data-line')).toBe('off'));
    expect(boxes(container)).toEqual(['1', '2', '4', '5', '3', '6']);
    const line = (id: number) => container.querySelector(`[data-to="${id}"]`)!;
    expect(line(2).getAttribute('stroke')).toBe('#eab308');
    expect(line(3).getAttribute('stroke')).toBe('#16a34a');
    expect(line(6).getAttribute('stroke')).toBe('#dc2626');
    expect(line(4).getAttribute('stroke')).toBe('#9ca3af');
    expect(container.querySelector('[data-to="1"]')).toBeNull();
  });

  it('closes and opens a branch', async () => {
    const { container } = show(<NetworkTreeChart trees={trees} />);
    const toggle = container.querySelector('[data-toggle="2"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(boxes(container)).toEqual(['1', '2', '3', '6']);
    expect(container.querySelector('[data-toggle="2"]')!.textContent).toBe('+2');
    fireEvent.keyDown(container.querySelector('[data-toggle="2"]')!, { key: 'Enter' });
    expect(boxes(container)).toContain('4');
  });

  it('starts a large tree closed, except the branch with a problem', async () => {
    trees = [large()];
    health.nodes = { 207: { equipment: { state: 'degraded', reasons: [{ code: 'airtime', value: 91, limit: 80 }] }, uplink: null } };
    const { container } = show(<NetworkTreeChart trees={trees} />);
    expect(boxes(container)).toEqual(['1', '100', '200', '300']);
    await waitFor(() => expect(boxes(container)).toContain('207'));
    expect(boxes(container)).toHaveLength(24);
    expect(boxes(container)).not.toContain('101');
    expect(container.querySelector('[data-toggle="100"]')!.textContent).toBe('+20');
  });

  it('shows what is wrong with a piece when its box is clicked', async () => {
    health.nodes = { 6: { equipment: good, uplink: { state: 'off', reasons: [{ code: 'offline' }] } } };
    const { container } = show(<NetworkTreeChart trees={trees} />);
    await waitFor(() => expect(container.querySelector('[data-to="6"]')?.getAttribute('data-line')).toBe('off'));
    fireEvent.click(container.querySelector('[data-box="6"]')!);
    const panel = screen.getByRole('status');
    expect(panel.textContent).toContain('OLT 1');
    expect(panel.textContent).toContain('Fed by Switch');
    expect(panel.textContent).toContain('Line to what feeds it: Off');
    fireEvent.click(container.querySelector('[data-box="6"]')!);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('zooms in steps', () => {
    const { container } = show(<NetworkTreeChart trees={trees} />);
    const width = () => Number(container.querySelector('svg')!.getAttribute('width'));
    const before = width();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(width()).toBeCloseTo(before * 0.8);
  });
});

describe('Tree tab view switch', () => {
  it('switches between the list and the chart and remembers the choice', async () => {
    const first = show(<NetworkTreeTab />);
    const chartButton = await screen.findByRole('button', { name: 'Chart' });
    expect(first.container.querySelector('svg[role="group"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Move…' }).length).toBeGreaterThan(0);
    fireEvent.click(chartButton);
    expect(first.container.querySelector('[data-box="1"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Move…' })).toBeNull();
    expect(window.localStorage.getItem('vigabss.networkTree.view')).toBe('chart');
    first.unmount();
    const again = show(<NetworkTreeTab />);
    await waitFor(() => expect(again.container.querySelector('[data-box="1"]')).not.toBeNull());
  });
});
