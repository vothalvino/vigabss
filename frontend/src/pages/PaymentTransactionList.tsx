// =============================================================================
// VigaBSS 5.0 — Payment Transaction Viewer
// =============================================================================
// Read-only page at /payment-transactions. Lists the raw gateway transaction
// log (every charge attempt) with its provider reference, client, amount,
// gateway status and timestamp for auditing and reconciliation. This is a
// historical/audit view and exposes no create/edit/delete actions.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { styles, fmtDate, fmtMoney } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaymentTransaction {
  id: number;
  payment_id: number | null;
  payment_gateway_id: number;
  client_id: number;
  gateway_reference_id: string;
  amount: number | string;
  currency: string;
  gateway_status: string;
  gateway_response_code: string | null;
  created_at: string | null;
}

interface PaymentTransactionResponse {
  data: PaymentTransaction[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const DEFAULT_PAGE_SIZE = 50;
const STATUS_FILTER_OPTIONS = ['', 'pending', 'succeeded', 'failed', 'refunded', 'disputed', 'cancelled'];

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchTransactions(page: number, statusFilter: string): Promise<PaymentTransactionResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (statusFilter) query.gateway_status = statusFilter;
  const res = await api.GET('/payment-transactions', { params: { query: query as never } });
  if (res.error) throw new Error('Failed to load payment transactions');
  return res.data as unknown as PaymentTransactionResponse;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  succeeded: { bg: '#d1fae5', color: '#065f46' },
  pending: { bg: '#fef3c7', color: '#92400e' },
  failed: { bg: '#fee2e2', color: '#991b1b' },
  refunded: { bg: '#dbeafe', color: '#1e40af' },
  disputed: { bg: '#fde68a', color: '#92400e' },
  cancelled: { bg: '#f3f4f6', color: '#374151' },
};

// ---------------------------------------------------------------------------
// PaymentTransactionList component
// ---------------------------------------------------------------------------

export function PaymentTransactionList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');

  const transactionsQ = useQuery({
    queryKey: ['payment-transactions', page, statusFilter],
    queryFn: () => fetchTransactions(page, statusFilter),
  });

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const transactions = transactionsQ.data?.data ?? [];
  const meta = transactionsQ.data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.paymentTransactionList.paymentTransactions')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.paymentTransactionList.total')}</span>}
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.paymentTransactionList.status')}</label>
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
            {t('ui.paymentTransactionList.clearFilter')}
          </button>
        )}
      </div>

      <div style={styles.tableCard}>
        {transactionsQ.isLoading ? (
          <p style={styles.msg}>{t('ui.paymentTransactionList.loading')}</p>
        ) : transactionsQ.error ? (
          <p style={styles.msgError}>{t('ui.paymentTransactionList.failedToLoadPaymentTransactions')}</p>
        ) : transactions.length === 0 ? (
          <p style={styles.msg}>{t('ui.paymentTransactionList.noPaymentTransactionsFound')}{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Reference', 'Client', 'Gateway', 'Amount', 'Status', 'Code', 'Date'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(t => (
                    <tr key={t.id} style={styles.tr}>
                      <td style={styles.td}>#{t.id}</td>
                      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.78rem', maxWidth: 220, overflowWrap: 'anywhere' }}>
                        {t.gateway_reference_id}
                      </td>
                      <td style={styles.td}>#{t.client_id}</td>
                      <td style={styles.td}>#{t.payment_gateway_id}</td>
                      <td style={styles.td}>{fmtMoney(t.amount, t.currency)}</td>
                      <td style={styles.td}><StatusBadge status={t.gateway_status} colors={STATUS_COLORS} /></td>
                      <td style={styles.td}>{t.gateway_response_code ?? '—'}</td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>{t.created_at ? fmtDate(t.created_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.paymentTransactionList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.paymentTransactionList.page')}{page} {t('ui.paymentTransactionList.of')}{totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('ui.paymentTransactionList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
