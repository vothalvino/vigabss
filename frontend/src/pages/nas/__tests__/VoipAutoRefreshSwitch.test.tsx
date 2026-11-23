// The weekly VoIP range refresh was switched on by an environment variable on
// the server. It is a switch in the app now: the install operator changes it,
// everyone else who can see NAS devices sees its state.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...a: unknown[]) => mocks.apiFetch(...a) }));

import { VoipAutoRefreshSwitch } from '../VoipAutoRefreshSwitch';

const state = (over: Record<string, unknown> = {}) => ({ data: { available: true, enabled: false, last_run_at: null, last_status: null, can_change: true, ...over } });
const renderSwitch = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VoipAutoRefreshSwitch />
  </QueryClientProvider>,
);

describe('weekly VoIP refresh switch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('the install operator switches it on, and the new state is shown', async () => {
    mocks.apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => (init?.method === 'PUT' ? state({ enabled: true }) : state()));
    const user = userEvent.setup();
    renderSwitch();
    const box = await screen.findByRole('checkbox', { name: 'Refresh VoIP ranges every week' });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(mocks.apiFetch).toHaveBeenCalledWith('/nas/voip/auto-refresh', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  });

  it('anyone else sees the state but cannot change it', async () => {
    mocks.apiFetch.mockResolvedValue(state({ enabled: true, can_change: false }));
    renderSwitch();
    const box = await screen.findByRole('checkbox', { name: 'Refresh VoIP ranges every week' });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByText(/Only the install operator can change this/)).toBeInTheDocument();
  });

  it('is not shown on a server without the task', async () => {
    mocks.apiFetch.mockResolvedValue(state({ available: false }));
    const { container } = renderSwitch();
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('is on the NAS list, and a NAS has the way back from VoIP priority', () => {
    const pages = resolve(__dirname, '..', '..');
    expect(readFileSync(resolve(pages, 'NasList.tsx'), 'utf8')).toMatch(/<VoipAutoRefreshSwitch \/>/);
    const detail = readFileSync(resolve(pages, 'NasDetail.tsx'), 'utf8');
    expect(detail).toMatch(/api\.DELETE\('\/nas\/\{id\}\/realtime-priority'/);
    // Removal is asked about first.
    expect(detail).toMatch(/message=\{t\('nasVoip\.removeConfirm'\)\}/);
  });
});
