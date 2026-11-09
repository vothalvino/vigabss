// =============================================================================
// Reseller app (/punto) — Mi caja
// =============================================================================
// One summary on top, then three short tabs. Owner request (2026-11-08): the
// old page stacked seven sections with two totals that read alike ("Debes
// tener" for the drawer, "Debes entregar" for the account), so it showed one
// figure only: what the point owes the company.
//
//   • Summary (GET /reseller-app/me money): "Debes entregar" (or "La empresa
//     te debe" when its commissions passed the cash it holds), the cash
//     already sealed in bags on its way, and the limit bar: how much is left
//     before the limit, or, once reached, a call to fill a bag.
//   • Hoy (GET /reseller-app/payments): today's payments, compact; tapping
//     one opens its receipt and, while the server allows it, "Anular" with a
//     reason (POST /reseller-app/payments/:id/void).
//   • Movimientos (GET /reseller-app/ledger): every line of its account,
//     grouped by day, + adds to what it owes and - lowers it.
//   • Estados de cuenta (GET /reseller-app/statements, with
//     reseller_app.statements): the approved and settled ones with their PDF.
//
// The daily "Cerrar caja" was removed from the reseller app (owner decision,
// 2026-11-08): the company reconciles through bags, deposits and statements.
// The tab is kept in the address (?vista=movimientos | estados).
// =============================================================================

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  apiErrorCode, downloadStatementPdf, fetchPuntoCollections, fetchPuntoLedger, fetchPuntoMe, fetchPuntoStatements,
  limitReached, puntoKeys, toNumber, voidPuntoCollection, type PuntoCollection, type PuntoLedgerEntry, type PuntoMoney,
  type ResellerStatement,
} from './puntoApi';
import { StatusChip, errorText, formatTime, mutedText, pageTitle, useRefreshPuntoMoney, usePuntoCurrency } from './puntoUi';

const PAGE_SIZE = 20;
const STATEMENTS_PAGE = 6;
const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } as const;

type View = 'hoy' | 'movimientos' | 'estados';

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
  LOCK_CONTENTION: 'punto.cash.voidChanged',
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

// -----------------------------------------------------------------------------
// The summary
// -----------------------------------------------------------------------------

