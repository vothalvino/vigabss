// =============================================================================
// A reseller's cash bags (GET /resellers/:id/bags, cash_bags.view)
// =============================================================================
// Every bag a top-level reseller has held (its sub-resellers seal on its
// account): status, what it declared and what the ISP counted, and the
// total difference of the bags received (counted − declared: below zero the
// bags came short). A row opens the bag's history (GET /cash-bags/:id) and
// the actions the user may take on it.
// =============================================================================

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import { cashBagKeys, fetchResellerBags, toAmount } from '../cashBags/cashBagsApi';
import { CashBagDetailDialog } from '../cashBags/CashBagDetailDialog';
import { BagStatusBadge, VarianceText, formatMoment, mono } from '../cashBags/cashBagUi';
import { ResellerListNotice, useResellerOptions } from './resellerOptions';

const PAGE_SIZE = 25;

export function ResellerBagsTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const currency = user?.organization_currency || 'MXN';
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const resellers = useResellerOptions({ topLevel: true });
  const bags = useQuery({
    queryKey: cashBagKeys.resellerBags(resellerId ?? 0, page),
    enabled: resellerId !== null,
    queryFn: () => fetchResellerBags(resellerId ?? 0, page, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const rows = bags.data?.data ?? [];
  const total = bags.data?.meta?.total ?? rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // The server's total; without one, the received bags of this page.
  const variance = bags.data
    ? bags.data.variance ?? Math.round(rows.filter(b => b.status === 'received').reduce((acc, b) => acc + toAmount(b.variance), 0) * 100) / 100
    : null;

  return (
    <div>
      <h3>{t('cashBags.resellerTab.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('cashBags.resellerTab.help')}</p>
      <label style={styles.filterLabel}>
        {t('resellerLedger.reseller')}
        <select style={styles.filterSelect} value={resellerId ?? ''} onChange={e => { setResellerId(Number(e.target.value) || null); setPage(1); }}>
          <option value="">{t('resellerLedger.selectReseller')}</option>
          {(resellers.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <ResellerListNotice list={resellers.data} />

      {resellerId !== null && (bags.isLoading ? <LoadingState /> : bags.isError ? (
        <p style={styles.msgError}>{t('cashBags.resellerTab.loadError')}</p>
      ) : (
        <>
          <section aria-label={t('cashBags.resellerTab.varianceTotal')} style={{ ...styles.tableCard, padding: '0.75rem 1rem', margin: '16px 0', display: 'inline-block', minWidth: 220 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('cashBags.resellerTab.varianceTotal')}</div>
            <div style={{ fontSize: '1.2rem' }}><VarianceText variance={variance} currency={currency} /></div>
          </section>
          <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('cashBags.col.serial')}</th>
                  <th style={styles.th}>{t('cashBags.col.status')}</th>
                  <th style={styles.thNum}>{t('cashBags.col.declared')}</th>
                  <th style={styles.thNum}>{t('cashBags.col.counted')}</th>
                  <th style={styles.th}>{t('cashBags.col.variance')}</th>
                  <th style={styles.th}>{t('cashBags.col.sealed')}</th>
                  <th style={styles.th}>{t('cashBags.col.received')}</th>
                  <th style={styles.th}>{t('cashBags.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={8} style={styles.emptyCell}>{t('cashBags.resellerTab.empty')}</td></tr>}
                {rows.map(b => (
                  <tr key={b.id} style={styles.tr}>
                    <td style={{ ...styles.td, ...mono }}>{b.serial}</td>
                    <td style={styles.td}><BagStatusBadge status={b.status} /></td>
                    <td style={styles.tdNum}>{formatMoney(b.declared_amount, b.currency || currency)}</td>
                    <td style={styles.tdNum}>{formatMoney(b.counted_amount, b.currency || currency)}</td>
                    <td style={styles.td}><VarianceText variance={b.variance} currency={b.currency || currency} /></td>
                    <td style={styles.td}>{formatMoment(b.sealed_at)}</td>
                    <td style={styles.td}>{formatMoment(b.received_at)}</td>
                    <td style={styles.td}>
                      <button type="button" style={styles.actionBtn} onClick={() => setOpen(b.id)} aria-label={t('cashBags.actions.historySerial', { serial: b.serial })}>
                        {t('cashBags.actions.history')}
                      </button>
                    </td>
                  </tr>
                ))}
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
      {open !== null && <CashBagDetailDialog bagId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
