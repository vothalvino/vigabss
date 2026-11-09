// =============================================================================
// Reseller app (/punto) — Cobrar
// =============================================================================
// The reseller takes cash from a subscriber on behalf of the ISP:
//   1. find the subscriber by exact customer number or phone
//      (GET /reseller-app/collect/lookup), or arrive from a client's page
//      with ?cliente=<id> (GET /reseller-app/collect/client/:id);
//   2. pick the open invoices (all, oldest first, by default) and the amount
//      (their balance by default; a partial payment is allowed);
//   3. confirm the cash was received, then POST /reseller-app/payments with
//      an Idempotency-Key that stays the same for retries of that attempt.
// A subscriber who is not the reseller's own client arrives with a masked
// name and no contact data. The cash limit is where a bag must be filled,
// not a cap on the payment: the one that crosses it goes through, and once
// the cash on hand reached the limit the server refuses the next collection
// (409 CREDIT_LIMIT); the page then asks to fill an empty cash bag (that
// frees the limit at once) or hand in the cash. Success opens the receipt.
// =============================================================================

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import {
  apiErrorCode, createPuntoCollection, creditLimitError, fetchPuntoCollectClient, fetchPuntoMe, limitReached, lookupPuntoCollect,
  newIdempotencyKey, puntoKeys, toNumber,
  type PuntoCollectBody, type PuntoCollectResult, type PuntoCollectTarget, type PuntoOpenInvoice,
} from './puntoApi';
import { CreditLimitBagHint } from './PuntoBagsCard';
import { Chip, StatusChip, errorText, mutedText, pageTitle, sectionTitle, useRefreshPuntoMoney, usePuntoCurrency } from './puntoUi';

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const cents = (n: number) => Math.round(n * 100);

/** Oldest due first; an invoice without a due date goes last. */
function oldestFirst(invoices: PuntoOpenInvoice[]): PuntoOpenInvoice[] {
  return [...invoices].sort((a, b) => {
    if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    if (!a.due_date !== !b.due_date) return a.due_date ? -1 : 1;
    return a.id - b.id;
  });
}

function sumBalances(invoices: PuntoOpenInvoice[], ids: Set<number>): number {
  return invoices.filter(i => ids.has(i.id)).reduce((acc, i) => acc + cents(toNumber(i.balance)), 0) / 100;
}

function TargetHeader({ target }: { target: PuntoCollectTarget }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '1.05rem', overflowWrap: 'anywhere' }}>{target.name}</div>
        <div style={mutedText}>{t('punto.collect.clientNumber', { number: target.client_number })}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {target.own ? <Chip tone="info">{t('punto.collect.own')}</Chip> : <Chip>{t('punto.collect.notOwn')}</Chip>}
        <StatusChip status={target.status} />
      </div>
    </div>
  );
}

