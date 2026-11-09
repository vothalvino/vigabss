// =============================================================================
// Reseller statements (estados de cuenta) and settlement (phase 5, migration 008)
// =============================================================================
// GET/POST /resellers/:id/settlements and its actions. A statement closes a
// past period of a top-level reseller's cash ledger; its figures come from
// the ledger. Generating first runs the commission gap sweep. A draft can be
// regenerated, discarded or approved (reseller_settlements.approve); an
// approved one is settled with a bank reference: a deposit (the reseller
// owed) or a payout (the ISP owed) of the closing balance, or "record only"
// when that money was already recorded. Read: reseller_settlements.view;
// the rest: reseller_settlements.manage.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { extractApiError } from '@/components/ClientFormModal';
import { LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  STATEMENT_TOTAL_TYPES, apiErrorCode, downloadStatementPdf, toNumber,
  type PuntoLedgerEntry, type PuntoListMeta, type ResellerStatement,
} from '../punto/puntoApi';
import { styles } from '../crudStyles';
import { ResellerListNotice, useResellerOptions } from './resellerOptions';

const PAGE_SIZE = 12;
const LINES_PAGE = 50;
const DATETIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

interface Sweep { earned: number; restored: number; reversed: number; failed: number; truncated: boolean }
interface StatementList { data: ResellerStatement[]; meta: PuntoListMeta & { default_period?: { period_start: string; period_end: string } } }
interface StatementDetail { data: ResellerStatement; lines: PuntoLedgerEntry[]; meta: PuntoListMeta }

// Server refusals, in the reader's language.
const REFUSALS: Record<string, string> = {
  SETTLEMENT_PERIOD_OVERLAP: 'resellerStatements.errors.overlap',
  PERIOD_NOT_ENDED: 'resellerStatements.errors.notEnded',
  PERIOD_INVALID: 'resellerStatements.errors.invalid',
  PERIOD_TOO_LONG: 'resellerStatements.errors.tooLong',
  SETTLEMENT_EXCEEDS_BALANCE: 'resellerStatements.errors.exceeds',
  SETTLEMENT_NOT_DRAFT: 'resellerStatements.errors.notDraft',
  SETTLEMENT_NOT_APPROVED: 'resellerStatements.errors.notApproved',
};

const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  draft: { background: 'var(--warning-soft, #fff4e5)', color: 'var(--warning, #b26a00)' },
  approved: { background: 'var(--info-soft, #e8f1fb)', color: 'var(--info, #1a5276)' },
  settled: { background: 'var(--success-soft)', color: 'var(--success)' },
  void: { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
};

function StatementStatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span style={{
      ...(STATUS_STYLE[status] ?? STATUS_STYLE.void),
      display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600,
    }}>
      {t(`resellerStatements.statuses.${status}`, { defaultValue: status })}
    </span>
  );
}

function useRefusal() {
  const { t } = useTranslation();
  return (err: unknown, fallback: string) => {
    const key = REFUSALS[apiErrorCode(err) ?? ''];
    return key ? t(key) : extractApiError(err, fallback);
  };
}

function ClosingText({ closing, currency }: { closing: number; currency: string }) {
  const { t } = useTranslation();
  if (closing < 0) return <>{t('resellerStatements.closingOwedToReseller', { amount: formatMoney(-closing, currency) })}</>;
  return <>{t('resellerStatements.closingOwed', { amount: formatMoney(closing, currency) })}</>;
}

