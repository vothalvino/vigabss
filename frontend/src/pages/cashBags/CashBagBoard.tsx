// =============================================================================
// Cash bags (staff) — the board
// =============================================================================
// Columns: bags ready for pickup at a reseller, on their way with a carrier,
// recently received, and the count differences per reseller (summary), with
// the cash those sealed bags hold, which already left the resellers' ledgers
// when they were sealed (migration 006). The
// filters (reseller, carrier, serial) apply to every column and to the list
// of all bags below, which also reaches bags in stock, with a carrier, empty
// at a reseller, void and lost. A card or a row opens the bag with its
// history and the actions its state allows; "Recibir" opens the count.
// =============================================================================

import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import {
  BAG_STATUSES, cashBagKeys, fetchCarriers, fetchCashBagSummary, fetchCashBags, toAmount,
  type BagFilters, type CashBag,
} from './cashBagsApi';
import { RECEIVABLE } from './CashBagActions';
import { CashBagDetailDialog, type BagAction } from './CashBagDetailDialog';
import { HandoverForm, RegisterBagsForm } from './CashBagForms';
import { BagStatusBadge, VarianceText, formatMoment, mono } from './cashBagUi';
import { ResellerListNotice, useResellerOptions } from '../resellers/resellerOptions';

const PAGE_SIZE = 25;
const COLUMN_SIZE = 20;

interface Filters { reseller_id: number | null; carrier_user_id: number | null; serial: string }

function useBags(status: string, f: Filters, limit: number, page = 1) {
  const filters: BagFilters = { status, reseller_id: f.reseller_id, carrier_user_id: f.carrier_user_id, serial: f.serial.trim().toUpperCase(), page, limit };
  return useQuery({
    queryKey: cashBagKeys.list({ status, reseller_id: f.reseller_id, carrier_user_id: f.carrier_user_id, serial: filters.serial ?? '', page, limit }),
    queryFn: () => fetchCashBags(filters),
    placeholderData: keepPreviousData,
  });
}

