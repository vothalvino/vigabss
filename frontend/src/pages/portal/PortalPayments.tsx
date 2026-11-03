// =============================================================================
// VigaBSS 5.0 — Portal Payments: payment history (FE-26)
// =============================================================================
// GET /portal/payments existed with no page calling it.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { portalApiFetch } from '@/api/portalApiFetch';
import { portalPageStyles as styles } from './portalPageStyles';

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
