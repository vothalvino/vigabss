// Money tie-out: a month's collections tied to the bank. What was collected
// and how it is invoiced, where the cash is on its way to the bank, whether
// the month's cash adds up, the bank accounts and the safe.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { formatMoney } from '@/lib/money';
import { TieOutBank } from './TieOutBank';
import { TieOutSafe } from './TieOutSafe';
import { type TieOutReport, TIEOUT_KEY, button, card, cardTitle, hint } from './tieOutShared';

function Line({ label, value, strong, tone, indent }: {
  label: string; value: number | null | undefined; strong?: boolean; tone?: 'good' | 'bad'; indent?: boolean;
}) {
  const color = tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--danger)' : 'var(--text-primary)';
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 16, padding: '4px 0', fontSize: '0.88rem',
      paddingLeft: indent ? 14 : 0, fontWeight: strong ? 700 : 400,
      borderTop: strong ? '1px solid var(--border)' : undefined, marginTop: strong ? 4 : 0,
    }}>
      <span style={{ color: indent ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{label}</span>
      <span style={{ color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatMoney(value)}</span>
    </div>
  );
}

function shiftMonth(year: number, month: number, by: number) {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function MoneyTieOut() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<{ year: number; month: number } | null>(null);

  const query = useQuery({
    queryKey: [...TIEOUT_KEY, 'report', picked?.year ?? null, picked?.month ?? null],
    queryFn: async () => {
      const { data, error } = await api.GET('/money-tieout', { params: { query: picked ?? {} } });
      if (error) throw new Error('tie-out');
      return data?.data as TieOutReport;
    },
    placeholderData: prev => prev,
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: TIEOUT_KEY }); };

  const report = query.data;
  if (query.isError && !report) return <p role="alert" style={{ padding: '1.5rem', color: 'var(--danger)' }}>{t('tieOut.failed')}</p>;
  if (!report) return <p style={{ padding: '1.5rem', color: 'var(--text-muted)' }}>{t('tieOut.loading')}</p>;

  const year = report.period?.year ?? new Date().getFullYear();
  const month = report.period?.month ?? 1;
  const currentMonth = report.period?.today?.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}`;
  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const collected = report.collected;
  const fiscal = report.fiscal;
  const cash = report.cash;
  const start = cash?.in_transit_start;
  const end = cash?.in_transit_end;
  const differences = cash?.differences;
  const attention = report.attention ?? [];
  const resico = report.resico;
  const unexplained = differences?.unexplained ?? 0;

  return (
    <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('tieOut.title')}</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" style={button} aria-label={t('tieOut.previousMonth')} onClick={() => setPicked(shiftMonth(year, month, -1))}>‹</button>
          <strong style={{ minWidth: 140, textAlign: 'center', color: 'var(--text-primary)', textTransform: 'capitalize' }}>{monthLabel}</strong>
          <button type="button" style={button} aria-label={t('tieOut.nextMonth')} disabled={currentMonth} onClick={() => setPicked(shiftMonth(year, month, 1))}>›</button>
        </div>
      </div>
      <p style={{ ...hint, margin: 0 }}>{report.period?.closed ? t('tieOut.closedMonth') : t('tieOut.openMonth')}</p>

      {attention.length > 0 && (
        <section aria-label={t('tieOut.attention.title')} style={{ ...card, background: 'var(--warning-soft)' }}>
          <h2 style={cardTitle}>{t('tieOut.attention.title')}</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
            {attention.map((a, i) => (
              <li key={`${a.kind}-${a.bag_id ?? a.pickup_id ?? i}`}>
                {a.kind === 'bag_waiting' && t('tieOut.attention.bag', { serial: a.serial, point: a.point_name ?? '', amount: formatMoney(a.amount), days: a.days })}
                {a.kind === 'pickup_unconfirmed' && t('tieOut.attention.pickup', { amount: formatMoney(a.amount), days: a.days })}
                {a.kind === 'safe_waiting' && t('tieOut.attention.safe', { amount: formatMoney(a.amount), days: a.days })}
                {a.kind === 'safe_not_counted' && t('tieOut.attention.notCounted')}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section style={card} aria-label={t('tieOut.collected.title')}>
          <h2 style={cardTitle}>{t('tieOut.collected.title')}</h2>
          <p style={hint}>{t('tieOut.collected.hint', { count: collected?.count ?? 0 })}</p>
          <Line label={t('tieOut.collected.cashStaff')} value={collected?.cash_staff} />
          <Line label={t('tieOut.collected.cashPoints')} value={collected?.cash_points} />
          <Line label={t('tieOut.collected.nonCash')} value={collected?.non_cash} />
          {(collected?.by_method ?? []).filter(m => m.method !== 'cash').map(m => (
            <Line key={m.method} indent label={t(`tieOut.methods.${m.method}`, { defaultValue: m.method ?? '' })} value={m.total} />
          ))}
          <Line strong label={t('tieOut.collected.total')} value={collected?.total} />
        </section>

        <section style={card} aria-label={t('tieOut.fiscal.title')}>
          <h2 style={cardTitle}>{t('tieOut.fiscal.title')}</h2>
          <p style={hint}>{t('tieOut.fiscal.hint')}</p>
          <Line label={t('tieOut.fiscal.clientCfdi')} value={fiscal?.client_cfdi} />
          <Line label={t('tieOut.fiscal.generalPublic')} value={fiscal?.general_public} />
          <Line indent label={t('tieOut.fiscal.stamped')} value={fiscal?.general_public_stamped} />
          <Line indent label={t('tieOut.fiscal.pending')} value={fiscal?.general_public_pending} />
          <Line indent label={t('tieOut.fiscal.partPayments')} value={fiscal?.unpaid_no_cfdi} />
          <Line indent label={t('tieOut.fiscal.credit')} value={fiscal?.credit} />
          <Line strong label={t('tieOut.collected.total')} value={collected?.total} />
          {(fiscal?.general_public_pending ?? 0) > 0 && (
            <p style={{ ...hint, margin: '8px 0 0' }}><Link to="/facturas-publicas">{t('tieOut.fiscal.goToGlobal')}</Link></p>
          )}
        </section>

        <section style={card} aria-label={t('tieOut.transit.title')}>
          <h2 style={cardTitle}>{t('tieOut.transit.title')}</h2>
          <p style={hint}>{report.period?.closed ? t('tieOut.transit.hintClosed') : t('tieOut.transit.hintOpen')}</p>
          <Line label={t('tieOut.transit.atPoints')} value={end?.at_points} />
          <Line label={t('tieOut.transit.inBags')} value={end?.in_bags} />
          <Line label={t('tieOut.transit.inDrawers')} value={end?.in_drawers} />
          <Line label={t('tieOut.transit.inSafe')} value={end?.in_safe} />
          <Line strong label={t('tieOut.transit.total')} value={end?.total} />
          {(end?.owed_to_points ?? 0) > 0 && <Line indent label={t('tieOut.transit.owedToPoints')} value={end?.owed_to_points} />}
        </section>

        <section style={card} aria-label={t('tieOut.sum.title')}>
          <h2 style={cardTitle}>{t('tieOut.sum.title')}</h2>
          {!cash?.tracked || !differences
            ? <p style={hint}>{t('tieOut.sum.notTracked')}</p>
            : (
              <>
                <p style={hint}>{t('tieOut.sum.hint')}</p>
                <Line label={t('tieOut.sum.recorded')} value={cash.recorded} />
                <Line label={t('tieOut.sum.deposited')} value={-(cash.deposited ?? 0)} />
                <Line label={t('tieOut.sum.commissions')} value={-(cash.commissions_kept ?? 0)} />
                {(cash.other_out ?? 0) !== 0 && <Line label={t('tieOut.sum.otherOut')} value={-(cash.other_out ?? 0)} />}
                {(cash.other_in ?? 0) !== 0 && <Line label={t('tieOut.sum.otherIn')} value={cash.other_in} />}
                <Line label={t('tieOut.sum.transitChange')} value={-((end?.position ?? 0) - (start?.position ?? 0))} />
                <Line strong label={t('tieOut.sum.differences')} value={differences.total} />
                {(differences.cashier_counts ?? 0) !== 0 && <Line indent label={t('tieOut.sum.cashierCounts')} value={differences.cashier_counts} />}
                {(differences.bag_counts ?? 0) !== 0 && <Line indent label={t('tieOut.sum.bagCounts')} value={differences.bag_counts} />}
                {(differences.safe_counts ?? 0) !== 0 && <Line indent label={t('tieOut.sum.safeCounts')} value={differences.safe_counts} />}
                {(differences.point_adjustments ?? 0) !== 0 && <Line indent label={t('tieOut.sum.pointAdjustments')} value={differences.point_adjustments} />}
                {(differences.point_payouts ?? 0) !== 0 && <Line indent label={t('tieOut.sum.pointPayouts')} value={differences.point_payouts} />}
                <Line strong tone={unexplained === 0 ? 'good' : 'bad'} label={t('tieOut.sum.unexplained')} value={unexplained} />
                <p style={{ ...hint, margin: '8px 0 0' }}>{unexplained === 0 ? t('tieOut.sum.addsUp') : t('tieOut.sum.doesNotAddUp')}</p>
              </>
            )}
        </section>
      </div>

      {resico?.applies && (
        <section style={card} aria-label={t('tieOut.resico.title')}>
          <h2 style={cardTitle}>{t('tieOut.resico.title')}</h2>
          <p style={hint}>{t('tieOut.resico.hint', { year: resico.year })}</p>
          <div
            role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, resico.percent ?? 0)}
            style={{ height: 10, borderRadius: 5, background: 'var(--bg-subtle)', overflow: 'hidden' }}
          >
            <div style={{ height: '100%', width: `${Math.min(100, resico.percent ?? 0)}%`, background: (resico.percent ?? 0) >= 85 ? 'var(--danger)' : 'var(--success)' }} />
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
            {t('tieOut.resico.line', { income: formatMoney(resico.income), limit: formatMoney(resico.limit), percent: resico.percent })}
          </p>
        </section>
      )}

      <TieOutSafe report={report} onChanged={refresh} />
      <TieOutBank report={report} onChanged={refresh} />
    </div>
  );
}
