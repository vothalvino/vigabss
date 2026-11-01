// FE-09: /top-consumers SUM() totals reached the page as strings and the
// summary added them with `+`, so two consumers' downloads concatenated into
// a nonsense total. The API now returns numbers; the page adds numerically
// either way.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SessionAccounting } from '../SessionAccounting';

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const TOP = [
  { client_id: 1, contract_id: 1, username: 'a', active_days: 2, session_count: 2, bytes_in: '1073741824', bytes_out: '536870912', bytes_total: '1610612736', duration_seconds: '60' },
  { client_id: 2, contract_id: 2, username: 'b', active_days: 1, session_count: 1, bytes_in: '1073741824', bytes_out: '536870912', bytes_total: '1610612736', duration_seconds: '60' },
];

describe('SessionAccounting totals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => (String(input).includes('top-consumers')
      ? json({ data: TOP, meta: {} })
      : json({ data: [], meta: { total: 0 } })));
  });

  it('adds two consumers numerically', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><SessionAccounting /></MemoryRouter>
      </QueryClientProvider>,
    );
    const card = (label: string) => screen.getByText(label, { selector: 'div' }).previousElementSibling?.textContent;
    await screen.findByText('↓ Total Download');
    await vi.waitFor(() => expect(card('↓ Total Download')).toBe('2.000 GB'));
    expect(card('↑ Total Upload')).toBe('1.000 GB');
    expect(card('Combined Traffic')).toBe('3.000 GB');
    expect(card('Sessions')).toBe('3');
  });
});
