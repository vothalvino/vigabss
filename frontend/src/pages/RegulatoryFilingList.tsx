// =============================================================================
// VigaBSS 5.0 — Regulatory Filing Viewer
// =============================================================================
// Read-only page at /regulatory-filings. Lists the IFT/CRT regulatory filings
// (annual reports, statistics, tariff registrations, coverage/QoS reports,
// spectrum usage) tracked for the organization, with their reporting period,
// submission timestamp, acknowledgement number and lifecycle status. This is a
// compliance visibility view and exposes no create/edit/delete actions.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { styles, capitalize, fmtDate } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegulatoryFiling {
  id: number;
  filing_type: string;
  period_start: string | null;
  period_end: string | null;
  filed_at: string | null;
  acknowledgement_number: string | null;
  status: string;
  notes: string | null;
}

interface FilingsResponse {
  data: RegulatoryFiling[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const DEFAULT_PAGE_SIZE = 50;
const STATUSES = ['pending', 'filed', 'accepted', 'rejected', 'overdue'];

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchFilings(page: number, status: string): Promise<FilingsResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (status) query.status = status;
  const res = await api.GET('/regulatory-filings', { params: { query: query } });
  if (res.error) throw new Error('Failed to load regulatory filings');
  return res.data as unknown as FilingsResponse;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  pending: { bg: '#fef3c7', color: '#92400e' },
  filed: { bg: '#dbeafe', color: '#1e40af' },
  accepted: { bg: '#d1fae5', color: '#065f46' },
  rejected: { bg: '#fee2e2', color: '#991b1b' },
  overdue: { bg: '#fecaca', color: '#7f1d1d' },
};

function fmtPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  const s = start ? fmtDate(start) : '…';
  const e = end ? fmtDate(end) : '…';
  return `${s} → ${e}`;
}

// ---------------------------------------------------------------------------
// RegulatoryFilingList component
// ---------------------------------------------------------------------------

export function RegulatoryFilingList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const filingsQ = useQuery({
    queryKey: ['regulatory-filings', page, status],
    queryFn: () => fetchFilings(page, status),
  });

  function setStatusFilter(value: string) {
    setStatus(value);
    setPage(1);
  }

  const filings = filingsQ.data?.data ?? [];
  const meta = filingsQ.data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.regulatoryFilingList.regulatoryFilings')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.regulatoryFilingList.total')}</span>}
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.regulatoryFilingList.status')}</label>
        <select
          style={styles.filterSelect}
          value={status}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="">{t('ui.regulatoryFilingList.all')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{capitalize(s)}</option>)}
        </select>
      </div>

      <div style={styles.tableCard}>
        {filingsQ.isLoading ? (
          <p style={styles.msg}>{t('ui.regulatoryFilingList.loading')}</p>
        ) : filingsQ.error ? (
          <p style={styles.msgError}>{t('ui.regulatoryFilingList.failedToLoadRegulatoryFilings')}</p>
        ) : filings.length === 0 ? (
          <p style={styles.msg}>{t('ui.regulatoryFilingList.noRegulatoryFilingsFound')}{status ? ' for the selected status' : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Type', 'Period', 'Filed At', 'Ack #', 'Status', 'Notes'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filings.map(f => (
                    <tr key={f.id} style={styles.tr}>
                      <td style={styles.td}>#{f.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500, textTransform: 'capitalize' }}>
                        {f.filing_type?.replace(/_/g, ' ') ?? '—'}
                      </td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>{fmtPeriod(f.period_start, f.period_end)}</td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>{f.filed_at ? fmtDate(f.filed_at) : '—'}</td>
                      <td style={{ ...styles.td, fontFamily: 'monospace' }}>{f.acknowledgement_number ?? '—'}</td>
                      <td style={styles.td}><StatusBadge status={f.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, maxWidth: 280, overflowWrap: 'anywhere' }}>{f.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.regulatoryFilingList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.regulatoryFilingList.page')}{page} {t('ui.regulatoryFilingList.of')}{totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('ui.regulatoryFilingList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
