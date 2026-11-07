// =============================================================================
// Reseller app (/punto) — Mi caja
// =============================================================================
// The reseller user's cash box for the day:
//   • the open cash session (GET /reseller-app/cash-session): what it should
//     hold and how many collections it took; it opens with the first one;
//   • today's collections (GET /reseller-app/payments) with "Anular" while
//     the server would still allow it: a completed collection of the open
//     session (POST /reseller-app/payments/:id/void with a reason; the server
//     also refuses one with a stamped complemento de pago);
//   • "Cerrar caja": the counted cash, with the difference shown before
//     closing (POST /reseller-app/cash-session/close). Closing does not
//     change what the reseller owes: only the ISP recording a cash hand-in
//     does;
//   • the last closed sessions and the movements of the reseller's account
//     (GET /reseller-app/ledger) with its balance, what its sealed cash bags
//     hold, its cash on hand and cash limit; a bag's receipt (deposit) and
//     count difference (adjustment) name the bag;
//   • a link to Mis bolsas (/punto/bolsas) with reseller_app.bags.
// The cash-box card is titled "Tu caja" and says whether one is open.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import {
  apiErrorCode, closePuntoCashSession, fetchPuntoCashSession, fetchPuntoCollections, fetchPuntoLedger, puntoKeys, toNumber,
  voidPuntoCollection, type PuntoClosedSession, type PuntoCollection, type PuntoOpenSession,
} from './puntoApi';
import {
  StatusChip, errorText, formatDateTime, formatTime, mutedText, pageTitle, sectionTitle, useRefreshPuntoMoney, usePuntoCurrency,
} from './puntoUi';

const PAGE_SIZE = 20;
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } as const;

function serverMessage(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError && err.status < 500 && err.message ? err.message : fallback;
}

// The reasons the server gives for refusing a void, in the reader's language.
const VOID_REFUSALS: Record<string, string> = {
  ALREADY_VOIDED: 'punto.cash.voidAlready',
  VOID_WINDOW_CLOSED: 'punto.cash.voidWindowClosed',
  CASH_SESSION_CLOSED: 'punto.cash.voidSessionClosed',
  NOT_YOUR_COLLECTION: 'punto.cash.voidNotYours',
  PAYMENT_HAS_REP: 'punto.cash.voidHasRep',
  CASH_SEALED_IN_BAG: 'punto.cash.voidSealedInBag',
};

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  if (pages <= 1) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
      <button type="button" className="punto-btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('punto.common.previous')}</button>
      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('punto.common.pageOf', { page, pages })}</span>
      <button type="button" className="punto-btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t('punto.common.next')}</button>
    </div>
  );
}

/** "Sobran $X" / "Faltan $X" / "Cuadra" for a counted total against the expected one. */
function VarianceText({ variance, currency }: { variance: number; currency: string }) {
  const { t } = useTranslation();
  const v = Math.round(variance * 100) / 100;
  if (v === 0) return <span style={{ color: 'var(--success)', fontWeight: 600 }}>{t('punto.cash.varianceZero')}</span>;
  return v > 0
    ? <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{t('punto.cash.varianceOver', { amount: formatMoney(v, currency) })}</span>
    : <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{t('punto.cash.varianceShort', { amount: formatMoney(-v, currency) })}</span>;
}

