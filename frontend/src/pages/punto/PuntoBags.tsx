// =============================================================================
// Reseller app (/punto/bolsas) — Mis bolsas
// =============================================================================
// The reseller's cash bags (GET /reseller-app/bags) and "Llenar bolsa":
//   1. choose an empty bag: tap it in the list, or scan or type its serial;
//   2. the amount put in it, prefilled with the cash on hand (more than 0, at
//      most the cash on hand, two decimals);
//   3. confirm: POST /reseller-app/bags/seal. The bag is then ready for the
//      carrier and its amount is taken off what the reseller owes at once
//      ("Bolsa sellada" in Mi caja's movements), so it no longer counts
//      against the cash limit and the reseller can collect again (409
//      BAG_AMOUNT_EXCEEDS_CASH when the amount is more than the cash it
//      holds).
// The ISP counts the bag when it arrives; a difference shows up later as an
// adjustment in Mi caja's movements. Reached from Inicio and Mi caja (not a
// bottom tab). Needs reseller_app.bags.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { SerialScanInput } from '@/components/SerialScanInput';
import { formatMoney } from '@/lib/money';
import { apiErrorCode, fetchPuntoBags, fetchPuntoMe, puntoKeys, sealPuntoBag, toNumber, type PuntoBag, type PuntoMoney } from './puntoApi';
import { BagStatusChip } from './PuntoBagsCard';
import { errorText, formatDateTime, mutedText, pageTitle, sectionTitle, useRefreshPuntoMoney } from './puntoUi';

const AMOUNT = /^\d+(\.\d{1,2})?$/;
const cents = (n: number) => Math.round(n * 100);
const mono = { fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, overflowWrap: 'anywhere' } as const;

function MoneySummary({ money }: { money: PuntoMoney }) {
  const { t } = useTranslation();
  const fmt = (v: number | string | null | undefined) => formatMoney(v ?? 0, money.currency);
  const limit = toNumber(money.credit_limit);
  const held = toNumber(money.cash_on_hand);
  const used = limit > 0 ? Math.min(100, Math.round((held / limit) * 100)) : 100;
  const color = used >= 100 ? 'var(--danger)' : used >= 80 ? 'var(--warning)' : 'var(--success)';
  return (
    <section className="punto-card" aria-labelledby="punto-bags-money" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="punto-bags-money" style={{ ...sectionTitle, margin: 0 }}>{t('puntoBags.money.title')}</h2>
      <div className="punto-money-row"><span>{t('puntoBags.money.cashOnHand')}</span><strong style={{ fontSize: '1.3rem' }}>{fmt(money.cash_on_hand)}</strong></div>
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
      <p style={mutedText}>{t('punto.money.limit', { limit: fmt(limit) })}</p>
      <div className="punto-money-row"><span>{t('puntoBags.money.inBags')}</span><strong>{fmt(money.in_bags)}</strong></div>
      <p style={mutedText}>{t('puntoBags.money.inBagsHelp')}</p>
      <div className="punto-money-row"><span>{t('punto.money.canCollect')}</span><strong>{fmt(Math.max(0, toNumber(money.available_to_collect)))}</strong></div>
    </section>
  );
}

interface Draft { serial: string; amount: number }

interface SealFormProps {
  empties: PuntoBag[];
  money: PuntoMoney;
  onSealed: (text: string) => void;
  // Owned by PuntoBags: a refusal refetches the money and the bags, which
  // may hide this form (no cash or no empty bag left), and its explanation
  // must outlive that.
  error: string;
  setError: (text: string) => void;
}

