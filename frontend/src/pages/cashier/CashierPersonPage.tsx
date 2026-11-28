// One person's cashier page, opened from their line on the Cashier page.
//
// Who sees what is decided by the server (GET /cash-reconciliation/staff/{userId}):
//   scope "full"        the company's admin: every cashier the person has had;
//   scope "supervisor"  a supervisor, or the person themself: the open
//                       cashier, and the counts that did not match and are
//                       not settled.
// Someone who may not see the person gets a 404, shown here as "not found".
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { unwrapData } from '@/api/envelope';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { CASHIER_ATTENTION_KEY, CASHIER_STAFF_KEY, MY_CASHIER_KEY } from '@/components/cashierReminderData';
import {
  CashierReasons, CashierSessionsTable, CashierStatusDot,
  type CashierPerson, type ReconciliationSession,
} from '@/pages/CashReconciliationList';
import { styles } from '../crudStyles';

interface PersonDetail {
  person: CashierPerson;
  scope: 'full' | 'supervisor';
  rules: { max_open_hours: number; pickup_threshold: number; pickup_strict: boolean };
  sessions: ReconciliationSession[];
}

const DATE_TIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px', marginBottom: 16,
};
const figure: React.CSSProperties = { fontSize: '1.6rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' };
const facts: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginTop: 12 };
const factLabel: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)' };

function Fact({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <div style={factLabel}>{label}</div>
      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: alert ? 'var(--danger)' : undefined }}>{value}</div>
    </div>
  );
}

export function CashierPersonPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { userId } = useParams<{ userId: string }>();
  const id = Number(userId);

  const { data, isLoading, isError } = useQuery({
    queryKey: [...CASHIER_STAFF_KEY, 'person', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: async () => {
      const res = await api.GET('/cash-reconciliation/staff/{userId}', { params: { path: { userId: id } } });
      if (res.error) throw new Error('Failed to load the cashier');
      return unwrapData<PersonDetail>(res.data);
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: CASHIER_STAFF_KEY });
    void qc.invalidateQueries({ queryKey: MY_CASHIER_KEY });
    void qc.invalidateQueries({ queryKey: CASHIER_ATTENTION_KEY });
  };

  const back = <Link to="/cash-reconciliation">‹ {t('cashReconciliation.title')}</Link>;

  if (isLoading) return <div style={styles.page}>{back}<p style={styles.msg}>{t('common.loading')}</p></div>;
  if (isError || !data) return <div style={styles.page}>{back}<p style={styles.msgError}>{t('cashierStaff.notFound')}</p></div>;

  const { person, scope, rules, sessions } = data;
  const now = person.current;

  return (
    <div style={styles.page}>
      {back}
      <div style={{ ...styles.header, marginTop: 8 }}>
        <CashierStatusDot status={person.status} />
        <h1 style={styles.pageTitle}>{person.name || `#${person.user_id}`}</h1>
      </div>

      <div style={card}>
        <div style={factLabel}>{person.open ? t('cashierStaff.inDrawerNow') : t('cashierStaff.inDrawerLastCount')}</div>
        <div style={figure} data-testid="cash-on-hand">{formatMoney(person.cash_on_hand)}</div>
        <div style={{ marginTop: 6 }}><CashierReasons person={person} /></div>

        {now ? (
          <div style={facts}>
            <Fact label={t('cashierStaff.facts.openedAt')} value={formatDate(now.opened_at, DATE_TIME)}
              alert={person.reasons.includes('open_too_long')} />
            <Fact label={t('cashierStaff.facts.opening')} value={formatMoney(now.opening_total)} />
            {now.opening_expected !== null && (
              <Fact label={t('cashierStaff.facts.lastClose')} value={formatMoney(now.opening_expected)}
                alert={person.reasons.includes('opening_difference')} />
            )}
            <Fact label={t('cashierStaff.facts.collected')} value={formatMoney(now.collected_total)} />
            <Fact label={t('cashierStaff.facts.pickedUp')} value={formatMoney(now.pickups_total)} />
            {now.pending_pickups > 0 && (
              <Fact label={t('cashierStaff.facts.pendingPickups')} value={formatMoney(now.pending_pickups_total)} />
            )}
            {rules.pickup_threshold > 0 && (
              <Fact label={t('cashierStaff.facts.limit')} value={formatMoney(rules.pickup_threshold)}
                alert={person.reasons.includes('over_limit')} />
            )}
          </div>
        ) : (
          <p style={{ margin: '10px 0 0', color: 'var(--text-muted)' }}>
            {t('cashierStaff.closedAt', { when: formatDate(person.last_closed_at, DATE_TIME) })}
          </p>
        )}
      </div>

      <h2 style={{ fontSize: '1rem', margin: '0 0 4px' }}>
        {scope === 'full' ? t('cashierStaff.history') : t('cashierStaff.toReview')}
      </h2>
      {scope === 'supervisor' && (
        <p style={{ margin: '0 0 8px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('cashierStaff.supervisorNote')}</p>
      )}
      <div style={styles.tableCard}>
        <CashierSessionsTable sessions={sessions} onChanged={refresh} />
      </div>
    </div>
  );
}
