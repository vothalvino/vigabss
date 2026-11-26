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
  const awaiting = attention?.awaiting_review ?? 0;

  if (!mine && othersOverdue.length === 0 && awaiting === 0) return null;

  return (
    <>
      {mine && (
        <div role={mine.overdue ? 'alert' : 'status'} style={{ ...bar, ...(mine.overdue ? danger : info) }} data-testid="my-cashier-bar">
          <span>
            {mine.overdue
              ? t('cashierReminder.mineOverdue', { hours: mine.max_open_hours })
              : t('cashierReminder.mineOpen', { since: time(mine.opened_at, i18n.language) })}
            {' '}
            {t('cashierReminder.expected', { amount: money(mine.expected_total, i18n.language) })}
          </span>
          {!onCashierPage && <Link to={CASHIER_PATH} style={link}>{t('cashierReminder.closeIt')}</Link>}
        </div>
      )}
      {(othersOverdue.length > 0 || awaiting > 0) && (
        <div role="status" style={{ ...bar, ...warn }} data-testid="cashier-attention-bar">
          <span>
            {othersOverdue.length > 0 && t('cashierReminder.othersOverdue', {
              count: othersOverdue.length,
              hours: attention?.max_open_hours,
              names: othersOverdue.slice(0, 3).map((s) => s.agent_name || `#${s.agent_user_id}`).join(', '),
            })}
            {othersOverdue.length > 0 && awaiting > 0 && ' '}
            {awaiting > 0 && t('cashierReminder.awaitingReview', { count: awaiting })}
          </span>
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