function GenerateForm({ resellerId, defaults, onDone }: {
  resellerId: number; defaults?: { period_start: string; period_end: string }; onDone: (msg: string, id: number) => void;
}) {
  const { t } = useTranslation();
  const refusal = useRefusal();
  const [start, setStart] = useState(defaults?.period_start ?? '');
  const [end, setEnd] = useState(defaults?.period_end ?? '');
  const [error, setError] = useState('');
  const gen = useMutation({
    mutationFn: () => apiFetch<{ data: ResellerStatement; sweep: Sweep }>(`/resellers/${resellerId}/settlements`, {
      method: 'POST',
      body: JSON.stringify(start && end ? { period_start: start, period_end: end } : {}),
    }),
    onSuccess: (res: { data: ResellerStatement; sweep: Sweep }) => {
      const s = res.sweep;
      onDone(t('resellerStatements.generated', {
        earned: (s?.earned ?? 0) + (s?.restored ?? 0), reversed: s?.reversed ?? 0,
      }), res.data.id);
    },
    onError: (err: unknown) => setError(refusal(err, t('resellerStatements.generateError'))),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if ((start && !end) || (!start && end)) { setError(t('resellerStatements.errors.bothDates')); return; }
    gen.mutate();
  }
  return (
    <form onSubmit={submit} style={{ ...styles.tableCard, padding: '0.75rem 1rem', margin: '12px 0', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <strong style={{ width: '100%' }}>{t('resellerStatements.generateTitle')}</strong>
      <label style={styles.filterLabel}>
        {t('resellerStatements.periodStart')}
        <input type="date" style={styles.filterSelect} value={start} onChange={e => setStart(e.target.value)} />
      </label>
      <label style={styles.filterLabel}>
        {t('resellerStatements.periodEnd')}
        <input type="date" style={styles.filterSelect} value={end} onChange={e => setEnd(e.target.value)} />
      </label>
      <button type="submit" style={styles.btnPrimary} disabled={gen.isPending}>
        {gen.isPending ? t('resellerStatements.generating') : t('resellerStatements.generate')}
      </button>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0, width: '100%', margin: 0 }}>{t('resellerStatements.generateHelp')}</p>
      {error && <p role="alert" style={{ ...styles.msgError, width: '100%', margin: 0 }}>{error}</p>}
    </form>
  );
}

function SettleForm({ resellerId, statement, onDone }: { resellerId: number; statement: ResellerStatement; onDone: (msg: string) => void }) {
  const { t } = useTranslation();
  const refusal = useRefusal();
  const [bankRef, setBankRef] = useState('');
  const [recordOnly, setRecordOnly] = useState(false);
  const [error, setError] = useState('');
  const closing = toNumber(statement.closing_balance);
  const settle = useMutation({
    mutationFn: () => apiFetch(`/resellers/${resellerId}/settlements/${statement.id}/settle`, {
      method: 'POST', body: JSON.stringify({ bank_ref: bankRef.trim(), record_only: recordOnly }),
    }),
    onSuccess: () => onDone(t('resellerStatements.settled')),
    onError: (err: unknown) => setError(refusal(err, t('resellerStatements.actionError'))),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!bankRef.trim()) { setError(t('resellerStatements.bankRefRequired')); return; }
    settle.mutate();
  }
  const what = closing > 0
    ? t('resellerStatements.settleDeposit', { amount: formatMoney(closing, statement.currency) })
    : closing < 0
      ? t('resellerStatements.settlePayout', { amount: formatMoney(-closing, statement.currency) })
      : t('resellerStatements.settleNothing');
  return (
    <form onSubmit={submit} style={{ ...styles.tableCard, padding: '0.75rem 1rem', marginTop: 12 }}>
      <strong>{t('resellerStatements.settleTitle')}</strong>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{recordOnly ? t('resellerStatements.settleRecordOnlyHelp') : what}</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={styles.filterLabel}>
          {t('resellerStatements.bankRef')}
          <input style={styles.filterSelect} value={bankRef} maxLength={100} onChange={e => setBankRef(e.target.value)} />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={recordOnly} onChange={e => setRecordOnly(e.target.checked)} />
          {t('resellerStatements.recordOnly')}
        </label>
        <button type="submit" style={styles.btnPrimary} disabled={settle.isPending}>{t('resellerStatements.settle')}</button>
      </div>
      {error && <p role="alert" style={{ ...styles.msgError, textAlign: 'left' }}>{error}</p>}
    </form>
  );
}

function StatementDetailView({ resellerId, statementId, onChanged }: { resellerId: number; statementId: number; onChanged: (msg: string) => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const refusal = useRefusal();
  const canManage = can(user, 'reseller_settlements.manage');
  const canApprove = can(user, 'reseller_settlements.approve');
  const canSeeInvoices = can(user, 'invoices.view');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const q = useQuery({
    queryKey: ['reseller-statement', resellerId, statementId, page],
    queryFn: () => apiFetch<StatementDetail>(`/resellers/${resellerId}/settlements/${statementId}?page=${page}&limit=${LINES_PAGE}`),
    placeholderData: keepPreviousData,
  });
  const action = useMutation({
    mutationFn: (name: 'approve' | 'regenerate' | 'discard') => apiFetch(`/resellers/${resellerId}/settlements/${statementId}/${name}`, { method: 'POST' })
      .then(() => name),
    onSuccess: (name: string) => onChanged(t(`resellerStatements.done.${name}`)),
    onError: (err: unknown) => setError(refusal(err, t('resellerStatements.actionError'))),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <p style={styles.msgError}>{t('resellerStatements.loadError')}</p>;
  const st = q.data.data;
  const cur = st.currency;
  const fmt = (v: number | string | null | undefined) => formatMoney(v ?? 0, cur);
  const pages = Math.max(1, Math.ceil((q.data.meta?.total ?? 0) / LINES_PAGE));
  async function pdf() {
    setError('');
    try { await downloadStatementPdf(st, resellerId); } catch { setError(t('resellerStatements.downloadError')); }
  }

  return (
    <section aria-label={t('resellerStatements.detail')} style={{ ...styles.tableCard, padding: '1rem', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>
          {t('resellerStatements.heading', { id: st.id, start: st.period_start, end: st.period_end })} <StatementStatusChip status={st.status} />
        </h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={styles.btnSecondary} onClick={() => { void pdf(); }}>{t('resellerStatements.pdf')}</button>
          {st.status === 'draft' && canManage && (
            <>
              <button type="button" style={styles.btnSecondary} disabled={action.isPending} onClick={() => action.mutate('regenerate')}>{t('resellerStatements.regenerate')}</button>
              <button type="button" style={styles.btnDanger} disabled={action.isPending} onClick={() => action.mutate('discard')}>{t('resellerStatements.discard')}</button>
            </>
          )}
          {st.status === 'draft' && canApprove && (
            <button type="button" style={styles.btnPrimary} disabled={action.isPending} onClick={() => action.mutate('approve')}>{t('resellerStatements.approve')}</button>
          )}
        </div>
      </div>
      {error && <p role="alert" style={{ ...styles.msgError, textAlign: 'left' }}>{error}</p>}
      {(st.sweep_earned > 0 || st.sweep_reversed > 0) && (
        <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerStatements.sweepNote', { earned: st.sweep_earned, reversed: st.sweep_reversed })}</p>
      )}
      <table style={{ ...styles.table, maxWidth: 520, marginTop: 8 }}>
        <tbody>
          <tr style={styles.tr}><td style={styles.td}>{t('resellerStatements.opening')}</td><td style={styles.tdNum}>{fmt(st.opening_balance)}</td></tr>
          {/* A collector's fees (migration 011) only when there are any. */}
          {STATEMENT_TOTAL_TYPES.filter(type => !type.startsWith('collection_fee') || toNumber(st.totals[type]) !== 0).map(type => (
            <tr key={type} style={styles.tr}>
              <td style={{ ...styles.td, paddingLeft: 24 }}>{t(`resellerStatements.totals.${type}`)}</td>
              <td style={{ ...styles.tdNum, color: toNumber(st.totals[type]) === 0 ? 'var(--text-secondary)' : undefined }}>{fmt(st.totals[type])}</td>
            </tr>
          ))}
          <tr style={styles.tr}>
            <td style={{ ...styles.td, fontWeight: 700 }}><ClosingText closing={toNumber(st.closing_balance)} currency={cur} /></td>
            <td style={{ ...styles.tdNum, fontWeight: 700 }}>{fmt(st.closing_balance)}</td>
          </tr>
        </tbody>
      </table>
      {st.status === 'settled' && (
        <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>
          {t('resellerStatements.settledOn', { date: formatDate(st.settled_at, DATETIME), ref: st.bank_ref ?? '' })}
          {st.settlement_entry_id === null && ` ${t('resellerStatements.settledRecordOnly')}`}
        </p>
      )}
      {st.status === 'approved' && canManage && <SettleForm resellerId={resellerId} statement={st} onDone={onChanged} />}

      <h5 style={{ margin: '16px 0 8px' }}>{t('resellerStatements.lines', { count: st.entry_count })}</h5>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{t('resellerStatements.colDate')}</th>
              <th style={styles.th}>{t('resellerStatements.colType')}</th>
              <th style={styles.th}>{t('resellerStatements.colReference')}</th>
              <th style={styles.th}>{t('resellerStatements.colNote')}</th>
              <th style={styles.thNum}>{t('resellerStatements.colAmount')}</th>
            </tr>
          </thead>
          <tbody>
            {q.data.lines.length === 0 && <tr><td colSpan={5} style={styles.emptyCell}>{t('resellerStatements.noLines')}</td></tr>}
            {q.data.lines.map(l => (
              <tr key={l.id} style={styles.tr}>
                <td style={styles.td}>{formatDate(l.created_at, DATETIME)}</td>
                <td style={styles.td}>{t(`resellerLedger.types.${l.entry_type}`, { defaultValue: l.entry_type })}</td>
                <td style={styles.td}>
                  {l.invoice_number
                    ? (canSeeInvoices && l.invoice_id ? <Link to={`/invoices/${l.invoice_id}`}>{l.invoice_number}</Link> : l.invoice_number)
                    : l.cash_bag_serial ?? (l.payment_id ? `#${l.payment_id}` : '')}
                </td>
                <td style={{ ...styles.td, maxWidth: 280, overflowWrap: 'anywhere' }}>{l.note ?? ''}</td>
                <td style={styles.tdNum}>{fmt(l.amount)}</td>
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

export function ResellerStatementsTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canManage = can(user, 'reseller_settlements.manage');
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const resellersQ = useResellerOptions({ topLevel: true });
  const listQ = useQuery({
    queryKey: ['reseller-statements', resellerId, page],
    enabled: resellerId !== null,
    queryFn: () => apiFetch<StatementList>(`/resellers/${resellerId}/settlements?page=${page}&limit=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
  const rows = listQ.data?.data ?? [];
  const pages = Math.max(1, Math.ceil((listQ.data?.meta?.total ?? 0) / PAGE_SIZE));

  function changed(msg: string, id?: number) {
    setNotice(msg);
    if (id) setSelected(id);
    void queryClient.invalidateQueries({ queryKey: ['reseller-statements'] });
    void queryClient.invalidateQueries({ queryKey: ['reseller-statement'] });
    void queryClient.invalidateQueries({ queryKey: ['reseller-ledger'] });
  }

  return (
    <div>
      <h3>{t('resellerStatements.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerStatements.help')}</p>
      <label style={styles.filterLabel}>
        {t('resellerStatements.reseller')}
        <select
          style={styles.filterSelect}
          value={resellerId ?? ''}
          onChange={e => { setResellerId(Number(e.target.value) || null); setSelected(null); setPage(1); setNotice(''); }}
        >
          <option value="">{t('resellerStatements.selectReseller')}</option>
          {(resellersQ.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <ResellerListNotice list={resellersQ.data} />
      {resellersQ.isError && <p style={styles.msgError}>{t('resellerStatements.resellersError')}</p>}
      {notice && <p role="status" style={{ ...styles.msg, textAlign: 'left', padding: 0, color: 'var(--success)' }}>{notice}</p>}

      {resellerId !== null && canManage && listQ.data && (
        <GenerateForm key={resellerId} resellerId={resellerId} defaults={listQ.data.meta?.default_period} onDone={changed} />
      )}

      {resellerId !== null && (listQ.isLoading ? <LoadingState /> : listQ.isError ? (
        <p style={styles.msgError}>{t('resellerStatements.loadError')}</p>
      ) : (
        <div style={styles.tableCard}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('resellerStatements.colPeriod')}</th>
                <th style={styles.th}>{t('resellerStatements.colStatus')}</th>
                <th style={styles.thNum}>{t('resellerStatements.opening')}</th>
                <th style={styles.thNum}>{t('resellerStatements.colClosing')}</th>
                <th style={styles.thNum}>{t('resellerStatements.colEntries')}</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} style={styles.emptyCell}>{t('resellerStatements.empty')}</td></tr>}
              {rows.map(st => (
                <tr key={st.id} style={{ ...styles.tr, ...(st.id === selected ? { background: 'var(--bg-subtle)' } : {}) }}>
                  <td style={styles.td}>{t('resellerStatements.periodRange', { start: st.period_start, end: st.period_end })}</td>
                  <td style={styles.td}><StatementStatusChip status={st.status} /></td>
                  <td style={styles.tdNum}>{formatMoney(st.opening_balance, st.currency)}</td>
                  <td style={styles.tdNum}><ClosingText closing={toNumber(st.closing_balance)} currency={st.currency} /></td>
                  <td style={styles.tdNum}>{st.entry_count}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.actionBtn} onClick={() => setSelected(st.id)}>{t('resellerStatements.view')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <div style={styles.pagination}>
              <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('punto.common.previous')}</button>
              <span style={styles.pageInfo}>{t('punto.common.pageOf', { page, pages })}</span>
              <button type="button" style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('punto.common.next')}</button>
            </div>
          )}
        </div>
      ))}

      {resellerId !== null && selected !== null && (
        <StatementDetailView key={selected} resellerId={resellerId} statementId={selected} onChanged={msg => changed(msg)} />
      )}
    </div>
  );
}
