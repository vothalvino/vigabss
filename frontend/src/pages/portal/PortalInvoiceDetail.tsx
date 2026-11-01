// =============================================================================
// VigaBSS 5.0 — Portal Invoice Detail
// =============================================================================
// Shows a single invoice for the client with line items and a Pay button.
// At /portal/invoices/:id
// =============================================================================

import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { portalAuthedFetch } from '@/auth/PortalAuthContext';

const API_BASE = '/api/v1/portal';

interface InvoiceItem {
  id: number;
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
  tax_rate: string | null;
}

interface Payment {
  allocated_amount: string;
  payment_method: string;
  payment_date: string | null;
}

interface Invoice {
  id: number;
  invoice_number: string;
  subtotal: string;
  tax_amount: string;
  discount_amount: string | null;
  total: string;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  paid_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  balance_due?: number;
  pending_checkout?: boolean;
  has_cfdi?: boolean;
  items: InvoiceItem[];
  payments: Payment[];
}

async function portalGet<T>(path: string): Promise<T> {
  const res = await portalAuthedFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error('Not found');
  return (await res.json() as { data: T }).data;
}

async function startPayment(invoiceId: number): Promise<{ payment_url: string }> {
  const res = await portalAuthedFetch(`${API_BASE}/invoices/${invoiceId}/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    // Success and cancel both come back here, as ?payment=success|cancelled.
    body: JSON.stringify({ return_url: `${window.location.origin}/portal/invoices/${invoiceId}` }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? 'Payment initiation failed');
  }
  return (await res.json() as { data: { payment_url: string } }).data;
}

const POLL_MS = 5000;
const POLL_FOR_MS = 2 * 60 * 1000;

export function PortalInvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const paymentReturn = searchParams.get('payment'); // 'success' | 'cancelled' | null
  const [payError, setPayError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [returnedAt] = useState(() => Date.now());

  // Back from the provider with ?payment=success: the webhook usually lands
  // seconds later, so poll until the invoice is paid (for up to two minutes)
  // instead of offering Pay Now again (FE-14).
  const { data: invoice, isLoading, error } = useQuery({
    queryKey: ['portal-invoice', id],
    queryFn: () => portalGet<Invoice>(`/invoices/${id}`),
    enabled: !!id,
    refetchInterval: (query) => (paymentReturn === 'success'
      && query.state.data?.status !== 'paid'
      && Date.now() - returnedAt < POLL_FOR_MS ? POLL_MS : false),
  });

  const payMutation = useMutation({
    mutationFn: () => startPayment(Number(id)),
    onSuccess: result => {
      window.location.href = result.payment_url;
    },
    onError: (err: Error) => {
      setPayError(err.message);
    },
  });

  if (isLoading) return <p style={{ color: '#6b7280' }}>Loading…</p>;
  if (error || !invoice) return <p style={{ color: '#b91c1c' }}>Invoice not found.</p>;

  const balanceDue = invoice.balance_due ?? Number(invoice.total);
  const canPay = ['issued', 'sent', 'overdue'].includes(invoice.status) && balanceDue > 0.005;
  const confirming = paymentReturn === 'success' && invoice.status !== 'paid';

  // An error response (e.g. 404 "no stamped CFDI") used to be saved as the
  // PDF/XML file itself (FE-14).
  function downloadFile(url: string, filename: string) {
    setDownloadError(null);
    portalAuthedFetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then(blob => {
        const a = document.createElement('a');
        const blobUrl = URL.createObjectURL(blob);
        a.href = blobUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(blobUrl);
      })
      .catch(() => setDownloadError('The file is not available right now. Please try again later.'));
  }

  return (
    <div>
      <div style={styles.breadcrumb}>
        <Link to="/portal/invoices" style={styles.back}>← Back to invoices</Link>
      </div>

      <div style={styles.card}>
        {/* Header */}
        <div style={styles.invoiceHeader}>
          <div>
            <h1 style={styles.invoiceNum}>{invoice.invoice_number}</h1>
            <p style={styles.meta}>Issued: {invoice.created_at.slice(0, 10)}</p>
            {invoice.due_date && (
              <p style={styles.meta}>Due: {invoice.due_date.slice(0, 10)}</p>
            )}
            {invoice.period_start && invoice.period_end && (
              <p style={styles.meta}>Period: {invoice.period_start.slice(0, 10)} – {invoice.period_end.slice(0, 10)}</p>
            )}
          </div>
          <div style={styles.statusBlock}>
            <span style={{ ...styles.badge, ...badgeColor(invoice.status) }}>
              {invoice.status.toUpperCase()}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
              {paymentReturn === 'success' && invoice.status === 'paid' && (
                <p role="status" style={styles.meta}>Payment received. Thank you!</p>
              )}
              {confirming && (
                <p role="status" style={styles.meta}>We are confirming your payment with the payment provider. This page updates on its own.</p>
              )}
              {paymentReturn === 'cancelled' && invoice.status !== 'paid' && (
                <p role="status" style={styles.meta}>The payment was not completed. You can try again.</p>
              )}
              {canPay && !confirming && (
                <>
                  {payError && <p style={styles.payError}>{payError}</p>}
                  <button
                    onClick={() => { setPayError(null); payMutation.mutate(); }}
                    disabled={payMutation.isPending}
                    style={styles.payBtn}
                  >
                    {payMutation.isPending ? 'Processing…' : invoice.pending_checkout ? 'Continue payment' : 'Pay Now'}
                  </button>
                </>
              )}
              {downloadError && <p style={styles.payError}>{downloadError}</p>}
              <button
                onClick={() => downloadFile(`${API_BASE}/invoices/${invoice.id}/pdf`, `invoice-${invoice.invoice_number}.pdf`)}
                style={styles.dlBtn}
              >
                Download PDF
              </button>
              {invoice.has_cfdi && (
                <button
                  onClick={() => downloadFile(`${API_BASE}/invoices/${invoice.id}/cfdi`, `cfdi-${invoice.invoice_number}.xml`)}
                  style={styles.dlBtn}
                >
                  Download CFDI XML
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Line items */}
        <h2 style={styles.sectionTitle}>Items</h2>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Description</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Qty</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Unit Price</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map(item => (
              <tr key={item.id}>
                <td style={styles.td}>{item.description}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{item.quantity}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{parseFloat(item.unit_price).toFixed(2)}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{parseFloat(item.amount).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={styles.totals}>
          <div style={styles.totalRow}><span>Subtotal</span><span>{invoice.currency} {parseFloat(invoice.subtotal).toFixed(2)}</span></div>
          <div style={styles.totalRow}><span>Tax</span><span>{invoice.currency} {parseFloat(invoice.tax_amount).toFixed(2)}</span></div>
          {invoice.discount_amount && parseFloat(invoice.discount_amount) > 0 && (
            <div style={styles.totalRow}><span>Discount</span><span>− {invoice.currency} {parseFloat(invoice.discount_amount).toFixed(2)}</span></div>
          )}
          <div style={{ ...styles.totalRow, fontWeight: 700, fontSize: '1.1rem', borderTop: '2px solid #e5e7eb', paddingTop: '0.5rem' }}>
            <span>Total</span><span>{invoice.currency} {parseFloat(invoice.total).toFixed(2)}</span>
          </div>
        </div>

        {/* Applied payments */}
        {invoice.payments.length > 0 && (
          <>
            <h2 style={styles.sectionTitle}>Payments Applied</h2>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Date</th>
                  <th style={styles.th}>Method</th>
                  <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p, i) => (
                  <tr key={i}>
                    <td style={styles.td}>{p.payment_date ? p.payment_date.slice(0, 10) : '—'}</td>
                    <td style={styles.td}>{p.payment_method}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>{invoice.currency} {parseFloat(p.allocated_amount).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {invoice.notes && (
          <p style={styles.notes}><strong>Notes:</strong> {invoice.notes}</p>
        )}
      </div>
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
  breadcrumb: { marginBottom: '1rem' },
  back: { color: 'var(--text-muted)', textDecoration: 'none', fontSize: '0.9rem' },
  card: { background: 'var(--bg-card)', borderRadius: 8, padding: '1.5rem', boxShadow: '0 0 0 1px var(--border)' },
  invoiceHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap' as const, gap: '1rem' },
  invoiceNum: { margin: '0 0 0.25rem', fontSize: '1.4rem', color: 'var(--text-primary)' },
  meta: { margin: '0.15rem 0', color: 'var(--text-muted)', fontSize: '0.875rem' },
  statusBlock: { textAlign: 'right' as const },
  badge: { display: 'inline-block', padding: '0.3rem 0.75rem', borderRadius: 12, fontSize: '0.8rem', fontWeight: 700 },
  payBtn: { padding: '0.6rem 1.5rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, fontSize: '1rem', fontWeight: 600, cursor: 'pointer' },
  dlBtn: { padding: '0.4rem 1rem', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, fontSize: '0.875rem', cursor: 'pointer' },
  payError: { color: '#b91c1c', fontSize: '0.85rem', margin: '0 0 0.5rem' },
  sectionTitle: { fontSize: '1rem', color: 'var(--text-secondary)', margin: '1.25rem 0 0.5rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.5rem', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '2px solid var(--border-subtle)' },
  td: { padding: '0.5rem', borderBottom: '1px solid #f9fafb', color: 'var(--text-secondary)' },
  totals: { marginTop: '1rem', maxWidth: 320, marginLeft: 'auto' },
  totalRow: { display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)' },
  notes: { marginTop: '1rem', color: 'var(--text-muted)', fontSize: '0.875rem' },
};
