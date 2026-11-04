// =============================================================================
// VigaBSS 5.0 — Service Area Viewer
// =============================================================================
// Read-only page at /service-areas. Lists the geographic service areas
// (planned / active / retired coverage footprints) with their status, map
// colour and primary site. The boundary is stored as a WGS-84 POLYGON and is
// drawn on the coverage map tooling, so this page is a visibility/list view and
// exposes no create/edit/delete actions.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { styles } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceArea {
  id: number;
  site_id: number | null;
  name: string;
  description: string | null;
  color: string | null;
  status: string;
}

interface ServiceAreaResponse {
  data: ServiceArea[];
  meta: { total: number; page: number; limit: number; totalPages?: number };
}

const DEFAULT_PAGE_SIZE = 50;
const STATUS_FILTER_OPTIONS = ['', 'planned', 'active', 'retired'];

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchServiceAreas(page: number, statusFilter: string): Promise<ServiceAreaResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/service-areas', { params: { query: query } });
  if (res.error) throw new Error('Failed to load service areas');
  return res.data as unknown as ServiceAreaResponse;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  active: { bg: '#d1fae5', color: '#065f46' },
  planned: { bg: '#dbeafe', color: '#1e40af' },
  retired: { bg: '#f3f4f6', color: '#374151' },
};

function ColorSwatch({ color }: { color: string | null }) {
  if (!color) return <span>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          width: 14,
          height: 14,
          borderRadius: 3,
          background: color,
          border: '1px solid var(--border-strong)',
        }}
      />
      <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{color}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ServiceAreaList component
// ---------------------------------------------------------------------------

export function ServiceAreaList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');

  const areasQ = useQuery({
    queryKey: ['service-areas', page, statusFilter],
    queryFn: () => fetchServiceAreas(page, statusFilter),
  });

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const areas = areasQ.data?.data ?? [];
  const meta = areasQ.data?.meta;
  const totalPages = meta?.totalPages ?? (meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.serviceAreaList.serviceAreas')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.serviceAreaList.total')}</span>}
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.serviceAreaList.status')}</label>
        <select
          style={styles.filterSelect}
          value={statusFilter}
          onChange={e => handleFilterChange(e.target.value)}
        >
          {STATUS_FILTER_OPTIONS.map(s => (
            <option key={s} value={s}>{s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}</option>
          ))}
        </select>
        {statusFilter && (
          <button type="button" style={styles.btnSecondary} onClick={() => handleFilterChange('')}>
            {t('ui.serviceAreaList.clearFilter')}
          </button>
        )}
      </div>

      <div style={styles.tableCard}>
        {areasQ.isLoading ? (
          <p style={styles.msg}>{t('ui.serviceAreaList.loading')}</p>
        ) : areasQ.error ? (
          <p style={styles.msgError}>{t('ui.serviceAreaList.failedToLoadServiceAreas')}</p>
        ) : areas.length === 0 ? (
          <p style={styles.msg}>{t('ui.serviceAreaList.noServiceAreasFound')}{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Name', 'Site', 'Colour', 'Status', 'Description'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {areas.map(a => (
                    <tr key={a.id} style={styles.tr}>
                      <td style={styles.td}>#{a.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>{a.name}</td>
                      <td style={styles.td}>{a.site_id != null ? `#${a.site_id}` : '—'}</td>
                      <td style={styles.td}><ColorSwatch color={a.color} /></td>
                      <td style={styles.td}><StatusBadge status={a.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, maxWidth: 320, overflowWrap: 'anywhere' }}>{a.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.serviceAreaList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.serviceAreaList.page')}{page} {t('ui.serviceAreaList.of')}{totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('ui.serviceAreaList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
