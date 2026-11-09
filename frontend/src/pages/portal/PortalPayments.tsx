// =============================================================================
// VigaBSS 5.0 — Portal Payments: payment history (FE-26)
// =============================================================================
// GET /portal/payments existed with no page calling it.
// "Pagar por adelantado" (migration 012): the customer pays any amount online
// (POST /portal/payments/advance opens the gateway's checkout); what no open
// invoice takes stays as its credit and pays its next invoices on its own.
// The gateway brings it back here with ?payment=success|cancelled.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { portalApiFetch } from '@/api/portalApiFetch';
import { portalPageStyles as styles } from './portalPageStyles';

const AMOUNT = /^\d+(\.\d{1,2})?$/;

interface Dashboard { data?: { balance?: number | string | null; balance_currency?: string | null } }

/** Pay ahead online; shows the credit the customer already holds. */
function PayAhead() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const back = params.get('payment');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const dashboard = useQuery({ queryKey: ['portal-dashboard'], queryFn: () => portalApiFetch<Dashboard>('/dashboard') });
  const balance = Number(dashboard.data?.data?.balance ?? 0);
  const currency = dashboard.data?.data?.balance_currency ?? '';
  const start = useMutation({
    mutationFn: (value: number) => portalApiFetch<{ data: { payment_url: string } }>('/payments/advance', {
      method: 'POST',
      body: JSON.stringify({ amount: value, return_url: `${window.location.origin}/portal/payments` }),
    }),
    onSuccess: (res) => { window.location.href = res.data.payment_url; },
    onError: (err: unknown) => setError(err instanceof ApiRequestError && err.status < 500 && err.message ? err.message : t('portalPayments.advance.error')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const raw = amount.trim();
    const value = Number(raw);
    if (!AMOUNT.test(raw) || value < 1 || value > 100000) { setError(t('portalPayments.advance.invalid')); return; }
    start.mutate(value);
  }

  return (
    <section style={{ ...styles.card, marginBottom: 16 }} aria-labelledby="portal-pay-ahead">
      <h2 id="portal-pay-ahead" style={{ margin: '0 0 6px', fontSize: '1.05rem' }}>{t('portalPayments.advance.title')}</h2>
      <p style={{ ...styles.muted, margin: '0 0 10px' }}>{t('portalPayments.advance.help')}</p>
      {balance < 0 && (
        <p style={{ margin: '0 0 10px', fontWeight: 600 }}>{t('portalPayments.advance.credit', { amount: `${(-balance).toFixed(2)} ${currency}`.trim() })}</p>
      )}
      {back === 'success' && <p role="status" style={{ margin: '0 0 10px', color: '#047857' }}>{t('portalPayments.advance.thanks')}</p>}
      {back === 'cancelled' && <p role="status" style={{ ...styles.muted, margin: '0 0 10px' }}>{t('portalPayments.advance.cancelled')}</p>}
      <form onSubmit={submit} noValidate style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.9rem' }}>
          {t('portalPayments.advance.amount')}
          <input inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)}
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '1rem', width: 160 }} />
        </label>
        <button type="submit" disabled={start.isPending}
          style={{ padding: '9px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
          {start.isPending ? t('portalPayments.advance.starting') : t('portalPayments.advance.pay')}
        </button>
      </form>
      {error && <p role="alert" style={{ ...styles.error, marginTop: 8 }}>{error}</p>}
    </section>
  );
}

interface Payment {
  id: number;
  amount: string;
  currency: string;
  payment_method: string | null;
  payment_date: string | null;
  reference_number: string | null;
  status: string;
}

interface PaymentsResponse {
  data: Payment[];
  meta: { page: number; limit: number; total: number; pages: number };
}

export function PortalPayments() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-payments', page],
    queryFn: () => portalApiFetch<PaymentsResponse>(`/payments?page=${page}&limit=20`),
  });
  const payments = data?.data ?? [];
  const pages = data?.meta.pages ?? 1;

  return (
    <div>
      <h1 style={styles.heading}>{t('portalPayments.title')}</h1>
      <p style={styles.sub}>{t('portalPayments.subtitle')}</p>
      <PayAhead />
      <section style={styles.card}>
        {isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
        {error && <p role="alert" style={styles.error}>{t('portalPayments.loadError')}</p>}
        {!isLoading && !error && payments.length === 0 && <p style={styles.muted}>{t('portalPayments.none')}</p>}
        {payments.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalPayments.date')}</th>
                <th style={styles.th}>{t('portalPayments.amount')}</th>
                <th style={styles.th}>{t('portalPayments.method')}</th>
                <th style={styles.th}>{t('portalPayments.reference')}</th>
                <th style={styles.th}>{t('portalPayments.status')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id}>
                  <td style={styles.td}>{p.payment_date ? String(p.payment_date).slice(0, 10) : '—'}</td>
                  <td style={styles.td}>{Number(p.amount).toFixed(2)} {p.currency}</td>
                  <td style={styles.td}>{p.payment_method ? t(`paymentMethods.${p.payment_method}`, { defaultValue: p.payment_method }) : '—'}</td>
                  <td style={styles.td}>{p.reference_number || '—'}</td>
                  <td style={styles.td}>{t(`portalPayments.statuses.${p.status}`, { defaultValue: p.status })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pages > 1 && (
          <div style={styles.pagination}>
            <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('portalCommon.prev')}</button>
            <span style={styles.muted}>{t('portalCommon.pageOf', { page, pages })}</span>
            <button type="button" style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('portalCommon.next')}</button>
          </div>
        )}
      </section>
    </div>
  );
}