/** Step 1: find the subscriber. */
function Search({ onPick }: { onPick: (target: PuntoCollectTarget) => void }) {
  const { t } = useTranslation();
  const currency = usePuntoCurrency();
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const lookup = useMutation({
    mutationFn: (query: string) => lookupPuntoCollect(query),
    onError: (err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 429) setError(t('punto.collect.tooManyLookups'));
      else if (err instanceof ApiRequestError && err.status === 422) setError(t('punto.collect.queryInvalid'));
      else setError(err instanceof ApiRequestError && err.status < 500 ? err.message : t('punto.collect.lookupError'));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const query = q.trim();
    if (!/\d/.test(query)) { setError(t('punto.collect.queryRequired')); return; }
    lookup.mutate(query);
  }

  return (
    <>
      <form onSubmit={submit} noValidate className="punto-card" role="search">
        <div className="punto-field">
          <label htmlFor="punto-collect-q">{t('punto.collect.queryLabel')}</label>
          <input
            id="punto-collect-q"
            type="search"
            inputMode="tel"
            autoComplete="off"
            value={q}
            maxLength={30}
            placeholder={t('punto.collect.queryPlaceholder')}
            onChange={e => setQ(e.target.value)}
          />
        </div>
        <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.collect.queryHelp')}</p>
        {error && <p role="alert" style={errorText}>{error}</p>}
        <button type="submit" className="punto-btn-primary" disabled={lookup.isPending}>
          {lookup.isPending ? t('punto.collect.searching') : t('punto.collect.search')}
        </button>
      </form>

      {lookup.data && lookup.data.length === 0 && <EmptyState message={t('punto.collect.noResults')} />}
      {lookup.data && lookup.data.length > 0 && (
        <section aria-label={t('punto.collect.results')}>
          <ul className="punto-list">
            {lookup.data.map(r => (
              <li key={r.collect_token}>
                <button
                  type="button"
                  className="punto-card punto-list-link"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                  onClick={() => onPick(r)}
                >
                  <TargetHeader target={r} />
                  <div style={{ marginTop: 6, fontSize: '0.9rem' }}>
                    {t('punto.collect.amountDue')}:{' '}
                    <strong style={{ color: toNumber(r.amount_due) > 0 ? 'var(--danger)' : undefined }}>
                      {formatMoney(r.amount_due, currency)}
                    </strong>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** A refused collection, in the reader's language when the server names the reason. */
function useCollectErrorText() {
  const { t } = useTranslation();
  return (err: unknown, fallback: string): string => {
    const code = apiErrorCode(err);
    if (code === 'COLLECT_TOKEN_EXPIRED' || code === 'COLLECT_TOKEN_INVALID') return t('punto.collect.tokenExpired');
    if (code === 'INVOICE_NOT_PAYABLE') return t('punto.collect.invoicesChanged');
    if (err instanceof ApiRequestError && err.status === 403) return t('punto.collect.resellerInactive');
    return err instanceof ApiRequestError && err.status < 500 && err.message ? err.message : fallback;
  };
}

interface Draft { amount: number; invoiceIds: number[] | undefined; note: string; key: string }

/** Steps 2 and 3: what to collect, then the cash-received confirmation. */
function Collect({ target, onBack }: { target: PuntoCollectTarget; onBack: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currency = usePuntoCurrency();
  const refreshMoney = useRefreshPuntoMoney();
  const collectErrorText = useCollectErrorText();
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });
  const invoices = useMemo(() => oldestFirst(target.open_invoices ?? []), [target]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(invoices.map(i => i.id)));
  const [amount, setAmount] = useState(() => sumBalances(invoices, new Set(invoices.map(i => i.id))).toFixed(2));
  const [amountEdited, setAmountEdited] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  // Set with a cash-limit refusal: the empty bags the reseller could fill.
  const [limitBags, setLimitBags] = useState<number | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const fmt = (v: number | string) => formatMoney(v, currency);
  const selectedTotal = sumBalances(invoices, selected);
  const available = me.data?.money ? Math.max(0, toNumber(me.data.money.available_to_collect)) : null;
  const emptyBagsKnown = me.data?.money?.empty_bags === undefined ? null : toNumber(me.data.money.empty_bags);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    if (!amountEdited) setAmount(sumBalances(invoices, next).toFixed(2));
  }

  const pay = useMutation({
    mutationFn: (d: Draft) => {
      const body: PuntoCollectBody = { collect_token: target.collect_token, amount: d.amount };
      if (d.invoiceIds) body.invoice_ids = d.invoiceIds;
      if (d.note) body.note = d.note;
      return createPuntoCollection(body, d.key);
    },
    onSuccess: (result: PuntoCollectResult) => {
      refreshMoney();
      navigate(`/punto/recibo/${result.payment_id}`, { state: { result } });
    },
    onError: (err: unknown) => {
      const limit = creditLimitError(err);
      if (limit) {
        refreshMoney();
        setLimitBags(limit.emptyBags ?? emptyBagsKnown);
        setError(t('punto.collect.limitReachedNoAmount'));
      } else {
        setLimitBags(undefined);
        setError(collectErrorText(err, t('punto.collect.saveError')));
      }
    },
  });

  function review(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLimitBags(undefined);
    const raw = amount.trim();
    const value = Number(raw);
    if (selected.size === 0) { setError(t('punto.collect.pickInvoice')); return; }
    if (!AMOUNT.test(raw) || !(value > 0)) { setError(t('punto.collect.amountInvalid')); return; }
    if (cents(value) > cents(selectedTotal)) { setError(t('punto.collect.amountTooHigh', { max: fmt(selectedTotal) })); return; }
    // The limit is where a bag must be filled, not a cap on this payment:
    // only a reseller already at its limit is stopped.
    if (me.data?.money && limitReached(me.data.money)) {
      setLimitBags(emptyBagsKnown);
      setError(t('punto.collect.limitReachedNoAmount'));
      return;
    }
    // Every invoice selected is the server's default allocation (oldest first).
    const ids = invoices.filter(i => selected.has(i.id)).map(i => i.id);
    setDraft({ amount: value, invoiceIds: ids.length === invoices.length ? undefined : ids, note: note.trim(), key: newIdempotencyKey() });
  }

  if (invoices.length === 0) {
    return (
      <div className="punto-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TargetHeader target={target} />
        <p style={{ margin: 0 }}>{t('punto.collect.nothingDue')}</p>
        <button type="button" className="punto-btn-secondary" onClick={onBack}>{t('punto.collect.searchAgain')}</button>
      </div>
    );
  }

  if (draft) {
    return (
      <section className="punto-card" aria-labelledby="punto-collect-confirm" style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center' }}>
        <h2 id="punto-collect-confirm" style={{ ...sectionTitle, margin: 0 }}>{t('punto.collect.confirmTitle')}</h2>
        <div className="punto-amount-big">{fmt(draft.amount)}</div>
        <p style={{ margin: 0 }}>{t('punto.collect.confirmBody', { name: target.name, number: target.client_number })}</p>
        {error && <p role="alert" style={{ ...errorText, textAlign: 'left' }}>{error}</p>}
        {error && limitBags !== undefined && <CreditLimitBagHint emptyBags={limitBags} />}
        <button type="button" className="punto-btn-primary" disabled={pay.isPending} onClick={() => { setError(''); pay.mutate(draft); }}>
          {pay.isPending ? t('punto.collect.saving') : t('punto.collect.confirmYes', { amount: fmt(draft.amount) })}
        </button>
        <button type="button" className="punto-btn-secondary" disabled={pay.isPending} onClick={() => { setDraft(null); setError(''); setLimitBags(undefined); }}>
          {t('punto.collect.confirmBack')}
        </button>
      </section>
    );
  }

  const value = Number(amount);
  return (
    <form onSubmit={review} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="punto-card">
        <TargetHeader target={target} />
        <div className="punto-money-row" style={{ marginTop: 10 }}>
          <span>{t('punto.collect.amountDue')}</span>
          <strong style={{ fontSize: '1.2rem' }}>{fmt(target.amount_due)}</strong>
        </div>
      </div>

      <fieldset className="punto-card" style={{ margin: 0 }}>
        <legend style={{ ...sectionTitle, padding: '0 4px' }}>{t('punto.collect.invoices')}</legend>
        {invoices.map(inv => (
          <label key={inv.id} className="punto-check">
            <input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggle(inv.id)} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{inv.invoice_number || `#${inv.id}`}</span>
              <span style={{ ...mutedText, display: 'block' }}>{t('punto.clientDetail.dueDate', { date: formatDate(inv.due_date) })}</span>
            </span>
            <strong>{fmt(inv.balance)}</strong>
          </label>
        ))}
        <div className="punto-money-row" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          <span>{t('punto.collect.selectedTotal')}</span>
          <strong>{fmt(selectedTotal)}</strong>
        </div>
      </fieldset>

      <div className="punto-card">
        <div className="punto-field">
          <label htmlFor="punto-collect-amount">{t('punto.collect.amount')}</label>
          <input
            id="punto-collect-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={e => { setAmount(e.target.value); setAmountEdited(true); }}
          />
        </div>
        <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.collect.amountHelp')}</p>
        {available !== null && <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.collect.available', { available: fmt(available) })}</p>}
        <div className="punto-field" style={{ marginBottom: 0 }}>
          <label htmlFor="punto-collect-note">{t('punto.collect.note')}</label>
          <textarea id="punto-collect-note" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>

      {error && <p role="alert" style={errorText}>{error}</p>}
      {error && limitBags !== undefined && <CreditLimitBagHint emptyBags={limitBags} />}
      <button type="submit" className="punto-btn-primary">
        {t('punto.collect.collectCash', { amount: fmt(Number.isFinite(value) && value > 0 ? value : 0) })}
      </button>
      <button type="button" className="punto-btn-secondary" onClick={onBack}>{t('punto.collect.searchAgain')}</button>
    </form>
  );
}

export function PuntoCollect() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const clientId = Number(params.get('cliente'));
  const fromClient = Number.isInteger(clientId) && clientId > 0;
  const [target, setTarget] = useState<PuntoCollectTarget | null>(null);
  const preset = useQuery({
    queryKey: puntoKeys.collectClient(clientId),
    queryFn: () => fetchPuntoCollectClient(clientId),
    enabled: fromClient,
    // The token inside is short-lived: ask again on each visit, but never in
    // the background. Each answer carries a new token, and swapping the
    // target mid-collection would reset the amount, the invoices and the
    // Idempotency-Key of a payment that may already be on its way.
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  // The target is set once per client; a later answer for the same client
  // never replaces it. An expired token is answered by COLLECT_TOKEN_EXPIRED,
  // and "search again" starts over.
  useEffect(() => {
    const data = preset.data;
    if (fromClient && data) {
      setTarget(current => (current && current.client_number === data.client_number ? current : data));
    }
  }, [fromClient, preset.data]);

  function backToSearch() {
    setTarget(null);
    if (fromClient) setParams(new URLSearchParams(), { replace: true });
  }

  let body;
  if (target) {
    body = <Collect key={target.client_number} target={target} onBack={backToSearch} />;
  } else if (fromClient && preset.isLoading) {
    body = <LoadingState />;
  } else if (fromClient && preset.error instanceof ApiRequestError && preset.error.status === 404) {
    body = (
      <>
        <EmptyState message={t('punto.clientDetail.notFound')} />
        <button type="button" className="punto-btn-secondary" onClick={backToSearch}>{t('punto.collect.searchAgain')}</button>
      </>
    );
  } else if (fromClient && preset.isError) {
    body = <ErrorState message={t('punto.collect.lookupError')} onRetry={() => { void preset.refetch(); }} />;
  } else {
    body = <Search onPick={setTarget} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('punto.collect.title')}</h1>
      {body}
    </div>
  );
}
