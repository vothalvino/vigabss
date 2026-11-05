// =============================================================================
// VigaBSS 5.0 — Payment problems
// =============================================================================
// Page at /payment-problems. The API listed what goes wrong between a payment
// provider and the books (BIL-32), but no screen showed it:
//   * webhook events that failed or matched no transaction;
//   * succeeded charges with no payment posted (the reconcile_gateway_payments
//     task retries them);
//   * refunded payments a live REP still reports to SAT (cancel the REP,
//     motivo 02).
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { styles } from './crudStyles';
import { LoadingState } from '@/components/FetchStates';

type Meta = { total: number; page: number; limit: number; totalPages: number };
type Page<T> = { data: T[]; meta: Meta };

type WebhookEvent = {
  id: number;
  provider: string;
  provider_event_id: string | null;
  event_type: string;
  status: string;
  error_message: string | null;
  transaction_id: number | null;
  created_at: string;
};

type UnsettledTransaction = {
  id: number;
  client_id: number | null;
  invoice_id: number | null;
  gateway_reference_id: string | null;
  amount: string;
  currency: string;
  created_at: string;
};

type RefundedWithRep = {
  payment_id: number;
  client_id: number | null;
  amount: string;
  currency: string;
  reference_number: string | null;
  rep_id: number;
  rep_uuid: string | null;
  rep_sat_status: string;
};

type Tab = 'webhooks' | 'unsettled' | 'refunds';
const TABS: Tab[] = ['webhooks', 'unsettled', 'refunds'];
// Needing attention; '' lists every event.
const WEBHOOK_FILTERS = ['failed', 'no_match', ''] as const;
const PAGE_SIZE = 50;