function BagCard({ bag, currency, onOpen }: { bag: CashBag; currency: string; onOpen: (id: number, action: BagAction) => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canReceive = can(user, 'cash_bags.receive');
  return (
    <li style={{ ...styles.tableCard, padding: '0.6rem 0.75rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span style={mono}>{bag.serial}</span>
        <BagStatusBadge status={bag.status} />
      </div>
      <div style={{ fontSize: '0.82rem' }}>{bag.reseller_name ?? '—'}{bag.carrier_name ? ` · ${bag.carrier_name}` : ''}</div>
      <div style={{ fontSize: '0.82rem' }}>
        {t('cashBags.col.declared')}: <strong>{formatMoney(bag.declared_amount, bag.currency || currency)}</strong>
        {bag.status === 'received' && <> · <VarianceText variance={bag.variance} currency={bag.currency || currency} /></>}
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        {formatMoment(bag.received_at ?? bag.picked_up_at ?? bag.sealed_at ?? bag.updated_at)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canReceive && RECEIVABLE.has(bag.status) && (
          <button type="button" style={styles.btnPrimary} onClick={() => onOpen(bag.id, 'receive')} aria-label={t('cashBags.actions.receiveSerial', { serial: bag.serial })}>
            {t('cashBags.actions.receive')}
          </button>
        )}
        <button type="button" style={styles.btnSecondary} onClick={() => onOpen(bag.id, null)} aria-label={t('cashBags.actions.openSerial', { serial: bag.serial })}>
          {t('cashBags.actions.open')}
        </button>
      </div>
    </li>
  );
}

function Column({ id, title, status, filters, currency, onOpen }: { id: string; title: string; status: string; filters: Filters; currency: string; onOpen: (id: number, action: BagAction) => void }) {
  const { t } = useTranslation();
  const q = useBags(status, filters, COLUMN_SIZE);
  const total = q.data?.meta?.total ?? q.data?.data.length ?? 0;
  return (
    <section aria-labelledby={id} style={{ flex: '1 1 240px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 id={id} style={{ margin: 0, fontSize: '0.95rem' }}>{title} <span style={styles.countBadge}>{total}</span></h3>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('cashBags.board.loadError')} onRetry={() => { void q.refetch(); }} />}
      {q.data && q.data.data.length === 0 && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('cashBags.board.empty')}</p>}
      {q.data && q.data.data.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {q.data.data.map(b => <BagCard key={b.id} bag={b} currency={currency} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  );
}

function DifferencesColumn({ currency, resellerId }: { currency: string; resellerId: number | null }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: cashBagKeys.summary, queryFn: fetchCashBagSummary });
  const rows = (q.data?.resellers ?? []).filter(r => toAmount(r.variance) !== 0 && (!resellerId || r.reseller_id === resellerId));
  return (
    <section aria-labelledby="cash-bags-col-diff" style={{ flex: '1 1 240px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 id="cash-bags-col-diff" style={{ margin: 0, fontSize: '0.95rem' }}>{t('cashBags.board.differences')}</h3>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('cashBags.board.loadError')} onRetry={() => { void q.refetch(); }} />}
      {q.data && rows.length === 0 && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('cashBags.board.noDifferences')}</p>}
      {rows.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(r => (
            <li key={r.reseller_id} style={{ ...styles.tableCard, padding: '0.6rem 0.75rem' }}>
              <div style={{ fontWeight: 600 }}>{r.reseller_name}</div>
              <div style={{ fontSize: '0.82rem' }}>
                <VarianceText variance={r.variance} currency={currency} /> · {t('cashBags.board.receivedCount', { count: r.received })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AllBags({ filters, currency, onOpen }: { filters: Filters; currency: string; onOpen: (id: number, action: BagAction) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useBags(status, filters, PAGE_SIZE, page);
  const total = q.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <section aria-labelledby="cash-bags-all" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 id="cash-bags-all" style={{ margin: 0 }}>{t('cashBags.board.allTitle')}</h3>
        <label style={styles.filterLabel}>
          {t('cashBags.col.status')}{' '}
          <select style={styles.filterSelect} value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{t('cashBags.board.allStatuses')}</option>
            {BAG_STATUSES.map(s => <option key={s} value={s}>{t(`cashBags.status.${s}`)}</option>)}
          </select>
        </label>
      </div>
      {q.isError && <p style={styles.msgError}>{t('cashBags.board.loadError')}</p>}
      <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{t('cashBags.col.serial')}</th>
              <th style={styles.th}>{t('cashBags.col.status')}</th>
              <th style={styles.th}>{t('cashBags.col.reseller')}</th>
              <th style={styles.th}>{t('cashBags.col.carrier')}</th>
              <th style={styles.thNum}>{t('cashBags.col.declared')}</th>
              <th style={styles.thNum}>{t('cashBags.col.counted')}</th>
              <th style={styles.th}>{t('cashBags.col.variance')}</th>
              <th style={styles.th}>{t('cashBags.col.updated')}</th>
              <th style={styles.th}>{t('cashBags.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {q.data && q.data.data.length === 0 && <tr><td colSpan={9} style={styles.emptyCell}>{t('cashBags.board.none')}</td></tr>}
            {(q.data?.data ?? []).map(b => (
              <tr key={b.id} style={styles.tr}>
                <td style={{ ...styles.td, ...mono }}>{b.serial}</td>
                <td style={styles.td}><BagStatusBadge status={b.status} /></td>
                <td style={styles.td}>{b.reseller_name ?? '—'}</td>
                <td style={styles.td}>{b.carrier_name ?? '—'}</td>
                <td style={styles.tdNum}>{formatMoney(b.declared_amount, b.currency || currency)}</td>
                <td style={styles.tdNum}>{formatMoney(b.counted_amount, b.currency || currency)}</td>
                <td style={styles.td}><VarianceText variance={b.variance} currency={b.currency || currency} /></td>
                <td style={styles.td}>{formatMoment(b.updated_at ?? b.created_at)}</td>
                <td style={styles.td}>
                  <button type="button" style={styles.actionBtn} onClick={() => onOpen(b.id, null)} aria-label={t('cashBags.actions.openSerial', { serial: b.serial })}>
                    {t('cashBags.actions.open')}
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
    </section>
  );
}

export function CashBagBoard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const currency = user?.organization_currency || 'MXN';
  const canManage = can(user, 'cash_bags.manage');
  const canCarriers = can(user, 'carriers.manage');
  const [filters, setFilters] = useState<Filters>({ reseller_id: null, carrier_user_id: null, serial: '' });
  const [panel, setPanel] = useState<'register' | 'handover' | null>(null);
  const [open, setOpen] = useState<{ id: number; action: BagAction } | null>(null);
  const resellers = useResellerOptions({ topLevel: true, enabled: can(user, 'resellers.view') });
  const carriers = useQuery({ queryKey: cashBagKeys.carriers, queryFn: fetchCarriers, enabled: canCarriers });
  const summary = useQuery({ queryKey: cashBagKeys.summary, queryFn: fetchCashBagSummary });
  const refresh = () => { void qc.invalidateQueries({ queryKey: cashBagKeys.all }); };
  const onOpen = (id: number, action: BagAction) => setOpen({ id, action });

  return (
    <div>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0, fontStyle: 'normal' }}>{t('cashBags.board.help')}</p>
      {summary.data && (
        <ul aria-label={t('cashBags.board.counts')} style={{ listStyle: 'none', padding: 0, margin: '12px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {BAG_STATUSES.map(s => (
            <li key={s} style={{ ...styles.tableCard, padding: '0.4rem 0.75rem', display: 'flex', gap: 6, alignItems: 'center' }}>
              <BagStatusBadge status={s} /> <strong>{summary.data.counts[s] ?? 0}</strong>
            </li>
          ))}
        </ul>
      )}
      {summary.data && summary.data.in_bags !== null && (
        <p style={{ margin: '0 0 12px' }}>{t('cashBags.board.inBags', { amount: formatMoney(summary.data.in_bags, currency) })}</p>
      )}

      <div style={{ ...styles.filterRow, flexWrap: 'wrap' }}>
        <label style={styles.filterLabel}>
          {t('cashBags.col.reseller')}{' '}
          <select style={styles.filterSelect} value={filters.reseller_id ?? ''} onChange={e => setFilters(f => ({ ...f, reseller_id: Number(e.target.value) || null }))}>
            <option value="">{t('cashBags.board.allResellers')}</option>
            {(resellers.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <ResellerListNotice list={resellers.data} />
        {canCarriers && (
          <label style={styles.filterLabel}>
            {t('cashBags.col.carrier')}{' '}
            <select style={styles.filterSelect} value={filters.carrier_user_id ?? ''} onChange={e => setFilters(f => ({ ...f, carrier_user_id: Number(e.target.value) || null }))}>
              <option value="">{t('cashBags.board.allCarriers')}</option>
              {(carriers.data ?? []).map(c => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label style={styles.filterLabel}>
          {t('cashBags.col.serial')}{' '}
          <input type="search" style={styles.filterSelect} maxLength={64} value={filters.serial} onChange={e => setFilters(f => ({ ...f, serial: e.target.value }))} />
        </label>
        {canManage && (
          <>
            <button type="button" style={styles.btnSecondary} aria-expanded={panel === 'register'} onClick={() => setPanel(p => (p === 'register' ? null : 'register'))}>{t('cashBags.register.open')}</button>
            <button type="button" style={styles.btnSecondary} aria-expanded={panel === 'handover'} onClick={() => setPanel(p => (p === 'handover' ? null : 'handover'))}>{t('cashBags.handover.open')}</button>
          </>
        )}
      </div>
      {canManage && panel === 'register' && <div style={{ display: 'flex', margin: '12px 0' }}><RegisterBagsForm onSaved={refresh} /></div>}
      {canManage && panel === 'handover' && <div style={{ display: 'flex', margin: '12px 0' }}><HandoverForm onSaved={refresh} /></div>}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 12 }}>
        <Column id="cash-bags-col-ready" title={t('cashBags.board.ready')} status="ready_for_pickup" filters={filters} currency={currency} onOpen={onOpen} />
        <Column id="cash-bags-col-transit" title={t('cashBags.board.transit')} status="in_transit" filters={filters} currency={currency} onOpen={onOpen} />
        <Column id="cash-bags-col-received" title={t('cashBags.board.received')} status="received" filters={filters} currency={currency} onOpen={onOpen} />
        <DifferencesColumn currency={currency} resellerId={filters.reseller_id} />
      </div>

      <AllBags filters={filters} currency={currency} onOpen={onOpen} />

      {open && <CashBagDetailDialog key={`${open.id}-${open.action ?? ''}`} bagId={open.id} start={open.action} onClose={() => setOpen(null)} />}
    </div>
  );
}
