// =============================================================================
// VigaBSS 5.0 — Portal Invoices
// =============================================================================
// Lists all invoices for the authenticated client at /portal/invoices.
// =============================================================================

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { portalAuthedFetch } from '@/auth/PortalAuthContext';

const API_BASE = '/api/v1/portal';

interface Invoice {
  id: number;
  invoice_number: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  currency: string;
  due_date: string | null;
  paid_at: string | null;
  status: string;
  created_at: string;
}

interface InvoicesResponse {
  data: Invoice[];
  meta: { page: number; limit: number; total: number; pages: number };
}

async function fetchPortalInvoices(page: number, status: string): Promise<InvoicesResponse> {
  const query = new URLSearchParams({ page: String(page), limit: '20' });
  if (status) query.set('status', status);
  const res = await portalAuthedFetch(`${API_BASE}/invoices?${query}`);
  if (!res.ok) throw new Error('Failed to load invoices');
  return res.json() as Promise<InvoicesResponse>;
}

const STATUS_ICONS: Record<string, string> = {
  draft: '⬜',
  issued: '📤',
  paid: '✅',
  overdue: '🔴',
  cancelled: '❌',
};
// Drafts are never shown to subscribers (TNB-30).
const FILTER_STATUSES = ['issued', 'paid', 'overdue', 'cancelled'];

export function PortalInvoices() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  // Fallback return target of a checkout started without a return page (FE-14).
  const [searchParams] = useSearchParams();
  const paymentReturn = searchParams.get('payment');

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-invoices', page, statusFilter],
    queryFn: () => fetchPortalInvoices(page, statusFilter),
  });

  const invoices = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.heading}>🧾 {t('portalInvoices.title')}</h1>
        {paymentReturn === 'success' && (
          <p role="status">{t('portalInvoices.paymentSuccess')}</p>
        )}
        {paymentReturn === 'cancelled' && <p role="status">{t('portalInvoices.paymentCancelled')}</p>}
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          style={styles.select}
        >
          <option value="">{t('portalInvoices.allStatuses')}</option>
          {FILTER_STATUSES.map(st => <option key={st} value={st}>{t(`portalCommon.invoiceStatus.${st}`)}</option>)}
        </select>
      </div>

      {isLoading && <p style={styles.info}>{t('portalInvoices.loading')}</p>}
      {error && <p style={styles.error}>{t('portalInvoices.error')}</p>}

      {!isLoading && invoices.length === 0 && (
        <p style={styles.info}>{t('portalInvoices.noInvoices')}</p>
      )}

      {invoices.length > 0 && (
        <div style={styles.card}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalInvoices.table.invoiceNumber')}</th>
                <th style={styles.th}>{t('portalInvoices.table.date')}</th>
                <th style={styles.th}>{t('portalInvoices.table.dueDate')}</th>
                <th style={styles.th}>{t('portalInvoices.table.amount')}</th>
                <th style={styles.th}>{t('portalInvoices.table.status')}</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td style={styles.td}>
                    <Link to={`/portal/invoices/${inv.id}`} style={styles.link}>{inv.invoice_number}</Link>
                  </td>
                  <td style={styles.td}>{inv.created_at.slice(0, 10)}</td>
                  <td style={styles.td}>{inv.due_date ? inv.due_date.slice(0, 10) : '—'}</td>
                  <td style={styles.td}>{inv.currency} {parseFloat(inv.total).toFixed(2)}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, ...badgeColor(inv.status) }}>
                      {STATUS_ICONS[inv.status] ? `${STATUS_ICONS[inv.status]} ` : ''}{t(`portalCommon.invoiceStatus.${inv.status}`, { defaultValue: inv.status })}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {(inv.status === 'issued' || inv.status === 'overdue') && (
                      <Link to={`/portal/invoices/${inv.id}`} style={styles.payBtn}>{t('portalInvoices.pay')} →</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {meta && meta.pages > 1 && (
        <div style={styles.pagination}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={styles.pageBtn}>
            ‹ {t('portalCommon.prev')}
          </button>
          <span style={styles.pageInfo}>{t('portalCommon.pageOf', { page, pages: meta.pages })}</span>
          <button onClick={() => setPage(p => Math.min(meta.pages, p + 1))} disabled={page === meta.pages} style={styles.pageBtn}>
            {t('portalCommon.next')} ›
          </button>
        </div>
      )}
    </div>
  );
}

function badgeColor(status: string): React.CSSProperties {
  switch (status) {
    case 'paid': return { background: '#d1fae5', color: '#065f46' };
    case 'issued': return { background: '#dbeafe', color: '#1e40af' };
    case 'overdue': return { background: '#fee2e2', color: '#991b1b' };
    case 'cancelled': return { background: '#f3f4f6', color: '#6b7280' };
    default: return { background: '#f3f4f6', color: '#374151' };
  }
}

const styles = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' },
  heading: { margin: 0, fontSize: '1.4rem', color: 'var(--text-primary)' },
  select: { padding: '0.4rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem' },
  info: { color: 'var(--text-muted)' },
  error: { color: '#b91c1c' },
  card: { background: 'var(--bg-card)', borderRadius: 8, boxShadow: '0 0 0 1px var(--border)', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '2px solid var(--border-subtle)' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f9fafb', color: 'var(--text-secondary)' },
  link: { color: 'var(--link)', textDecoration: 'none', fontWeight: 500 },
  badge: { display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: 12, fontSize: '0.78rem', fontWeight: 600 },
  payBtn: { color: 'var(--accent)', fontWeight: 600, textDecoration: 'none', fontSize: '0.875rem' },
  pagination: { display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem', justifyContent: 'center' },
  pageBtn: { padding: '0.4rem 0.8rem', border: '1px solid var(--border-strong)', borderRadius: 4, cursor: 'pointer', background: 'var(--bg-card)', fontSize: '0.875rem' },
  pageInfo: { color: 'var(--text-muted)', fontSize: '0.875rem' },
};
