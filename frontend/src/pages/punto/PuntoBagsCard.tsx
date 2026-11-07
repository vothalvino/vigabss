// =============================================================================
// Reseller app (/punto) — "Mis bolsas" card on Inicio, and the bag pieces
// =============================================================================
// The ISP hands the reseller numbered cash bags. Sealing one with the cash in
// it (Mis bolsas, /punto/bolsas) takes that cash off the reseller's cash on
// hand at once, which frees its cash limit; the carrier then picks the bag
// up and the ISP counts it on arrival. The card shows the empty bags at
// hand, the cash outside bags against the limit, and the bags waiting for
// the carrier or on their way. It needs reseller_app.bags.
// =============================================================================

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { fetchPuntoBags, puntoKeys, toNumber, type PuntoBag, type PuntoMoney } from './puntoApi';
import { Chip, mutedText } from './puntoUi';

const BAG_TONE: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  at_reseller: 'neutral', ready_for_pickup: 'warning', in_transit: 'info',
};

export function BagStatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Chip tone={BAG_TONE[status] ?? 'neutral'}>{t(`puntoBags.status.${status}`, { defaultValue: status })}</Chip>;
}

export interface BagCounts { empty: number; ready: number; transit: number }

/** Bags per state, from the list, or from /me's counts while the list is not loaded. */
export function bagCounts(bags: PuntoBag[] | undefined, money?: PuntoMoney | null): BagCounts {
  const list = bags ?? [];
  return {
    empty: bags ? list.filter(b => b.status === 'at_reseller').length : toNumber(money?.empty_bags ?? 0),
    ready: bags ? list.filter(b => b.status === 'ready_for_pickup').length : toNumber(money?.bags_ready_for_pickup ?? 0),
    transit: bags ? list.filter(b => b.status === 'in_transit').length : toNumber(money?.bags_in_transit ?? 0),
  };
}

export function PuntoBagsCard({ money }: { money: PuntoMoney }) {
  const { t } = useTranslation();
  const bags = useQuery({ queryKey: puntoKeys.bags, queryFn: fetchPuntoBags });
  const counts = bagCounts(bags.data, money);
  const fmt = (v: number | string | null | undefined) => formatMoney(v ?? 0, money.currency);
  const atLimit = toNumber(money.available_to_collect) <= 0;

  return (
    <section className="punto-card" aria-labelledby="punto-bags-card-title" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="punto-bags-card-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('puntoBags.card.title')}</h2>
      <div className="punto-money-row">
        <span>{t('puntoBags.card.empty')}</span>
        <strong>{counts.empty}</strong>
      </div>
      <div className="punto-money-row">
        <span>{t('puntoBags.money.cashOnHand')}</span>
        <strong>{t('puntoBags.card.ofLimit', { held: fmt(money.cash_on_hand), limit: fmt(money.credit_limit) })}</strong>
      </div>
      {money.in_bags !== undefined && (
        <div className="punto-money-row">
          <span>{t('puntoBags.money.inBags')}</span>
          <strong>{fmt(money.in_bags)}</strong>
        </div>
      )}
      <p style={mutedText}>
        {t('puntoBags.card.waiting', { count: counts.ready })} · {t('puntoBags.card.onTheirWay', { count: counts.transit })}
      </p>
      {counts.empty > 0 && toNumber(money.cash_on_hand) > 0 && (
        <Link to="/punto/bolsas" className={atLimit ? 'punto-btn-primary' : 'punto-btn-secondary'}>{t('puntoBags.card.fill')}</Link>
      )}
      {counts.empty === 0 && atLimit && <p style={mutedText}>{t('puntoBags.card.noEmpty')}</p>}
      <Link to="/punto/bolsas" style={{ fontSize: '0.9rem' }}>{t('puntoBags.card.view')}</Link>
    </section>
  );
}

/**
 * Under Cobrar's cash-limit refusal: with an empty bag at hand, filling it
 * frees the limit at once; without one, wait for the carrier's bags or hand
 * the cash in. Nothing without reseller_app.bags or an older server that
 * does not say how many empty bags there are.
 */
export function CreditLimitBagHint({ emptyBags }: { emptyBags: number | null }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (emptyBags === null || !can(user, 'reseller_app.bags')) return null;
  return emptyBags > 0 ? (
    <p style={{ margin: '0 0 12px', fontWeight: 600 }}>
      <Link to="/punto/bolsas">{t('puntoBags.fillToCollect')}</Link>
    </p>
  ) : (
    <p style={{ ...mutedText, margin: '0 0 12px' }}>{t('puntoBags.waitForBags')}</p>
  );
}
