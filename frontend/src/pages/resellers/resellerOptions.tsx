// =============================================================================
// Every reseller for a staff picker or filter (GET /resellers, page by page)
// =============================================================================
// The reseller drop-downs asked for GET /resellers?limit=100, and the server
// caps a page at 100 rows, so an ISP with more resellers could not pick the
// rest. fetchAllResellers reads the first page, takes meta.total and fetches
// the other pages a few at a time, up to MAX_PICKER_RESELLERS; past that the
// list is cut and ResellerListNotice says so. It goes through the same
// GET /resellers as the reseller list, with the same permission
// (resellers.view) and the same server-side reseller scope, so no role sees
// more than it did. Staff pages only: the reseller app (/punto) and the
// carrier app (/ruta) never call /resellers (__tests__/resellerOptions.test.tsx).
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';

/** The largest page GET /resellers serves (src/routes/resellers.js). */
export const RESELLER_PAGE_LIMIT = 100;
/** Where a picker stops loading; a longer list is cut with a notice. */
export const MAX_PICKER_RESELLERS = 5000;
/** Pages fetched at the same time after the first. */
const PARALLEL_PAGES = 4;

export interface ResellerOption {
  id: number;
  name: string;
  parent_id: number | null;
  /** 'collector' (migration 011): a point that only takes payments; it owns no clients, leads or sub-resellers. */
  kind: 'reseller' | 'collector';
}

/** The pickers of things only a reseller has (a parent, commissions, allowed plans, leads). */
export const resellersOnly = (rows: ResellerOption[]) => rows.filter(r => r.kind !== 'collector');
export interface ResellerOptionList {
  rows: ResellerOption[];
  /** How many resellers the server has (meta.total), even past the cap. */
  total: number;
  /** True when rows stops short of total (more than MAX_PICKER_RESELLERS). */
  truncated: boolean;
}

/** Query keys; ResellerPage invalidates both when a reseller is saved. */
export const resellerOptionKeys = {
  all: ['resellers-options'] as const,
  topLevel: ['resellers-top-level'] as const,
};

interface ResellerPage { data?: unknown; meta?: { total?: number | string | null } }

function toOption(raw: unknown): ResellerOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = Number(r.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const parent = r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id);
  return { id, name: String(r.name ?? ''), parent_id: Number.isInteger(parent) ? parent : null, kind: r.kind === 'collector' ? 'collector' : 'reseller' };
}

const rowsOf = (page: ResellerPage | null | undefined): unknown[] => (Array.isArray(page?.data) ? page.data : []);

/** One page of GET /resellers (all, or only top-level ones). */
function fetchPage(page: number, topLevel: boolean): Promise<ResellerPage> {
  const query = `${topLevel ? 'parent_id=null&' : ''}page=${page}&limit=${RESELLER_PAGE_LIMIT}`;
  return apiFetch<ResellerPage>(`/resellers?${query}`);
}

/**
 * Every reseller the caller may see, in the server's order (top-level first,
 * then by name), or only top-level ones (`topLevel`: the cash ledger, bags
 * and allowed plans belong to them).
 */
export async function fetchAllResellers(
  { topLevel = false, cap = MAX_PICKER_RESELLERS }: { topLevel?: boolean; cap?: number } = {},
): Promise<ResellerOptionList> {
  const byId = new Map<number, ResellerOption>();
  const add = (page: ResellerPage | null | undefined) => {
    for (const raw of rowsOf(page)) {
      const option = toOption(raw);
      if (option && !byId.has(option.id) && byId.size < cap) byId.set(option.id, option);
    }
  };
  const maxPages = Math.max(1, Math.ceil(cap / RESELLER_PAGE_LIMIT));

  const first = await fetchPage(1, topLevel);
  add(first);
  const reported = Number(first?.meta?.total);
  const knownTotal = first?.meta?.total !== undefined && first?.meta?.total !== null && Number.isFinite(reported) && reported >= 0;
  let fullLastPage = rowsOf(first).length >= RESELLER_PAGE_LIMIT;

  if (knownTotal) {
    const pages = Math.min(Math.ceil(reported / RESELLER_PAGE_LIMIT), maxPages);
    for (let start = 2; start <= pages; start += PARALLEL_PAGES) {
      const batch: Promise<ResellerPage>[] = [];
      for (let p = start; p < start + PARALLEL_PAGES && p <= pages; p++) batch.push(fetchPage(p, topLevel));
      (await Promise.all(batch)).forEach(add);
    }
  } else {
    // A server without meta.total: keep reading while pages come back full.
    for (let p = 2; fullLastPage && p <= maxPages; p++) {
      const page = await fetchPage(p, topLevel);
      add(page);
      fullLastPage = rowsOf(page).length >= RESELLER_PAGE_LIMIT;
    }
  }

  const rows = [...byId.values()];
  const total = knownTotal ? Math.max(reported, rows.length) : rows.length;
  const truncated = knownTotal ? total > rows.length : (fullLastPage && rows.length >= cap);
  return { rows, total, truncated };
}

/** The cached list for a picker; `enabled: false` without resellers.view. */
export function useResellerOptions({ topLevel = false, enabled = true }: { topLevel?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: topLevel ? resellerOptionKeys.topLevel : resellerOptionKeys.all,
    queryFn: () => fetchAllResellers({ topLevel }),
    enabled,
    staleTime: 60_000,
  });
}

/** Says the list was cut at MAX_PICKER_RESELLERS; nothing otherwise. */
export function ResellerListNotice({ list }: { list?: ResellerOptionList | null }) {
  const { t } = useTranslation();
  if (!list?.truncated) return null;
  return (
    <p role="note" style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--warning)' }}>
      {t('resellerOptions.truncated', { shown: list.rows.length, total: list.total })}
    </p>
  );
}