function Summary({ money, canBags }: { money: PuntoMoney; canBags: boolean }) {
  const { t } = useTranslation();
  const fmt = (v: number | string) => formatMoney(v, money.currency);
  const balance = toNumber(money.balance);
  const owedToYou = balance < 0;
  const limit = toNumber(money.credit_limit);
  const held = Math.max(0, toNumber(money.cash_on_hand));
  const left = Math.max(0, toNumber(money.available_to_collect));
  const reached = limitReached(money);
  const used = limit > 0 ? Math.min(100, Math.round((held / limit) * 100)) : 100;
  const color = reached ? 'var(--danger)' : used >= 80 ? 'var(--warning)' : 'var(--success)';
  const inBags = toNumber(money.in_bags ?? 0);
  const emptyBags = toNumber(money.empty_bags ?? 0);

  return (
    <section className="punto-card" aria-labelledby="punto-cash-summary" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h2 id="punto-cash-summary" style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {owedToYou ? t('punto.cashPage.owedToYou') : t('punto.cashPage.owe')}
        </h2>
        <div className="punto-amount-big" style={owedToYou ? { color: 'var(--success)' } : undefined}>{fmt(owedToYou ? -balance : balance)}</div>
        <p style={mutedText}>{owedToYou ? t('punto.cashPage.owedToYouHelp') : t('punto.cashPage.oweHelp')}</p>
      </div>
      {inBags > 0 && (
        <div className="punto-money-row" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          <span>{t('punto.cashPage.inBags')}</span>
          <strong>{fmt(inBags)}</strong>
          <span style={{ ...mutedText, width: '100%' }}>{t('punto.cashPage.inBagsHelp')}</span>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          className="punto-meter"
          role="progressbar"
          aria-label={t('punto.money.meterLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
          aria-valuetext={t('punto.money.meterText', { held: fmt(held), limit: fmt(limit) })}
        >
          <span style={{ width: `${used}%`, background: color }} />
        </div>
        {reached
          ? <p role="alert" style={{ margin: 0, fontWeight: 600, color: 'var(--danger)' }}>{t('punto.cashPage.limitReached', { limit: fmt(limit) })}</p>
          : <p style={{ margin: 0 }}>{t('punto.cashPage.limitLeft', { amount: fmt(left), limit: fmt(limit) })}</p>}
      </div>
      {canBags && (
        <Link to="/punto/bolsas" className={reached && emptyBags > 0 ? 'punto-btn-primary' : 'punto-btn-secondary'}>
          {reached && emptyBags > 0 ? t('puntoBags.fillToCollect') : t('punto.cashPage.toBags')}
        </Link>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Hoy
// -----------------------------------------------------------------------------

function PaymentRow({ c, currency, voidable }: { c: PuntoCollection; currency: string; voidable: boolean }) {
  const { t } = useTranslation();
  const refreshMoney = useRefreshPuntoMoney();
  const [expanded, setExpanded] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const voided = c.status !== 'completed';
  const doVoid = useMutation({
    mutationFn: () => voidPuntoCollection(c.id, reason.trim()),
    onSuccess: () => { setVoiding(false); refreshMoney(); },
    onError: (err: unknown) => {
      const refusal = VOID_REFUSALS[apiErrorCode(err) ?? ''];
      if (refusal) {
        // The row is out of date (voided or reported): reload it.
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
    <li style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <button
        type="button"
        className="punto-row-button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <span style={{ minWidth: 0, textAlign: 'left' }}>
          <span style={{ display: 'block', fontWeight: 600, overflowWrap: 'anywhere' }}>{c.client_name}</span>
          <span style={{ display: 'block', ...mutedText }}>{formatTime(c.collected_at)} · {t('punto.collect.clientNumber', { number: c.client_number })}</span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <strong style={voided ? { textDecoration: 'line-through', color: 'var(--text-secondary)' } : undefined}>{formatMoney(c.amount, currency)}</strong>
          {voided && <StatusChip status="voided" />}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 0 10px' }}>
          {c.invoice_numbers.length > 0 && <p style={{ ...mutedText, marginBottom: 8 }}>{t('punto.cashPage.invoices', { list: c.invoice_numbers.join(', ') })}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="punto-btn-secondary" to={`/punto/recibo/${c.id}`}>{t('punto.cash.receipt')}</Link>
            {voidable && !voided && !voiding && (
              <button type="button" className="punto-btn-danger" onClick={() => setVoiding(true)}>{t('punto.cash.void')}</button>
            )}
          </div>
          {voiding && (
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
                <button type="button" className="punto-btn-secondary" onClick={() => { setVoiding(false); setError(''); }}>{t('punto.cash.voidCancel')}</button>
              </div>
            </form>
          )}
          {!voiding && error && <p role="alert" style={{ ...errorText, marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </li>
  );
}

function Today({ money, currency, canCollect }: { money: PuntoMoney | undefined; currency: string; canCollect: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: puntoKeys.collections('today', page),
    queryFn: () => fetchPuntoCollections({ page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const total = list.data?.meta?.total ?? list.data?.data.length ?? 0;
  return (
    <div className="punto-card">
      {money && (
        <div className="punto-money-row" style={{ marginBottom: 6 }}>
          <span style={{ fontWeight: 600 }}>{t('punto.cashPage.collectedToday')}</span>
          <strong>{formatMoney(money.collected_today, currency)}</strong>
        </div>
      )}
      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message={t('punto.cash.listError')} onRetry={() => { void list.refetch(); }} />}
      {list.data && list.data.data.length === 0 && <EmptyState message={t('punto.cash.noCollections')} />}
      {list.data && list.data.data.length > 0 && (
        <>
          <p style={{ ...mutedText, marginBottom: 4 }}>{t('punto.cashPage.tapHint')}</p>
          <ul className="punto-list" style={{ gap: 0 }}>
            {list.data.data.map(c => (
              <PaymentRow key={c.id} c={c} currency={currency} voidable={canCollect && c.voidable !== false} />
            ))}
          </ul>
        </>
      )}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Movimientos
// -----------------------------------------------------------------------------

/** The page's entries by day, newest day first, keeping the server's order. */
function byDay(entries: PuntoLedgerEntry[]): { day: string; entries: PuntoLedgerEntry[] }[] {
  const out: { day: string; entries: PuntoLedgerEntry[] }[] = [];
  for (const e of entries) {
    const day = formatDate(e.created_at, { day: 'numeric', month: 'long', year: 'numeric' });
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

function Movements({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: puntoKeys.ledger(page), queryFn: () => fetchPuntoLedger(page, PAGE_SIZE), placeholderData: keepPreviousData });
  const fmt = (v: number) => formatMoney(Math.abs(v), currency);
  const total = q.data?.meta?.total ?? 0;
  return (
    <div className="punto-card">
      <p style={{ ...mutedText, marginBottom: 8 }}>{t('punto.cashPage.movementsHelp')}</p>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('punto.ledger.loadError')} onRetry={() => { void q.refetch(); }} />}
      {q.data && q.data.data.length === 0 && <p style={mutedText}>{t('punto.ledger.empty')}</p>}
      {q.data && byDay(q.data.data).map(group => (
        <section key={group.day} aria-label={group.day} style={{ marginTop: 8 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{group.day}</h3>
          <ul className="punto-list" style={{ gap: 0 }}>
            {group.entries.map(e => {
              const n = toNumber(e.amount);
              const detail = e.cash_bag_serial ? t('puntoBags.ledgerBag', { serial: e.cash_bag_serial })
                : e.invoice_number ? t('punto.ledger.invoice', { number: e.invoice_number }) : null;
              return (
                <li key={e.id} style={{ ...row, borderTop: '1px solid var(--border-subtle)', padding: '8px 0' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{t(`punto.ledger.types.${e.entry_type}`, { defaultValue: e.entry_type })}</div>
                    <div style={mutedText}>{formatTime(e.created_at)}{detail ? ` · ${detail}` : ''}</div>
                    {e.note && <div style={{ ...mutedText, overflowWrap: 'anywhere' }}>{e.note}</div>}
                  </div>
                  <strong style={{ whiteSpace: 'nowrap', color: n < 0 ? 'var(--success)' : 'var(--text-primary)' }}>
                    {n < 0 ? `− ${fmt(n)}` : `+ ${fmt(n)}`}
                  </strong>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE_SIZE))} onPage={setPage} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Estados de cuenta
// -----------------------------------------------------------------------------

function StatementRow({ statement, currency }: { statement: ResellerStatement; currency: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closing = toNumber(statement.closing_balance);
  async function download() {
    setBusy(true);
    setError('');
    try {
      await downloadStatementPdf(statement);
    } catch {
      setError(t('punto.statements.downloadError'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li style={{ ...row, borderTop: '1px solid var(--border-subtle)', paddingTop: 8, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t('punto.statements.period', { start: statement.period_start, end: statement.period_end })}</div>
        <div style={mutedText}>
          {closing < 0
            ? t('punto.statements.closingOwedToYou', { amount: formatMoney(-closing, statement.currency || currency) })
            : t('punto.statements.closingOwe', { amount: formatMoney(closing, statement.currency || currency) })}
        </div>
        <div style={mutedText}>
          {statement.status === 'settled'
            ? t('punto.statements.settled', { ref: statement.bank_ref ?? '' })
            : t('punto.statements.approved')}
        </div>
        {error && <div role="alert" style={errorText}>{error}</div>}
      </div>
      <button type="button" className="punto-btn-secondary" onClick={() => { void download(); }} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
        {busy ? t('punto.statements.downloading') : t('punto.statements.pdf')}
      </button>
    </li>
  );
}

function Statements({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: puntoKeys.statements(page),
    queryFn: () => fetchPuntoStatements(page, STATEMENTS_PAGE),
    placeholderData: keepPreviousData,
  });
  const total = q.data?.meta?.total ?? 0;
  return (
    <div className="punto-card">
      <p style={{ ...mutedText, marginBottom: 8 }}>{t('punto.statements.intro')}</p>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('punto.statements.loadError')} onRetry={() => { void q.refetch(); }} />}
      {q.data && q.data.data.length === 0 && <p style={mutedText}>{t('punto.statements.empty')}</p>}
      {q.data && q.data.data.length > 0 && (
        <ul className="punto-list">
          {q.data.data.map(st => <StatementRow key={st.id} statement={st} currency={currency} />)}
        </ul>
      )}
      <Pager page={page} pages={Math.max(1, Math.ceil(total / STATEMENTS_PAGE))} onPage={setPage} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// The page
// -----------------------------------------------------------------------------

export function PuntoCash() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canCollect = can(user, 'reseller_app.collect');
  const canBags = can(user, 'reseller_app.bags');
  const canStatements = can(user, 'reseller_app.statements');
  const currency = usePuntoCurrency();
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });
  const [params, setParams] = useSearchParams();
  const views: View[] = canStatements ? ['hoy', 'movimientos', 'estados'] : ['hoy', 'movimientos'];
  const asked = params.get('vista') as View | null;
  const view: View = asked && views.includes(asked) ? asked : 'hoy';
  const money = me.data?.money;

  function show(next: View) {
    const p = new URLSearchParams(params);
    if (next === 'hoy') p.delete('vista'); else p.set('vista', next);
    setParams(p, { replace: true });
  }
  // Left and right move between the tabs (WAI-ARIA tabs pattern).
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = views.indexOf(view);
    const next = views[(i + (e.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
    show(next);
    document.getElementById(`punto-cash-tab-${next}`)?.focus();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('punto.cash.title')}</h1>
      {me.isLoading && <LoadingState />}
      {me.isError && <ErrorState message={t('punto.cash.loadError')} onRetry={() => { void me.refetch(); }} />}
      {money && <Summary money={money} canBags={canBags} />}

      <div role="tablist" aria-label={t('punto.cash.title')} className="punto-segment">
        {views.map(v => (
          <button
            key={v}
            id={`punto-cash-tab-${v}`}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-controls="punto-cash-panel"
            tabIndex={view === v ? 0 : -1}
            className={`punto-segment-item${view === v ? ' active' : ''}`}
            onClick={() => show(v)}
            onKeyDown={onTabKey}
          >
            {t(`punto.cashPage.tabs.${v}`)}
          </button>
        ))}
      </div>
      <div id="punto-cash-panel" role="tabpanel" aria-labelledby={`punto-cash-tab-${view}`}>
        {view === 'hoy' && <Today money={money} currency={currency} canCollect={canCollect} />}
        {view === 'movimientos' && <Movements currency={currency} />}
        {view === 'estados' && <Statements currency={currency} />}
      </div>
    </div>
  );
}
