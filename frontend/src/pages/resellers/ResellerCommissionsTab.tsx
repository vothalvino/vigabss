// =============================================================================
// Reseller commissions (GET /resellers/:id/commissions, migration 007)
// =============================================================================
// A reseller earns its commission_rate % of the subtotal (taxes excluded) of
// every paid invoice of a client it brought in, whoever collected the money.
// The rate and the account are the top-level reseller's, also for the
// clients of its sub-resellers, so only top-level resellers are listed. A
// commission is earned when the invoice becomes paid and reversed when it
// stops being paid (a payment deleted, refunded or voided, a credit note
// cancelled, the invoice voided...); paying it again earns it again on the
// same row. Each change has its line in the reseller's cash movements: the
// reseller keeps the commission from the cash it holds, so nothing is
// approved or paid here (a negative balance is paid with a payout in
// Movements). Read only, with reseller_commissions.view.
// =============================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import { ResellerListNotice, resellersOnly, useResellerOptions } from './resellerOptions';

const PAGE_SIZE = 25;
const DATETIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

type StatusFilter = '' | 'earned' | 'reversed';

export interface CommissionRow {
  id: number;
  reseller_id: number;
  invoice_id: number;
  invoice_number: string | null;
  client_id: number;
  client_name: string | null;
  commission_rate: number | string | null;
  base_amount: number | string | null;
  invoice_total: number | string | null;
  commission_amount: number | string | null;
  currency: string;
  status: 'earned' | 'reversed' | string;
  earned_at: string | null;
  reversed_at: string | null;
  created_at: string | null;
}

export interface CommissionPage {
  data: CommissionRow[];
  summary?: { earned: number | string; reversed: number | string; earned_this_month: number | string } | null;
  meta?: { total: number; page: number; limit: number } | null;
}

const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  earned: { background: 'var(--success-soft)', color: 'var(--success)' },
  reversed: { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
};

const rate = (value: number | string | null) => `${Math.round(Number(value ?? 0) * 100) / 100}%`;

export function ResellerCommissionsTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canSeeInvoices = can(user, 'invoices.view');
  const orgCurrency = user?.organization_currency || 'MXN';
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);

  const resellersQ = useResellerOptions({ topLevel: true });
  const listQ = useQuery({
    queryKey: ['reseller-commissions', resellerId, status, page],
    enabled: resellerId !== null,
    queryFn: () => apiFetch<CommissionPage>(
      `/resellers/${resellerId}/commissions?${status ? `status=${status}&` : ''}page=${page}&limit=${PAGE_SIZE}`,
    ),
    placeholderData: keepPreviousData,
  });
  const rows = listQ.data?.data ?? [];
  const summary = listQ.data?.summary;
  const total = listQ.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fmt = (v: number | string | null | undefined, currency = orgCurrency) => formatMoney(v ?? 0, currency);

  return (
    <div>
      <h3>{t('resellerCommissions.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerCommissions.help')}</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={styles.filterLabel}>
          {t('resellerCommissions.reseller')}
          <select
            style={styles.filterSelect}
            value={resellerId ?? ''}
            onChange={e => { setResellerId(Number(e.target.value) || null); setPage(1); }}
          >
            <option value="">{t('resellerCommissions.selectReseller')}</option>
            {resellersOnly(resellersQ.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('resellerCommissions.status')}
          <select
            style={styles.filterSelect}
            value={status}
            onChange={e => { setStatus(e.target.value as StatusFilter); setPage(1); }}
          >
            <option value="">{t('resellerCommissions.statusAll')}</option>
            <option value="earned">{t('resellerCommissions.statuses.earned')}</option>
            <option value="reversed">{t('resellerCommissions.statuses.reversed')}</option>
          </select>
        </label>
      </div>
      <ResellerListNotice list={resellersQ.data} />
      {resellersQ.isError && <p style={styles.msgError}>{t('resellerCommissions.resellersError')}</p>}

      {resellerId !== null && (listQ.isLoading ? <LoadingState /> : listQ.isError ? (
        <p style={styles.msgError}>{t('resellerCommissions.loadError')}</p>
      ) : (
        <>
          {summary && (
            <section aria-label={t('resellerCommissions.summary')} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
              {[
                { label: t('resellerCommissions.earnedThisMonth'), value: fmt(summary.earned_this_month) },
                { label: t('resellerCommissions.earnedTotal'), value: fmt(summary.earned) },
                { label: t('resellerCommissions.reversedTotal'), value: fmt(summary.reversed) },
              ].map(card => (
                <div key={card.label} style={{ ...styles.tableCard, padding: '0.75rem 1rem', minWidth: 180 }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{card.label}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{card.value}</div>
                </div>
              ))}
            </section>
          )}
          <div style={styles.tableCard}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('resellerCommissions.colEarned')}</th>
                  <th style={styles.th}>{t('resellerCommissions.colInvoice')}</th>
                  <th style={styles.th}>{t('resellerCommissions.colClient')}</th>
                  <th style={styles.thNum}>{t('resellerCommissions.colBase')}</th>
                  <th style={styles.thNum}>{t('resellerCommissions.colRate')}</th>
                  <th style={styles.thNum}>{t('resellerCommissions.colAmount')}</th>
                  <th style={styles.th}>{t('resellerCommissions.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} style={styles.emptyCell}>{t('resellerCommissions.empty')}</td></tr>
                )}
                {rows.map(c => {
                  const reversed = c.status === 'reversed';
                  const invoiceLabel = c.invoice_number || `#${c.invoice_id}`;
                  return (
                    <tr key={c.id} style={styles.tr}>
                      <td style={styles.td}>{formatDate(c.earned_at ?? c.created_at, DATETIME)}</td>
                      <td style={styles.td}>
                        {canSeeInvoices ? <Link to={`/invoices/${c.invoice_id}`}>{invoiceLabel}</Link> : invoiceLabel}
                      </td>
                      <td style={styles.td}>{c.client_name ?? `#${c.client_id}`}</td>
                      <td style={styles.tdNum}>{fmt(c.base_amount, c.currency)}</td>
                      <td style={styles.tdNum}>{rate(c.commission_rate)}</td>
                      <td style={{ ...styles.tdNum, ...(reversed ? { textDecoration: 'line-through', color: 'var(--text-secondary)' } : {}) }}>
                        {fmt(c.commission_amount, c.currency)}
                      </td>
                      <td style={styles.td}>
                        <span style={{
                          ...(STATUS_STYLE[c.status] ?? STATUS_STYLE.reversed),
                          display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600,
                        }}>
                          {t(`resellerCommissions.statuses.${c.status}`, { defaultValue: c.status })}
                        </span>
                        {reversed && c.reversed_at && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                            {t('resellerCommissions.reversedOn', { date: formatDate(c.reversed_at, DATETIME) })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div style={styles.pagination}>
              <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('punto.common.previous')}</button>
              <span style={styles.pageInfo}>{t('punto.common.pageOf', { page, pages })}</span>
              <button type="button" style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('punto.common.next')}</button>
            </div>
          )}
        </>
      ))}
    </div>
  );
}
