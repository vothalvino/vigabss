// =============================================================================
// VigaBSS 5.0 — Payment List
// =============================================================================
// Standalone page at /payments. Shows all payments across all clients with:
//   • Filtering by status
//   • Paginated table (client name, client ID, amount, method, status, date, reference)
//   • "Record Payment" button opens an inline modal form
//   • Per-row "Allocations" button expands inline to show invoice allocations
//   • Per-row action buttons via shared <PaymentActionButtons>
//   • Gateway transaction status badge when available
// =============================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, tokenStore } from '@/api/client';
import { useTableSort, SortableTh } from '@/components/SortableTh';
import { Pagination } from '@/components/Pagination';
import { RecordPaymentModal } from '@/components/RecordPaymentModal';
import {
  Payment,
  extractList,
  fmtAmount,
  fetchAllocations,
  PaymentActionButtons,
} from './payments/PaymentActions';
import { useClientNames } from '@/api/clientNames';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types (local to this file — list-level concerns)
// ---------------------------------------------------------------------------

interface PaymentsResponse {
  data: Payment[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

interface PaymentAllocation {
  id: number;
  payment_id: number;
  invoice_id: number;
  amount: string;
}

// The payment_transactions columns plus the joined gateway name (FE-19).
interface GatewayTransaction {
  id: number;
  payment_id: number | null;
  gateway_name: string | null;
  gateway_provider: string | null;
  gateway_status: string;
  gateway_reference_id: string | null;
  amount: string;
  currency: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Fetch helpers (list-specific)
// ---------------------------------------------------------------------------

const API_BASE = '/api/v1';

async function fetchPayments(page: number, pageSize: number, statusFilter: string, orderBy: string, order: string): Promise<PaymentsResponse> {
  const query: Record<string, string | number> = { page, limit: pageSize, order_by: orderBy, order };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/payments', { params: { query: query as never } });
  if (res.error) throw new Error('Failed to load payments');
  return res.data as unknown as PaymentsResponse;
}

async function fetchGatewayTransactions(paymentId: number): Promise<GatewayTransaction[]> {
  const token = tokenStore.getAccess();
  // Filter by the payment itself: the first 50 of the client's transactions
  // could leave out the ones this payment produced.
  const params = new URLSearchParams({ payment_id: String(paymentId), limit: '50' });
  const res = await fetch(`${API_BASE}/payment-transactions?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return [];
  const body = await res.json() as unknown;
  return extractList<GatewayTransaction>(body);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(dateStr: string | null | undefined): string {
  // Calendar dates must not shift a day in the browser's zone (FE-10).
  return formatDate(dateStr);
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    pending:   { bg: '#ede9fe', color: '#5b21b6' },
    completed: { bg: '#d1fae5', color: '#065f46' },
    failed:    { bg: '#fee2e2', color: '#991b1b' },
    refunded:  { bg: '#dbeafe', color: '#1e40af' },
    cancelled: { bg: '#fef3c7', color: '#92400e' },
  };
  const s = map[status] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: '2px 8px', borderRadius: 12,
      fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  );
}

function GatewayBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    pending:    { bg: '#fef9c3', color: '#854d0e' },
    succeeded:  { bg: '#d1fae5', color: '#065f46' },
    disputed:   { bg: '#fee2e2', color: '#991b1b' },
    cancelled:  { bg: '#f3f4f6', color: '#374151' },
    authorized: { bg: '#d1fae5', color: '#065f46' },
    captured:   { bg: '#d1fae5', color: '#065f46' },
    settled:    { bg: '#d1fae5', color: '#065f46' },
    failed:     { bg: '#fee2e2', color: '#991b1b' },
    declined:   { bg: '#fee2e2', color: '#991b1b' },
    refunded:   { bg: '#dbeafe', color: '#1e40af' },
    voided:     { bg: '#f3f4f6', color: '#374151' },
  };
  const s = map[status] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: '2px 8px', borderRadius: 12,
      fontSize: '0.7rem', fontWeight: 600, textTransform: 'capitalize',
      border: '1px solid rgba(0,0,0,.06)',
    }}>
      GW: {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline Allocations Drawer
// ---------------------------------------------------------------------------

interface AllocationsRowProps {
  paymentId: number;
  currency: string;
}

function AllocationsRow({ paymentId, currency }: AllocationsRowProps) {
  const { data: allocs = [], isLoading } = useQuery({
    queryKey: ['payment-allocs', paymentId],
    queryFn: () => fetchAllocations(paymentId),
  });

  if (isLoading) {
    return (
      <tr>
        <td colSpan={9} style={{ padding: '8px 20px', background: '#f8faff', fontSize: '0.82rem', color: '#9ca3af' }}>
          Loading allocations…
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={9} style={{ padding: '8px 20px 12px', background: '#f8faff' }}>
        {allocs.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#9ca3af' }}>No invoice allocations.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr>
                {['Invoice', 'Allocated Amount'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allocs.map((a: PaymentAllocation) => (
                <tr key={a.id}>
                  <td style={{ padding: '4px 8px' }}>
                    <Link
                      to={`/invoices/${a.invoice_id}`}
                      style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
                    >
                      Invoice #{a.invoice_id}
                    </Link>
                  </td>
                  <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAmount(a.amount, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Gateway Status Row
// ---------------------------------------------------------------------------

interface GatewayRowProps {
  paymentId: number;
}

function GatewayRow({ paymentId }: GatewayRowProps) {
  const { data: txns = [], isLoading } = useQuery({
    queryKey: ['gateway-txns', paymentId],
    queryFn: () => fetchGatewayTransactions(paymentId),
  });

  const linked = txns.filter((t: GatewayTransaction) => t.payment_id === paymentId);

  if (isLoading) {
    return (
      <tr>
        <td colSpan={9} style={{ padding: '8px 20px', background: '#fafff8', fontSize: '0.82rem', color: '#9ca3af' }}>
          Loading gateway transactions…
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={9} style={{ padding: '8px 20px 12px', background: '#fafff8' }}>
        {linked.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.82rem', color: '#9ca3af' }}>
            No gateway transactions linked to this payment.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr>
                {['Gateway', 'Gateway Txn ID', 'Amount', 'Status', 'Date'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linked.map((t: GatewayTransaction) => (
                <tr key={t.id}>
                  <td style={{ padding: '4px 8px', textTransform: 'capitalize' }}>{t.gateway_name || t.gateway_provider || '—'}</td>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '0.78rem', color: '#6b7280' }}>
                    {t.gateway_reference_id || '—'}
                  </td>
                  <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAmount(t.amount, t.currency)}
                  </td>
                  <td style={{ padding: '4px 8px' }}><GatewayBadge status={t.gateway_status} /></td>
                  <td style={{ padding: '4px 8px', color: '#9ca3af' }}>{fmt(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Payment Row
// ---------------------------------------------------------------------------

interface PaymentRowProps {
  payment: Payment;
  idx: number;
  clientName: string | null;
  onChanged: () => void;
}

function PaymentRow({ payment, idx, clientName, onChanged }: PaymentRowProps) {
  const [expanded, setExpanded] = useState<'none' | 'alloc' | 'gateway'>('none');

  function toggleExpand(mode: 'alloc' | 'gateway') {
    setExpanded(prev => (prev === mode ? 'none' : mode));
  }

  return (
    <>
      <tr style={{ borderBottom: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
        {/* Client name */}
        <td style={{ padding: '10px 14px' }}>
          <Link to={`/clients/${payment.client_id}`} style={{ color: '#374151', textDecoration: 'none' }}>
            {clientName ?? String(payment.client_id)}
          </Link>
        </td>
        {/* Client ID — narrow */}
        <td style={{ padding: '10px 8px', color: '#9ca3af', fontSize: '0.8rem', whiteSpace: 'nowrap', width: 40 }}>
          {payment.client_id}
        </td>
        {/* Amount */}
        <td style={{ padding: '10px 14px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#111827' }}>
          {fmtAmount(payment.amount, payment.currency)}
        </td>
        {/* Method */}
        <td style={{ padding: '10px 14px', textTransform: 'capitalize', color: '#4b5563' }}>
          {payment.payment_method?.replace('_', ' ') || '—'}
        </td>
        {/* Status */}
        <td style={{ padding: '10px 14px' }}>
          <StatusBadge status={payment.status} />
        </td>
        {/* Date */}
        <td style={{ padding: '10px 14px', color: '#6b7280' }}>
          {fmt(payment.payment_date || payment.created_at)}
        </td>
        {/* Reference */}
        <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: '0.8rem', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {payment.reference_number || '—'}
        </td>
        {/* Actions */}
        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              style={{ ...actionBtn, background: expanded === 'alloc' ? '#ede9fe' : '#f3f4f6', color: '#5b21b6' }}
              onClick={() => toggleExpand('alloc')}
              title="Show invoice allocations"
              aria-label="Show invoice allocations"
            >
              📎
            </button>
            <button
              style={{ ...actionBtn, background: expanded === 'gateway' ? '#d1fae5' : '#f3f4f6', color: '#065f46' }}
              onClick={() => toggleExpand('gateway')}
              title="Show gateway transactions"
              aria-label="Show gateway transactions"
            >
              🔗
            </button>
            <PaymentActionButtons payment={payment} onChanged={onChanged} />
          </div>
        </td>
      </tr>

      {expanded === 'alloc' && (
        <AllocationsRow paymentId={payment.id} currency={payment.currency} />
      )}
      {expanded === 'gateway' && (
        <GatewayRow paymentId={payment.id} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = ['', 'pending', 'completed', 'failed', 'refunded', 'cancelled'];

export function PaymentList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [showRecord, setShowRecord] = useState(false);
  const sort = useTableSort('created_at', 'DESC');
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['payments', page, pageSize, statusFilter, sort.sortBy, sort.sortDir],
    queryFn: () => fetchPayments(page, pageSize, statusFilter, sort.order_by, sort.order),
    placeholderData: prev => prev,
  });

  // Names for the clients on this page (FE-04).
  const clientMap = useClientNames(extractList<Payment>(data).map(p => p.client_id));

  function handleFilterChange(newStatus: string) {
    setStatusFilter(newStatus);
    setPage(1);
  }

  function onRowChanged() {
    qc.invalidateQueries({ queryKey: ['payments'] });
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>💳 {t('paymentList.title')}</h1>
        <button onClick={() => setShowRecord(true)} style={submitBtn}>
          {t('paymentList.recordPayment')}
        </button>
      </div>

      {/* Status Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '1rem', flexWrap: 'wrap' }}>
        {STATUS_OPTIONS.map(s => (
          <button
            key={s || 'all'}
            onClick={() => handleFilterChange(s)}
            style={{
              padding: '4px 12px', borderRadius: 20, border: '1px solid #d1d5db',
              background: statusFilter === s ? 'var(--accent)' : '#fff',
              color: statusFilter === s ? '#fff' : '#374151',
              cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500,
            }}
          >
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : t('ticketList.all')}
          </button>
        ))}
      </div>

      {/* Table */}
      {isLoading && <p style={{ color: '#888' }}>{t('paymentList.loading')}</p>}
      {isError && <p style={{ color: 'var(--accent)' }}>{t('paymentList.error')}</p>}
      {data && (
        <>
          <div style={{ background: '#fff', borderRadius: 8, boxShadow: '0 0 0 1px var(--border)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                  <SortableTh label={t('paymentList.table.client')} col="client_id" sort={sort} />
                  <th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', width: 40, fontSize: '0.875rem' }}>
                    {t('paymentList.table.clientId')}
                  </th>
                  <SortableTh label={t('paymentList.table.amount')} col="amount" sort={sort} />
                  <SortableTh label={t('paymentList.table.method')} col="payment_method" sort={sort} />
                  <SortableTh label={t('paymentList.table.status')} col="status" sort={sort} />
                  <SortableTh label={t('paymentList.table.date')} col="payment_date" sort={sort} />
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{t('paymentList.table.reference')}</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{t('paymentList.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: '#9ca3af' }}>
                      {t('paymentList.noPayments')}
                    </td>
                  </tr>
                )}
                {data.data.map((payment, idx) => (
                  <PaymentRow
                    key={payment.id}
                    payment={payment}
                    idx={idx}
                    clientName={clientMap.get(payment.client_id) ?? null}
                    onChanged={onRowChanged}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <Pagination
            page={page}
            totalPages={data?.meta?.totalPages ?? 1}
            total={data?.meta?.total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </>
      )}

      {/* Record Payment Modal — no locked client here, so it shows its own picker. */}
      {showRecord && (
        <RecordPaymentModal
          onClose={() => setShowRecord(false)}
          onRecorded={() => qc.invalidateQueries({ queryKey: ['payments'] })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const submitBtn: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  padding: '7px 18px', borderRadius: 6, cursor: 'pointer',
  fontWeight: 600, fontSize: '0.875rem',
};
const actionBtn: React.CSSProperties = {
  width: 28, height: 28, padding: 0, border: 'none', borderRadius: 5,
  cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  lineHeight: 1,
};
