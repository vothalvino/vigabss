// =============================================================================
// Reseller pickers load every reseller, not just the first page of 100
// =============================================================================
// fetchAllResellers pages through GET /resellers (100 rows a page, the server
// cap) by meta.total, stops at MAX_PICKER_RESELLERS and says when it cut the
// list. The reseller app (/punto) and the carrier app (/ruta) must never call
// the staff /resellers list.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import i18n from '@/i18n';
import {
  MAX_PICKER_RESELLERS, RESELLER_PAGE_LIMIT, ResellerListNotice, fetchAllResellers, useResellerOptions,
} from '../resellers/resellerOptions';

// Filling a picker past the 5,000 cap pages 51 times and renders 5,000
// options, which takes several seconds on CI with coverage on.
const CUT_LIST_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));

/** A server with `count` resellers (ids 1..count) serving pages of at most `cap` rows. */
function serve(count: number, { withTotal = true, cap = RESELLER_PAGE_LIMIT } = {}) {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://example.com');
    if (url.pathname !== '/resellers') throw new Error(`unexpected ${path}`);
    const page = Number(url.searchParams.get('page'));
    const limit = Math.min(Number(url.searchParams.get('limit')), cap);
    const from = (page - 1) * limit;
    const data = Array.from({ length: Math.max(0, Math.min(limit, count - from)) }, (_, i) => ({
      id: from + i + 1, name: `Punto ${String(from + i + 1).padStart(4, '0')}`, parent_id: null, balance: '0.00',
    }));
    return withTotal ? { data, meta: { total: count, page, limit } } : { data };
  });
}
const pagesAsked = () => mocks.apiFetch.mock.calls.map(([p]) => new URL(String(p), 'http://example.com').searchParams.get('page'));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
});

describe('fetchAllResellers', () => {
  it('reads 230 resellers over 3 pages of 100, every one once and in order', async () => {
    serve(230);
    const list = await fetchAllResellers();
    expect(list.rows).toHaveLength(230);
    expect(list.rows.map(r => r.id)).toEqual(Array.from({ length: 230 }, (_, i) => i + 1));
    expect(list.rows[229]).toEqual({ id: 230, name: 'Punto 0230', parent_id: null });
    expect(list).toMatchObject({ total: 230, truncated: false });
    expect(pagesAsked().sort()).toEqual(['1', '2', '3']);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers?page=2&limit=100');
  });

  it('exactly 100 is one page', async () => {
    serve(100);
    const list = await fetchAllResellers();
    expect(list.rows).toHaveLength(100);
    expect(list.truncated).toBe(false);
    expect(pagesAsked()).toEqual(['1']);
  });

  it('0 resellers is one empty page', async () => {
    serve(0);
    expect(await fetchAllResellers()).toEqual({ rows: [], total: 0, truncated: false });
    expect(pagesAsked()).toEqual(['1']);
  });

  it('asks only for top-level resellers when told to', async () => {
    serve(150);
    await fetchAllResellers({ topLevel: true });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers?parent_id=null&page=1&limit=100');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers?parent_id=null&page=2&limit=100');
  });

  it(`stops at ${MAX_PICKER_RESELLERS} and says the list was cut`, async () => {
    serve(MAX_PICKER_RESELLERS + 250);
    const list = await fetchAllResellers();
    expect(list.rows).toHaveLength(MAX_PICKER_RESELLERS);
    expect(list).toMatchObject({ total: MAX_PICKER_RESELLERS + 250, truncated: true });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(MAX_PICKER_RESELLERS / RESELLER_PAGE_LIMIT);
  });

  it('without meta.total, keeps reading while pages come back full', async () => {
    serve(230, { withTotal: false });
    const list = await fetchAllResellers();
    expect(list.rows).toHaveLength(230);
    expect(list.truncated).toBe(false);
    expect(pagesAsked()).toEqual(['1', '2', '3']);
  });

  it('a reseller seen on two pages (the list moved while paging) appears once', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      const page = new URL(path, 'http://example.com').searchParams.get('page');
      const ids = page === '1' ? Array.from({ length: 100 }, (_, i) => i + 1) : [100, 101];
      return { data: ids.map(id => ({ id, name: `R${id}` })), meta: { total: 102 } };
    });
    const list = await fetchAllResellers();
    expect(list.rows.map(r => r.id)).toEqual(Array.from({ length: 101 }, (_, i) => i + 1));
  });

  it('a refused list (no resellers.view) is an error for the picker to handle', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('Forbidden'));
    await expect(fetchAllResellers()).rejects.toThrow('Forbidden');
  });
});

describe('a picker built on useResellerOptions', () => {
  function Picker() {
    const q = useResellerOptions();
    return (
      <label>
        Reseller
        <select>{(q.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <ResellerListNotice list={q.data} />
      </label>
    );
  }
  const renderPicker = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Picker /></QueryClientProvider>,
  );

  it('offers the 230th reseller, and shows no notice', async () => {
    serve(230);
    renderPicker();
    expect(await screen.findByRole('option', { name: 'Punto 0230' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(230);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('says when the list is cut', async () => {
    serve(MAX_PICKER_RESELLERS + 1);
    renderPicker();
    expect(await screen.findByRole('note', {}, { timeout: CUT_LIST_TIMEOUT_MS - 5_000 })).toHaveTextContent(`Showing the first ${MAX_PICKER_RESELLERS} of ${MAX_PICKER_RESELLERS + 1} resellers.`);
  }, CUT_LIST_TIMEOUT_MS);
});

describe('the reseller and carrier apps never call the staff reseller list', () => {
  const PAGES = resolve(__dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

  it.each(['punto', 'ruta'])('pages/%s', (app) => {
    const offenders = files(join(PAGES, app)).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return /resellerOptions|['`"]\/resellers[?/'`"]/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