function SealForm({ empties, money, onSealed, error, setError }: SealFormProps) {
  const { t } = useTranslation();
  const refreshMoney = useRefreshPuntoMoney();
  const cash = toNumber(money.cash_on_hand);
  const [serial, setSerial] = useState('');
  // The amount follows the cash on hand until the reseller types one, so a
  // refetch (after a seal or a refusal) updates the prefill without
  // remounting the form and losing the chosen bag or the message.
  const [typed, setTyped] = useState<string | null>(null);
  const amount = typed ?? (cash > 0 ? cash.toFixed(2) : '');
  const [draft, setDraft] = useState<Draft | null>(null);
  const fmt = (v: number | string) => formatMoney(v, money.currency);

  const seal = useMutation({
    mutationFn: (d: Draft) => sealPuntoBag({ serial: d.serial, declared_amount: d.amount }),
    onSuccess: (_res, d: Draft) => {
      refreshMoney();
      setDraft(null);
      setSerial('');
      setTyped(null);
      onSealed(t('puntoBags.seal.done', { serial: d.serial, amount: fmt(d.amount) }));
    },
    onError: (err: unknown) => {
      setDraft(null);
      const code = apiErrorCode(err);
      if (code === 'BAG_AMOUNT_EXCEEDS_CASH') { refreshMoney(); setError(t('puntoBags.seal.exceedsCash')); return; }
      // The bag is no longer an empty bag of this reseller: choose another.
      if (err instanceof ApiRequestError && err.status === 404) { refreshMoney(); setSerial(''); setError(t('puntoBags.seal.notFound')); return; }
      if (err instanceof ApiRequestError && err.status === 409) { refreshMoney(); setSerial(''); setError(t('puntoBags.seal.conflict')); return; }
      setError(err instanceof ApiRequestError && err.status < 500 && err.message ? err.message : t('puntoBags.seal.error'));
    },
  });

  function choose(next: string) {
    setError('');
    setDraft(null);
    setSerial(next);
  }

  function review(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!serial) { setError(t('puntoBags.seal.pickBag')); return; }
    const raw = amount.trim();
    const value = Number(raw);
    if (!AMOUNT.test(raw) || !(value > 0)) { setError(t('puntoBags.seal.amountInvalid')); return; }
    if (cents(value) > cents(cash)) { setError(t('puntoBags.seal.amountTooHigh', { max: fmt(cash) })); return; }
    setDraft({ serial, amount: value });
  }

  return (
    <section className="punto-card" aria-labelledby="punto-bags-seal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="punto-bags-seal" style={{ ...sectionTitle, margin: 0 }}>{t('puntoBags.seal.title')}</h2>
      <p style={mutedText}>{t('puntoBags.seal.help')}</p>
      {empties.length > 0 && (
        <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{t('puntoBags.seal.chooseBag')}</legend>
          {empties.map(b => (
            <label key={b.serial} className="punto-check">
              <input type="radio" name="punto-seal-bag" checked={serial === b.serial} onChange={() => choose(b.serial)} />
              <span style={mono}>{b.serial}</span>
              {b.status === 'with_carrier' && <span style={mutedText}>{' · '}{t('puntoBags.seal.onTheWay')}</span>}
            </label>
          ))}
        </fieldset>
      )}
      <SerialScanInput
        label={t('puntoBags.seal.serial')}
        submitLabel={t('puntoBags.seal.useSerial')}
        clearOnSubmit
        onSerial={choose}
      />
      {serial && (
        draft ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'center' }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{t('puntoBags.seal.confirm', { serial: draft.serial, amount: fmt(draft.amount) })}</p>
            <p style={mutedText}>{t('puntoBags.seal.confirmHelp')}</p>
            {error && <p role="alert" style={{ ...errorText, textAlign: 'left' }}>{error}</p>}
            <button type="button" className="punto-btn-primary" disabled={seal.isPending} onClick={() => { setError(''); seal.mutate(draft); }}>
              {seal.isPending ? t('puntoBags.seal.saving') : t('puntoBags.seal.yes')}
            </button>
            <button type="button" className="punto-btn-secondary" disabled={seal.isPending} onClick={() => setDraft(null)}>{t('puntoBags.seal.back')}</button>
          </div>
        ) : (
          <form onSubmit={review} noValidate>
            <p style={{ margin: '0 0 10px' }}>{t('puntoBags.seal.chosen')} <span style={mono}>{serial}</span></p>
            <div className="punto-field">
              <label htmlFor="punto-seal-amount">{t('puntoBags.seal.amount')}</label>
              <input id="punto-seal-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={e => setTyped(e.target.value)} />
            </div>
            <p style={{ ...mutedText, marginBottom: 12 }}>{t('puntoBags.seal.amountHelp', { cash: fmt(cash) })}</p>
            {error && <p role="alert" style={errorText}>{error}</p>}
            <button type="submit" className="punto-btn-primary">{t('puntoBags.seal.review')}</button>
          </form>
        )
      )}
      {!serial && error && <p role="alert" style={errorText}>{error}</p>}
    </section>
  );
}

