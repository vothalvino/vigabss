// Reminders about the cashier, shown on every staff page:
//  - to the person with an open cashier: that it is open, since when and how
//    much cash it expects; more firmly once it is past the allowed hours
//  - to supervisors: cashiers left open too long, and counts waiting for a
//    review
// Nothing renders for people these do not concern.
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCashierAttention, useMyCashier } from './cashierReminderData';

const CASHIER_PATH = '/cash-reconciliation';

function time(value: string, locale: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function money(value: number, locale: string): string {
  return value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CashierReminder() {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const mine = useMyCashier().data;
  const attention = useCashierAttention().data;
  const onCashierPage = pathname === CASHIER_PATH;

  // The supervisor's line leaves out their own cashier: the first bar covers it.
  const othersOverdue = (attention?.overdue_open ?? []).filter((s) => s.id !== mine?.id);
  const othersOverLimit = (attention?.over_threshold ?? []).filter((s) => s.id !== mine?.id);
  const openedDifferent = attention?.opening_differences ?? [];
  const awaiting = attention?.awaiting_review ?? 0;
  const who = (rows: { agent_name: string | null; agent_user_id: number }[]) =>
    rows.slice(0, 3).map((s) => s.agent_name || `#${s.agent_user_id}`).join(', ');
  const supervisorLines = [
    othersOverdue.length > 0 && t('cashierReminder.othersOverdue', { count: othersOverdue.length, hours: attention?.max_open_hours, names: who(othersOverdue) }),
    othersOverLimit.length > 0 && t('cashierReminder.othersOverLimit', { count: othersOverLimit.length, names: who(othersOverLimit) }),
    openedDifferent.length > 0 && t('cashierReminder.openedDifferent', { count: openedDifferent.length, names: who(openedDifferent) }),
    awaiting > 0 && t('cashierReminder.awaitingReview', { count: awaiting }),
  ].filter(Boolean) as string[];

  if (!mine && supervisorLines.length === 0) return null;

  return (
    <>
      {mine && (
        <div role={mine.overdue ? 'alert' : 'status'} style={{ ...bar, ...(mine.overdue ? danger : mine.over_threshold ? warn : info) }} data-testid="my-cashier-bar">
          <span>
            {mine.overdue
              ? t('cashierReminder.mineOverdue', { hours: mine.max_open_hours })
              : t('cashierReminder.mineOpen', { since: time(mine.opened_at, i18n.language) })}
            {' '}
            {t('cashierReminder.expected', { amount: money(mine.expected_total, i18n.language) })}
            {mine.over_threshold && (
              <strong>{' '}{t(mine.pickup_strict ? 'cashierReminder.overLimitStrict' : 'cashierReminder.overLimit', { limit: money(mine.pickup_threshold ?? 0, i18n.language) })}</strong>
            )}
            {(mine.pending_pickups ?? 0) > 0 && (
              <strong>{' '}{t('cashierReminder.pendingPickup', { count: mine.pending_pickups, amount: money(mine.pending_pickups_total ?? 0, i18n.language) })}</strong>
            )}
          </span>
          {!onCashierPage && <Link to={CASHIER_PATH} style={link}>{t((mine.pending_pickups ?? 0) > 0 ? 'cashierReminder.confirmIt' : 'cashierReminder.closeIt')}</Link>}
        </div>
      )}
      {supervisorLines.length > 0 && (
        <div role="status" style={{ ...bar, ...warn }} data-testid="cashier-attention-bar">
          <span>{supervisorLines.join(' ')}</span>
          {!onCashierPage && <Link to={CASHIER_PATH} style={link}>{t('cashierReminder.review')}</Link>}
        </div>
      )}
    </>
  );
}

const bar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between',
  padding: '8px 16px', fontSize: '0.875rem', borderBottom: '1px solid transparent',
};
const info: React.CSSProperties = { background: '#eff6ff', color: '#1e3a8a', borderBottomColor: '#bfdbfe' };
const warn: React.CSSProperties = { background: '#fffbeb', color: '#78350f', borderBottomColor: '#fde68a' };
const danger: React.CSSProperties = { background: '#fef2f2', color: '#7f1d1d', borderBottomColor: '#fecaca', fontWeight: 600 };
const link: React.CSSProperties = { color: 'inherit', fontWeight: 700, textDecoration: 'underline', whiteSpace: 'nowrap' };