function Pager({ meta, page, onPage }: { meta: Meta | undefined; page: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  if (!meta || meta.totalPages <= 1) return null;
  return (
    <div style={styles.pagination}>
      <button type="button" style={styles.pageBtn} onClick={() => onPage(page - 1)} disabled={page <= 1}>{t('paymentProblems.prev')}</button>
      <span style={styles.pageInfo}>{t('paymentProblems.pageOf', { page, total: meta.totalPages })}</span>
      <button type="button" style={styles.pageBtn} onClick={() => onPage(page + 1)} disabled={page >= meta.totalPages}>{t('paymentProblems.next')}</button>
    </div>
  );
}

function WebhookEvents() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<(typeof WEBHOOK_FILTERS)[number]>('failed');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['payment-webhook-events', status, page],
    queryFn: async () => {
      const query = { page, limit: PAGE_SIZE, ...(status ? { status } : {}) };
      const res = await api.GET('/payment-gateways/webhook-events', { params: { query } });
      if (res.error) throw new Error('load failed');
      return res.data as Page<WebhookEvent>;
    },
  });
  const rows = q.data?.data ?? [];
  return (
    <>
      <p style={styles.msg}>{t('paymentProblems.webhooksHelp')}</p>
      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>
          {t('paymentProblems.status')}
          <select style={styles.filterSelect} value={status} onChange={e => { setStatus(e.target.value as typeof status); setPage(1); }}>
            {WEBHOOK_FILTERS.map(s => <option key={s || 'all'} value={s}>{t(`paymentProblems.webhookStatus.${s || 'all'}`)}</option>)}
          </select>
        </label>
      </div>
      {q.isLoading ? <LoadingState /> : q.isError ? <p style={styles.msgError}>{t('paymentProblems.loadError')}</p> : rows.length === 0 ? (
        <p style={styles.msg}>{t('paymentProblems.noWebhooks')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('paymentProblems.col.received')}</th>
                <th style={styles.th}>{t('paymentProblems.col.provider')}</th>
                <th style={styles.th}>{t('paymentProblems.col.event')}</th>
                <th style={styles.th}>{t('paymentProblems.status')}</th>
                <th style={styles.th}>{t('paymentProblems.col.transaction')}</th>
                <th style={styles.th}>{t('paymentProblems.col.error')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => (
                <tr key={e.id} style={styles.tr}>
                  <td style={styles.td}>{formatDate(e.created_at)}</td>
                  <td style={styles.td}>{e.provider}</td>
                  <td style={styles.tdMono}>{e.event_type}{e.provider_event_id ? ` · ${e.provider_event_id}` : ''}</td>
                  <td style={styles.td}>{t(`paymentProblems.webhookStatus.${e.status}`, { defaultValue: e.status })}</td>
                  <td style={styles.td}>{e.transaction_id ? `#${e.transaction_id}` : '—'}</td>
                  <td style={{ ...styles.td, maxWidth: 320, whiteSpace: 'normal' }}>{e.error_message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={q.data?.meta} page={page} onPage={setPage} />
    </>
  );
}

function UnsettledTransactions() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['payment-unsettled-transactions', page],
    queryFn: async () => {
      const res = await api.GET('/payment-gateways/unsettled-transactions', { params: { query: { page, limit: PAGE_SIZE } } });
      if (res.error) throw new Error('load failed');
      return res.data as Page<UnsettledTransaction>;
    },
  });
  const rows = q.data?.data ?? [];
  return (
    <>
      <p style={styles.msg}>{t('paymentProblems.unsettledHelp')}</p>
      {q.isLoading ? <LoadingState /> : q.isError ? <p style={styles.msgError}>{t('paymentProblems.loadError')}</p> : rows.length === 0 ? (
        <p style={styles.msg}>{t('paymentProblems.noUnsettled')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('paymentProblems.col.charged')}</th>
                <th style={styles.th}>{t('paymentProblems.col.transaction')}</th>
                <th style={styles.th}>{t('paymentProblems.col.reference')}</th>
                <th style={styles.th}>{t('paymentProblems.col.client')}</th>
                <th style={styles.th}>{t('paymentProblems.col.invoice')}</th>
                <th style={styles.thNum}>{t('paymentProblems.col.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(tx => (
                <tr key={tx.id} style={styles.tr}>
                  <td style={styles.td}>{formatDate(tx.created_at)}</td>
                  <td style={styles.td}>#{tx.id}</td>
                  <td style={styles.tdMono}>{tx.gateway_reference_id ?? '—'}</td>
                  <td style={styles.td}>{tx.client_id ? `#${tx.client_id}` : '—'}</td>
                  <td style={styles.td}>{tx.invoice_id ? `#${tx.invoice_id}` : '—'}</td>
                  <td style={styles.tdNum}>{formatMoney(tx.amount, tx.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={q.data?.meta} page={page} onPage={setPage} />
    </>
  );
}

function RefundsWithLiveRep() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['payment-refunded-with-live-rep', page],
    queryFn: async () => {
      const res = await api.GET('/payment-gateways/refunded-with-live-rep', { params: { query: { page, limit: PAGE_SIZE } } });
      if (res.error) throw new Error('load failed');
      return res.data as Page<RefundedWithRep>;
    },
  });
  const rows = q.data?.data ?? [];
  return (
    <>
      <p style={styles.msg}>{t('paymentProblems.refundsHelp')}</p>
      {q.isLoading ? <LoadingState /> : q.isError ? <p style={styles.msgError}>{t('paymentProblems.loadError')}</p> : rows.length === 0 ? (
        <p style={styles.msg}>{t('paymentProblems.noRefunds')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('paymentProblems.col.payment')}</th>
                <th style={styles.th}>{t('paymentProblems.col.client')}</th>
                <th style={styles.thNum}>{t('paymentProblems.col.amount')}</th>
                <th style={styles.th}>{t('paymentProblems.col.rep')}</th>
                <th style={styles.th}>{t('paymentProblems.col.satStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.payment_id}-${r.rep_id}`} style={styles.tr}>
                  <td style={styles.td}>#{r.payment_id}{r.reference_number ? ` · ${r.reference_number}` : ''}</td>
                  <td style={styles.td}>{r.client_id ? `#${r.client_id}` : '—'}</td>
                  <td style={styles.tdNum}>{formatMoney(r.amount, r.currency)}</td>
                  <td style={styles.tdMono}>{r.rep_uuid ?? `#${r.rep_id}`}</td>
                  <td style={styles.td}>{r.rep_sat_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager meta={q.data?.meta} page={page} onPage={setPage} />
    </>
  );
}

export function PaymentProblems() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('webhooks');
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('paymentProblems.title')}</h1>
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('paymentProblems.description')}</p>
      <div role="tablist" aria-label={t('paymentProblems.title')} style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map(k => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            style={tab === k ? styles.btnPrimary : styles.btnSecondary}
            onClick={() => setTab(k)}
          >
            {t(`paymentProblems.tab.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" style={{ ...styles.tableCard, padding: 12 }}>
        {tab === 'webhooks' && <WebhookEvents />}
        {tab === 'unsettled' && <UnsettledTransactions />}
        {tab === 'refunds' && <RefundsWithLiveRep />}
      </div>
    </div>
  );
}