function CloseForm({ session, currency, onClosed }: { session: PuntoOpenSession; currency: string; onClosed: (s: PuntoClosedSession) => void }) {
  const { t } = useTranslation();
  const refreshMoney = useRefreshPuntoMoney();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const expected = toNumber(session.expected_total);
  const valid = AMOUNT.test(counted.trim());
  const value = valid ? Number(counted.trim()) : null;

  const close = useMutation({
    mutationFn: () => closePuntoCashSession({ counted_total: value ?? 0, ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: (closed) => { refreshMoney(); onClosed(closed); },
    onError: (err: unknown) => {
      setConfirming(false);
      if (apiErrorCode(err) === 'NO_OPEN_CASH_SESSION') {
        // Closed elsewhere (another tab): show the cash box as it is now.
        refreshMoney();
        setError(t('punto.cash.noOpenToClose'));
        return;
      }
      setError(serverMessage(err, t('punto.cash.closeError')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (value === null) { setError(t('punto.cash.countedInvalid')); return; }
    if (!confirming) { setConfirming(true); return; }
    close.mutate();
  }

  return (
    <form onSubmit={submit} noValidate className="punto-card" aria-labelledby="punto-cash-close">
      <h2 id="punto-cash-close" style={sectionTitle}>{t('punto.cash.closeTitle')}</h2>
      <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.cash.closeHelp')}</p>
      <div className="punto-field">
        <label htmlFor="punto-cash-counted">{t('punto.cash.counted')}</label>
        <input id="punto-cash-counted" inputMode="decimal" autoComplete="off" value={counted}
          onChange={e => { setCounted(e.target.value); setConfirming(false); }} />
      </div>
      {value !== null && (
        <p style={{ margin: '0 0 12px' }} aria-live="polite">
          {t('punto.cash.difference')}: <VarianceText variance={value - expected} currency={currency} />
        </p>
      )}
      <div className="punto-field">
        <label htmlFor="punto-cash-notes">{t('punto.cash.notes')}</label>
        <textarea id="punto-cash-notes" rows={2} maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      {error && <p role="alert" style={errorText}>{error}</p>}
      {confirming && value !== null && (
        <p style={{ margin: '0 0 12px', fontWeight: 600 }}>{t('punto.cash.closeConfirm', { amount: formatMoney(value, currency) })}</p>
      )}
      <button type="submit" className="punto-btn-primary" disabled={close.isPending}>
        {close.isPending ? t('punto.cash.closing') : confirming ? t('punto.cash.closeYes') : t('punto.cash.close')}
      </button>
      {confirming && (
        <button type="button" className="punto-btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={() => setConfirming(false)}>
          {t('punto.cash.closeBack')}
        </button>
      )}
    </form>
  );
}

function CollectionRow({ c, currency, voidable }: { c: PuntoCollection; currency: string; voidable: boolean }) {
  const { t } = useTranslation();
  const refreshMoney = useRefreshPuntoMoney();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const voided = c.status !== 'completed';
  const doVoid = useMutation({
    mutationFn: () => voidPuntoCollection(c.id, reason.trim()),
    onSuccess: () => { setOpen(false); refreshMoney(); },
    onError: (err: unknown) => {
      const refusal = VOID_REFUSALS[apiErrorCode(err) ?? ''];
      if (refusal) {
        // The row is out of date (voided, closed or reported): reload it.
        refreshMoney();
        setError(t(refusal));
        return;
      }
      setError(serverMessage(err, t('punto.cash.voidError')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const r = reason.trim();
    if (r.length < 3 || r.length > 200) { setError(t('punto.cash.reasonInvalid')); return; }
    doVoid.mutate();
  }

  return (
    <li className="punto-card">
      <div style={row}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{c.client_name}</div>
          <div style={mutedText}>
            {t('punto.collect.clientNumber', { number: c.client_number })} · {formatTime(c.collected_at)}
          </div>
          {c.invoice_numbers.length > 0 && <div style={mutedText}>{c.invoice_numbers.join(', ')}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <strong style={voided ? { textDecoration: 'line-through', color: 'var(--text-secondary)' } : undefined}>{formatMoney(c.amount, currency)}</strong>
          {voided && <StatusChip status="voided" />}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <Link className="punto-btn-secondary" to={`/punto/recibo/${c.id}`}>{t('punto.cash.receipt')}</Link>
        {voidable && !voided && !open && (
          <button type="button" className="punto-btn-danger" onClick={() => setOpen(true)}>{t('punto.cash.void')}</button>
        )}
      </div>
      {open && (
        <form onSubmit={submit} noValidate style={{ marginTop: 10 }}>
          <div className="punto-field">
            <label htmlFor={`punto-void-${c.id}`}>{t('punto.cash.voidReason')}</label>
            <textarea id={`punto-void-${c.id}`} rows={2} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <p style={{ ...mutedText, marginBottom: 8 }}>{t('punto.cash.voidHelp')}</p>
          {error && <p role="alert" style={errorText}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="punto-btn-danger" disabled={doVoid.isPending}>
              {doVoid.isPending ? t('punto.cash.voiding') : t('punto.cash.voidConfirm')}
            </button>
            <button type="button" className="punto-btn-secondary" onClick={() => { setOpen(false); setError(''); }}>{t('punto.cash.voidCancel')}</button>
          </div>
        </form>
      )}
    </li>
  );
}

const LEDGER_TONE: Record<string, string> = {
  collection: 'var(--text-primary)', collection_void: 'var(--text-secondary)', deposit: 'var(--success)', adjustment: 'var(--warning)',
  bag_sealed: 'var(--success)',
};

function Ledger({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: puntoKeys.ledger(page), queryFn: () => fetchPuntoLedger(page, PAGE_SIZE), placeholderData: keepPreviousData });
  const fmt = (v: number | string) => formatMoney(v, currency);
  const total = q.data?.meta?.total ?? 0;
  const s = q.data?.summary;

  return (
    <section className="punto-card" aria-labelledby="punto-ledger-title">
      <h2 id="punto-ledger-title" style={sectionTitle}>{t('punto.ledger.title')}</h2>
      <p style={{ ...mutedText, marginBottom: 10 }}>{t('punto.ledger.intro')}</p>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('punto.ledger.loadError')} onRetry={() => { void q.refetch(); }} />}
      {s && (
        <dl style={{ margin: '0 0 10px', display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px' }}>
          <dt>{t('punto.money.owe')}</dt><dd style={{ margin: 0, fontWeight: 700 }}>{fmt(s.balance)}</dd>
          {s.in_bags !== undefined && <><dt>{t('puntoBags.money.inBags')}</dt><dd style={{ margin: 0 }}>{fmt(s.in_bags)}</dd></>}
          <dt>{t('punto.ledger.limit')}</dt><dd style={{ margin: 0 }}>{fmt(s.credit_limit)}</dd>
          <dt>{t('punto.money.canCollect')}</dt><dd style={{ margin: 0 }}>{fmt(Math.max(0, toNumber(s.available_to_collect)))}</dd>
        </dl>
      )}
      {q.data && q.data.data.length === 0 && <p style={mutedText}>{t('punto.ledger.empty')}</p>}
      {q.data && q.data.data.length > 0 && (
        <ul className="punto-list">
          {q.data.data.map(e => {
            const n = toNumber(e.amount);
            return (
              <li key={e.id} style={{ ...row, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{t(`punto.ledger.types.${e.entry_type}`, { defaultValue: e.entry_type })}</div>
                  <div style={mutedText}>{formatDateTime(e.created_at)}</div>
                  {e.cash_bag_serial ? <div style={mutedText}>{t('puntoBags.ledgerBag', { serial: e.cash_bag_serial })}</div> : null}
                  {e.note && <div style={{ ...mutedText, overflowWrap: 'anywhere' }}>{e.note}</div>}
                </div>
                <strong style={{ color: LEDGER_TONE[e.entry_type] ?? 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {n > 0 ? `+${fmt(n)}` : fmt(n)}
                </strong>
              </li>
            );
          })}
        </ul>
      )}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </section>
  );
}

export function PuntoCash() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canCollect = can(user, 'reseller_app.collect');
  const canBags = can(user, 'reseller_app.bags');
  const currency = usePuntoCurrency();
  const [page, setPage] = useState(1);
  const [justClosed, setJustClosed] = useState<PuntoClosedSession | null>(null);
  const session = useQuery({ queryKey: puntoKeys.cashSession, queryFn: fetchPuntoCashSession });
  const list = useQuery({
    queryKey: puntoKeys.collections('today', page),
    queryFn: () => fetchPuntoCollections({ page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const current = session.data?.current ?? null;
  const fmt = (v: number | string | null) => formatMoney(v, currency);
  const total = list.data?.meta?.total ?? list.data?.data.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('punto.cash.title')}</h1>
      {canBags && <Link to="/punto/bolsas" className="punto-btn-secondary">{t('puntoBags.fromCash')}</Link>}

      {session.isLoading && <LoadingState />}
      {session.isError && <ErrorState message={t('punto.cash.loadError')} onRetry={() => { void session.refetch(); }} />}
      {justClosed && (
        <div role="status" className="punto-card" style={{ background: 'var(--success-soft)' }}>
          <strong>{t('punto.cash.closed')}</strong>
          <p style={{ margin: '6px 0 0' }}>
            {t('punto.cash.closedSummary', { expected: fmt(justClosed.expected_total), counted: fmt(justClosed.counted_total) })}{' '}
            <VarianceText variance={toNumber(justClosed.variance)} currency={currency} />
          </p>
        </div>
      )}
      {session.data && (
        <section className="punto-card" aria-labelledby="punto-cash-open">
          <div style={{ ...row, alignItems: 'center', marginBottom: 8 }}>
            <h2 id="punto-cash-open" style={{ ...sectionTitle, margin: 0 }}>{t('punto.cash.boxTitle')}</h2>
            <StatusChip status={current ? 'open' : 'closed'} />
          </div>
          {current ? (
            <>
              <div className="punto-money-row">
                <span>{t('punto.cash.expected')}</span>
                <strong className="punto-amount-big" style={{ fontSize: '1.6rem' }}>{fmt(current.expected_total)}</strong>
              </div>
              <p style={mutedText}>
                {t('punto.cash.openSummary', { count: current.collections_count, date: formatDateTime(current.opened_at) })}
              </p>
            </>
          ) : <p style={mutedText}>{t('punto.cash.noOpen')}</p>}
        </section>
      )}

      <section aria-labelledby="punto-cash-today">
        <h2 id="punto-cash-today" style={sectionTitle}>{t('punto.cash.todayTitle')}</h2>
        {list.isLoading && <LoadingState />}
        {list.isError && <ErrorState message={t('punto.cash.listError')} onRetry={() => { void list.refetch(); }} />}
        {list.data && list.data.data.length === 0 && <EmptyState message={t('punto.cash.noCollections')} />}
        {list.data && list.data.data.length > 0 && (
          <ul className="punto-list">
            {list.data.data.map(c => (
              <CollectionRow
                key={c.id}
                c={c}
                currency={currency}
                voidable={canCollect && (c.voidable ?? (current !== null && (c.cash_session_id === null || c.cash_session_id === current.id)))}
              />
            ))}
          </ul>
        )}
        <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
      </section>

      {canCollect && current && <CloseForm key={current.id} session={current} currency={currency} onClosed={setJustClosed} />}

      {session.data && session.data.recent.length > 0 && (
        <section className="punto-card" aria-labelledby="punto-cash-recent">
          <h2 id="punto-cash-recent" style={sectionTitle}>{t('punto.cash.recentTitle')}</h2>
          <ul className="punto-list">
            {session.data.recent.map(s => (
              <li key={s.id} style={{ ...row, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{formatDateTime(s.closed_at ?? s.opened_at)}</div>
                  <div style={mutedText}>{t('punto.cash.recentLine', { expected: fmt(s.expected_total), counted: fmt(s.counted_total) })}</div>
                </div>
                {s.variance !== null && s.variance !== undefined
                  ? <VarianceText variance={toNumber(s.variance)} currency={currency} />
                  : <StatusChip status={s.status} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Ledger currency={currency} />
    </div>
  );
}
