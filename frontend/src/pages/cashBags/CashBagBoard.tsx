// =============================================================================
// Cash bags (staff) — the bags
// =============================================================================
// On top, four numbers: the sealed bags waiting at a point and the ones on
// their way, and the cash each group holds (cash that already left the
// points' accounts when the bags were sealed, migration 006). Below, one list
// of every bag with its filters: status, point, carrier, zone, serial, a date
// range on the sealed, picked-up or received date, and only the bags counted
// differently than declared. The carrier and the zone narrow the numbers too.
// A row opens the bag with its history and the actions its state allows;
// "Receive" opens the count.
// =============================================================================

import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import {
  BAG_STATUSES, cashBagKeys, fetchCarriers, fetchCashBagDashboard, fetchCashBags, fetchZones,
  type BagDateField, type BagFilters,
} from './cashBagsApi';
import { RECEIVABLE } from './CashBagActions';
import { CashBagDetailDialog, type BagAction } from './CashBagDetailDialog';
import { AssignBagsForm, RegisterBagsForm } from './CashBagForms';
import { BagStatusBadge, VarianceText, formatMoment, mono } from './cashBagUi';
import { ResellerListNotice, useResellerOptions } from '../resellers/resellerOptions';

const PAGE_SIZE = 25;
const DATE_FIELDS: BagDateField[] = ['sealed', 'picked_up', 'received'];

