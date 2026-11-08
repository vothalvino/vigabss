// =============================================================================
// Reseller app (/punto) — Inicio
// =============================================================================
// The reseller's numbers from GET /reseller-app/me: the cash it holds for the
// ISP against its limit (money), today's collections, the commission it
// earned this month (phase 4), its cash bags (with reseller_app.bags), the
// phase-1 counts, and the main actions (collect, new sign-up).
//
// The reseller keeps its commission from the cash it collects: a paid invoice
// of one of its clients takes the commission off what it must hand in. When
// its commissions pass the cash it holds, the balance is negative and the
// card says what the ISP owes it ("Te debemos") instead.
// =============================================================================

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import { fetchPuntoMe, puntoKeys, toNumber, type PuntoMoney } from './puntoApi';
import { PuntoBagsCard } from './PuntoBagsCard';
import { mutedText, pageTitle } from './puntoUi';

/**
 * What the reseller owes, what it may still collect (a bar against its cash
 * limit) and today's total. At the limit the server refuses new collections,
 * so the card says how to keep collecting.
 */
export function MoneyCard({ money, canCollect, canBags = false }: { money: PuntoMoney; canCollect: boolean; canBags?: boolean }) {
  const { t } = useTranslation();
  const limit = toNumber(money.credit_limit);
  const balance = toNumber(money.balance);
  // A negative balance is what the ISP owes the reseller (its commissions).
  const owedToReseller = balance < 0;
  const held = Math.max(0, toNumber(money.cash_on_hand));
  const available = Math.max(0, toNumber(money.available_to_collect));
  const used = limit > 0 ? Math.min(100, Math.round((held / limit) * 100)) : 100;
  const atLimit = available <= 0;
  const color = atLimit ? 'var(--danger)' : used >= 80 ? 'var(--warning)' : 'var(--success)';
  const fmt = (v: number | string) => formatMoney(v, money.currency);

  return (
    <section className="punto-card" aria-labelledby="punto-money-title" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 id="punto-money-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('punto.money.title')}</h2>
      <div className="punto-money-row">
        <span>{owedToReseller ? t('punto.money.owedToYou') : t('punto.money.owe')}</span>
        <strong style={{ fontSize: '1.4rem', ...(owedToReseller ? { color: 'var(--success)' } : {}) }}>
          {fmt(owedToReseller ? -balance : money.balance)}
        </strong>
      </div>
      {money.in_bags !== undefined && toNumber(money.in_bags) > 0 && (
        <div className="punto-money-row">
          <span>{t('puntoBags.money.inBags')}</span>
          <strong>{fmt(money.in_bags)}</strong>
        </div>
      )}
      <div className="punto-money-row">
        <span>{t('punto.money.canCollect')}</span>
        <strong style={{ fontSize: '1.15rem', color }}>{fmt(available)}</strong>
      </div>
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
      {atLimit && (
        <p role="alert" style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--danger-soft)', color: 'var(--danger)', fontWeight: 600 }}>
          {t('punto.money.atLimit')}
        </p>
      )}
      {atLimit && canBags && toNumber(money.empty_bags ?? 0) > 0 && (
        <Link to="/punto/bolsas" className="punto-btn-primary">{t('puntoBags.fillToCollect')}</Link>
      )}
      <div className="punto-money-row" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
        <span>{t('punto.money.collectedToday')}</span>
        <strong>{fmt(money.collected_today)}</strong>
      </div>
      {canCollect && !atLimit && <Link to="/punto/cobrar" className="punto-btn-primary">{t('punto.money.collect')}</Link>}
      <Link to="/punto/caja" style={{ fontSize: '0.9rem' }}>{t('punto.money.viewCash')}</Link>
    </section>
  );
}

/** A commission rate such as 10 or 7.5, without trailing zeros. */
function rateText(value: number | string | undefined): string {
  return String(Math.round(toNumber(value) * 100) / 100);
}

/**
 * What the reseller earned this month on its clients' paid invoices, at its
 * (top-level) rate. Hidden for a reseller that earns no commission.
 */
export function CommissionCard({ money }: { money: PuntoMoney }) {
  const { t } = useTranslation();
  if (money.commission_month === undefined) return null;
  const rate = toNumber(money.commission_rate);
  const month = toNumber(money.commission_month);
  if (rate <= 0 && month <= 0) return null;
  return (
    <section className="punto-card" aria-labelledby="punto-commission-title" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="punto-commission-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('punto.commission.title')}</h2>
      <div className="punto-money-row">
        <span>{t('punto.commission.month')}</span>
        <strong style={{ fontSize: '1.15rem', color: 'var(--success)' }}>{formatMoney(month, money.currency)}</strong>
      </div>
      {rate > 0 && <p style={mutedText}>{t('punto.commission.help', { rate: rateText(money.commission_rate) })}</p>}
    </section>
  );
}

function StatCard({ label, value, to, tone }: { label: string; value: number; to: string; tone?: string }) {
  return (
    <Link to={to} className="punto-card punto-list-link" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '1.75rem', fontWeight: 700, color: tone ?? 'var(--text-primary)' }}>{value}</span>
      <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{label}</span>
    </Link>
  );
}

export function PuntoHome() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canSignup = can(user, 'reseller_app.signup');
  const canCollect = can(user, 'reseller_app.collect');
  const canBags = can(user, 'reseller_app.bags');
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={pageTitle}>{t('punto.home.title')}</h1>
        {me.data && <p style={mutedText}>{t('punto.home.greeting', { name: me.data.reseller.name })}</p>}
      </div>

      {me.isLoading && <LoadingState />}
      {me.isError && <ErrorState message={t('punto.home.loadError')} onRetry={() => { void me.refetch(); }} />}
      {me.data?.money && <MoneyCard money={me.data.money} canCollect={canCollect} canBags={canBags} />}
      {me.data?.money && <CommissionCard money={me.data.money} />}
      {me.data?.money && canBags && <PuntoBagsCard money={me.data.money} />}

      {canSignup && (
        <Link to="/punto/nuevo" className={me.data?.money && canCollect ? 'punto-btn-secondary' : 'punto-btn-primary'}>
          {t('punto.home.newClient')}
        </Link>
      )}
      {me.data && (
        <section aria-label={t('punto.home.summary')} className="punto-stats">
          <StatCard label={t('punto.home.activeClients')} value={me.data.counts.active_clients} to="/punto/clientes?status=active" tone="var(--success)" />
          <StatCard label={t('punto.home.suspendedClients')} value={me.data.counts.suspended_clients} to="/punto/clientes?status=suspended" tone="var(--warning)" />
          <StatCard label={t('punto.home.overdueClients')} value={me.data.counts.overdue_clients} to="/punto/clientes?overdue=1" tone="var(--danger)" />
          <StatCard label={t('punto.home.openLeads')} value={me.data.counts.open_leads} to="/punto/prospectos" />
        </section>
      )}
    </div>
  );
}