function BagSection({ id, title, bags, currency, when }: { id: string; title: string; bags: PuntoBag[]; currency: string; when: 'sealed' | 'picked' }) {
  const { t } = useTranslation();
  if (bags.length === 0) return null;
  return (
    <section className="punto-card" aria-labelledby={id}>
      <h2 id={id} style={sectionTitle}>{title}</h2>
      <ul className="punto-list">
        {bags.map(b => (
          <li key={b.serial} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={mono}>{b.serial}</div>
              <div style={mutedText}>
                {when === 'sealed' ? t('puntoBags.list.sealedAt', { date: formatDateTime(b.sealed_at) }) : t('puntoBags.list.pickedAt', { date: formatDateTime(b.picked_up_at) })}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <strong>{formatMoney(b.declared_amount, currency)}</strong>
              <BagStatusChip status={b.status} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PuntoBags() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const allowed = can(user, 'reseller_app.bags');
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });
  const bags = useQuery({ queryKey: puntoKeys.bags, queryFn: fetchPuntoBags, enabled: allowed });
  const [msg, setMsg] = useState('');
  const [sealError, setSealError] = useState('');
  const money = me.data?.money;
  const currency = money?.currency || me.data?.currency || user?.organization_currency || 'MXN';
  const list = bags.data ?? [];
  // Bags staff assigned to this point are its own as soon as a carrier has
  // them: they may be filled before the carrier confirms the delivery.
  const empties = list.filter(b => b.status === 'at_reseller' || b.status === 'with_carrier');
  const onTheWay = list.filter(b => b.status === 'with_carrier');
  const showSealForm = Boolean(money && bags.data && empties.length > 0 && toNumber(money.cash_on_hand) > 0);
  const onSealed = (text: string) => { setSealError(''); setMsg(text); };

  if (!allowed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 style={{ ...pageTitle, margin: 0 }}>{t('puntoBags.title')}</h1>
        <p role="alert" className="punto-card" style={{ margin: 0 }}>{t('puntoBags.noAccess')}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('puntoBags.title')}</h1>
      <p style={mutedText}>{t('puntoBags.intro')}</p>
      {msg && <div role="status" className="punto-card" style={{ background: 'var(--success-soft)', fontWeight: 600 }}>{msg}</div>}
      {(me.isLoading || bags.isLoading) && <LoadingState />}
      {me.isError && <ErrorState message={t('punto.home.loadError')} onRetry={() => { void me.refetch(); }} />}
      {bags.isError && <ErrorState message={t('puntoBags.loadError')} onRetry={() => { void bags.refetch(); }} />}
      {money && <MoneySummary money={money} />}
      {money && showSealForm && <SealForm empties={empties} money={money} onSealed={onSealed} error={sealError} setError={setSealError} />}
      {!showSealForm && sealError && <p role="alert" className="punto-card" style={{ ...errorText, margin: 0 }}>{sealError}</p>}
      {money && bags.data && empties.length > 0 && !showSealForm && (
        <p className="punto-card" style={{ margin: 0 }}>{t('puntoBags.seal.noCash')}</p>
      )}
      {bags.data && empties.length === 0 && <p className="punto-card" style={{ margin: 0 }}>{t('puntoBags.list.noEmpty')}</p>}
      {bags.data && (
        <>
          <BagSection id="punto-bags-ready" title={t('puntoBags.list.readyTitle')} bags={list.filter(b => b.status === 'ready_for_pickup')} currency={currency} when="sealed" />
          <BagSection id="punto-bags-transit" title={t('puntoBags.list.transitTitle')} bags={list.filter(b => b.status === 'in_transit')} currency={currency} when="picked" />
          {empties.length > onTheWay.length && (
            <section className="punto-card" aria-labelledby="punto-bags-empty">
              <h2 id="punto-bags-empty" style={sectionTitle}>{t('puntoBags.list.emptyTitle', { count: empties.length - onTheWay.length })}</h2>
              <p style={{ ...mono, margin: 0 }}>{empties.filter(b => b.status === 'at_reseller').map(b => b.serial).join(', ')}</p>
            </section>
          )}
          {onTheWay.length > 0 && (
            <section className="punto-card" aria-labelledby="punto-bags-coming">
              <h2 id="punto-bags-coming" style={sectionTitle}>{t('puntoBags.list.comingTitle', { count: onTheWay.length })}</h2>
              <p style={mutedText}>{t('puntoBags.list.comingHelp')}</p>
              <p style={{ ...mono, margin: 0 }}>{onTheWay.map(b => b.serial).join(', ')}</p>
            </section>
          )}
        </>
      )}
      <Link to="/punto/caja" style={{ fontSize: '0.9rem' }}>{t('puntoBags.toCash')}</Link>
    </div>
  );
}