interface Filters {
  status: string; reseller_id: number | null; carrier_user_id: number | null; zone: string; serial: string;
  date_field: BagDateField; date_from: string; date_to: string; has_variance: boolean;
}
const NO_FILTERS: Filters = {
  status: '', reseller_id: null, carrier_user_id: null, zone: '', serial: '',
  date_field: 'sealed', date_from: '', date_to: '', has_variance: false,
};

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'money' }) {
  return (
    <div style={{ ...styles.tableCard, padding: '0.9rem 1rem', flex: '1 1 180px', minWidth: 170 }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: tone === 'money' ? '1.35rem' : '1.7rem', fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

export function CashBagBoard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const currency = user?.organization_currency || 'MXN';
  const canManage = can(user, 'cash_bags.manage');
  const canReceive = can(user, 'cash_bags.receive');
  const canCarriers = can(user, 'carriers.manage');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState<'register' | 'assign' | null>(null);
  const [open, setOpen] = useState<{ id: number; action: BagAction } | null>(null);
  const resellers = useResellerOptions({ topLevel: true, enabled: can(user, 'resellers.view') });
  const carriers = useQuery({ queryKey: cashBagKeys.carriers, queryFn: fetchCarriers, enabled: canCarriers });
  const zones = useQuery({ queryKey: cashBagKeys.zones, queryFn: fetchZones });
  const dashboard = useQuery({
    queryKey: cashBagKeys.dashboard(filters.carrier_user_id, filters.zone),
    queryFn: () => fetchCashBagDashboard(filters.carrier_user_id, filters.zone),
    placeholderData: keepPreviousData,
  });
  const query: BagFilters = {
    status: filters.status, reseller_id: filters.reseller_id, carrier_user_id: filters.carrier_user_id,
    zone: filters.zone, serial: filters.serial.trim().toUpperCase(),
    date_field: filters.date_field, date_from: filters.date_from, date_to: filters.date_to,
    has_variance: filters.has_variance, page, limit: PAGE_SIZE,
  };
  const bags = useQuery({
    queryKey: cashBagKeys.list({ ...query, reseller_id: query.reseller_id ?? null, carrier_user_id: query.carrier_user_id ?? null, has_variance: query.has_variance ? 1 : 0 } as Record<string, string | number | null>),
    queryFn: () => fetchCashBags(query),
    placeholderData: keepPreviousData,
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: cashBagKeys.all }); };
  // A filter changes what the list holds, so it starts again from the first page.
  const set = (patch: Partial<Filters>) => { setFilters(f => ({ ...f, ...patch })); setPage(1); };
  const active = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const total = bags.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = bags.data?.data ?? [];
  const d = dashboard.data;

  return (
    <div>
      <section aria-label={t('cashBags.dash.title')} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <Tile label={t('cashBags.dash.readyBags')} value={String(d?.ready.bags ?? '—')} />
        <Tile label={t('cashBags.dash.transitBags')} value={String(d?.in_transit.bags ?? '—')} />
        <Tile tone="money" label={t('cashBags.dash.readyAmount')} value={d ? formatMoney(d.ready.amount, currency) : '—'} />
        <Tile tone="money" label={t('cashBags.dash.transitAmount')} value={d ? formatMoney(d.in_transit.amount, currency) : '—'} />
      </section>
      <p style={{ margin: '0 0 14px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        {filters.carrier_user_id || filters.zone ? t('cashBags.dash.filtered') : t('cashBags.dash.help')}
      </p>

      <div role="group" aria-label={t('cashBags.filters.title')} style={{ ...styles.filterRow, flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <label style={styles.filterLabel}>
          {t('cashBags.col.status')}{' '}
          <select style={styles.filterSelect} value={filters.status} onChange={e => set({ status: e.target.value })}>
            <option value="">{t('cashBags.board.allStatuses')}</option>
            {BAG_STATUSES.map(s => <option key={s} value={s}>{t(`cashBags.status.${s}`)}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('cashBags.col.reseller')}{' '}
          <select style={styles.filterSelect} value={filters.reseller_id ?? ''} onChange={e => set({ reseller_id: Number(e.target.value) || null })}>
            <option value="">{t('cashBags.board.allResellers')}</option>
            {(resellers.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        {canCarriers && (
          <label style={styles.filterLabel}>
            {t('cashBags.col.carrier')}{' '}
            <select style={styles.filterSelect} value={filters.carrier_user_id ?? ''} onChange={e => set({ carrier_user_id: Number(e.target.value) || null })}>
              <option value="">{t('cashBags.board.allCarriers')}</option>
              {(carriers.data ?? []).map(c => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label style={styles.filterLabel}>
          {t('cashBags.col.zone')}{' '}
          <select style={styles.filterSelect} value={filters.zone} onChange={e => set({ zone: e.target.value })}>
            <option value="">{t('cashBags.filters.allZones')}</option>
            {(zones.data ?? []).map(z => <option key={z.id} value={String(z.id)}>{z.name}</option>)}
            <option value="none">{t('cashBags.filters.noZone')}</option>
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('cashBags.col.serial')}{' '}
          <input type="search" style={styles.filterSelect} maxLength={64} value={filters.serial} onChange={e => set({ serial: e.target.value })} />
        </label>
        <label style={styles.filterLabel}>
          {t('cashBags.filters.dateOf')}{' '}
          <select style={styles.filterSelect} value={filters.date_field} onChange={e => set({ date_field: e.target.value as BagDateField })}>
            {DATE_FIELDS.map(f => <option key={f} value={f}>{t(`cashBags.filters.dates.${f}`)}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('cashBags.filters.from')}{' '}
          <input type="date" style={styles.filterSelect} value={filters.date_from} max={filters.date_to || undefined} onChange={e => set({ date_from: e.target.value })} />
        </label>
        <label style={styles.filterLabel}>
          {t('cashBags.filters.to')}{' '}
          <input type="date" style={styles.filterSelect} value={filters.date_to} min={filters.date_from || undefined} onChange={e => set({ date_to: e.target.value })} />
        </label>
        <label style={{ ...styles.filterLabel, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={filters.has_variance} onChange={e => set({ has_variance: e.target.checked })} />
          {t('cashBags.filters.differences')}
        </label>
        {active && <button type="button" style={styles.btnSecondary} onClick={() => { setFilters(NO_FILTERS); setPage(1); }}>{t('cashBags.filters.clear')}</button>}
      </div>
      <ResellerListNotice list={resellers.data} />

      {canManage && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0 0' }}>
          <button type="button" style={styles.btnSecondary} aria-expanded={panel === 'register'} onClick={() => setPanel(p => (p === 'register' ? null : 'register'))}>{t('cashBags.register.open')}</button>
          <button type="button" style={styles.btnSecondary} aria-expanded={panel === 'assign'} onClick={() => setPanel(p => (p === 'assign' ? null : 'assign'))}>{t('cashBags.assign.open')}</button>
        </div>
      )}
      {canManage && panel === 'register' && <div style={{ display: 'flex', margin: '12px 0' }}><RegisterBagsForm onSaved={refresh} /></div>}
      {canManage && panel === 'assign' && <div style={{ display: 'flex', margin: '12px 0' }}><AssignBagsForm onSaved={refresh} /></div>}

      <p role="status" style={{ margin: '14px 0 6px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('cashBags.filters.count', { count: total })}</p>
      {bags.isError && <p style={styles.msgError}>{t('cashBags.board.loadError')}</p>}
      <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{t('cashBags.col.serial')}</th>
              <th style={styles.th}>{t('cashBags.col.status')}</th>
              <th style={styles.th}>{t('cashBags.col.reseller')}</th>
              <th style={styles.th}>{t('cashBags.col.zone')}</th>
              <th style={styles.th}>{t('cashBags.col.carrier')}</th>
              <th style={styles.thNum}>{t('cashBags.col.declared')}</th>
              <th style={styles.thNum}>{t('cashBags.col.counted')}</th>
              <th style={styles.th}>{t('cashBags.col.variance')}</th>
              <th style={styles.th}>{t('cashBags.col.sealed')}</th>
              <th style={styles.th}>{t('cashBags.col.updated')}</th>
              <th style={styles.th}>{t('cashBags.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {bags.data && rows.length === 0 && <tr><td colSpan={11} style={styles.emptyCell}>{t('cashBags.board.none')}</td></tr>}
            {rows.map(b => (
              <tr key={b.id} style={styles.tr}>
                <td style={{ ...styles.td, ...mono }}>{b.serial}</td>
                <td style={styles.td}><BagStatusBadge status={b.status} /></td>
                <td style={styles.td}>{b.reseller_name ?? '—'}</td>
                <td style={styles.td}>{b.zone_name ?? '—'}</td>
                <td style={styles.td}>{b.carrier_name ?? '—'}</td>
                <td style={styles.tdNum}>{formatMoney(b.declared_amount, b.currency || currency)}</td>
                <td style={styles.tdNum}>{formatMoney(b.counted_amount, b.currency || currency)}</td>
                <td style={styles.td}><VarianceText variance={b.variance} currency={b.currency || currency} /></td>
                <td style={styles.td}>{b.sealed_at ? formatMoment(b.sealed_at) : '—'}</td>
                <td style={styles.td}>{formatMoment(b.updated_at ?? b.created_at)}</td>
                <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                  {canReceive && RECEIVABLE.has(b.status) && (
                    <button type="button" style={{ ...styles.actionBtn, marginRight: 6 }} onClick={() => setOpen({ id: b.id, action: 'receive' })} aria-label={t('cashBags.actions.receiveSerial', { serial: b.serial })}>
                      {t('cashBags.actions.receive')}
                    </button>
                  )}
                  <button type="button" style={styles.actionBtn} onClick={() => setOpen({ id: b.id, action: null })} aria-label={t('cashBags.actions.openSerial', { serial: b.serial })}>
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

      {open && <CashBagDetailDialog key={`${open.id}-${open.action ?? ''}`} bagId={open.id} start={open.action} onClose={() => setOpen(null)} />}
    </div>
  );
}
