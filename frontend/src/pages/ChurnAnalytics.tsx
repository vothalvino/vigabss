// =============================================================================
// VigaBSS 5.0 — Churn Analytics & Predictive At-Risk Alerts — §1.2
// =============================================================================
// Read-only analytics dashboard backed by:
//   • GET /lifecycle/churn    — monthly churn rate from contract status changes
//   • GET /lifecycle/at-risk  — predictive churn alerts (risk score per client)
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { styles } from './crudStyles';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChurnMonth {
  month: string;
  new_contracts: number;
  churned: number;
  churn_rate_pct: number;
}

interface ChurnReport {
  generated_at: string;
  organization_id: number | null;
  months: ChurnMonth[];
}

interface AtRiskClient {
  client_id: number;
  name: string;
  email: string | null;
  suspended_contracts: number;
  overdue_invoices: number;
  max_days_overdue: number;
  risk_score: number;
}

interface AtRiskReport {
  generated_at: string;
  organization_id: number | null;
  clients: AtRiskClient[];
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchChurn(): Promise<ChurnReport> {
  const res = await api.GET('/lifecycle/churn', { params: { query: { months: 12 } } });
  if (res.error) throw new Error('Failed to load churn report');
  return (res.data as unknown as { data: ChurnReport }).data;
}

async function fetchAtRisk(): Promise<AtRiskReport> {
  const res = await api.GET('/lifecycle/at-risk', { params: { query: { limit: 50 } } });
  if (res.error) throw new Error('Failed to load at-risk clients');
  return (res.data as unknown as { data: AtRiskReport }).data;
}

// ---------------------------------------------------------------------------
// Risk badge
// ---------------------------------------------------------------------------

function RiskBadge({ score }: { score: number }) {
  let bg = '#dbeafe', color = '#1e40af', label = 'Low';
  if (score >= 70) { bg = '#fee2e2'; color = '#991b1b'; label = 'High'; }
  else if (score >= 40) { bg = '#fef3c7'; color = '#92400e'; label = 'Medium'; }
  return (
    <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600 }}>
      {score} · {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ChurnAnalytics component
// ---------------------------------------------------------------------------

export function ChurnAnalytics() {
  const { t } = useTranslation();
  const churnQ = useQuery({ queryKey: ['lifecycle-churn'], queryFn: fetchChurn });
  const atRiskQ = useQuery({ queryKey: ['lifecycle-at-risk'], queryFn: fetchAtRisk });

  const months = churnQ.data?.months ?? [];
  const atRisk = atRiskQ.data?.clients ?? [];
  const maxRate = months.reduce((m, r) => Math.max(m, r.churn_rate_pct), 0) || 1;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.churnAnalytics.churnAnalytics')}</h1>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 1.5rem' }}>
        {t('ui.churnAnalytics.monthlyChurnTrendFromContract')}
      </p>

      {/* ---- Monthly churn trend ---- */}
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.75rem' }}>{t('ui.churnAnalytics.monthlyChurnRateLast12')}</h2>
      <div style={styles.tableCard}>
        {churnQ.isLoading ? (
          <p style={styles.msg}>{t('ui.churnAnalytics.loading')}</p>
        ) : churnQ.error ? (
          <p style={styles.msgError}>{t('ui.churnAnalytics.failedToLoadChurnReport')}</p>
        ) : months.length === 0 ? (
          <p style={styles.msg}>{t('ui.churnAnalytics.noChurnDataAvailableYet')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('ui.churnAnalytics.month')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.newContracts')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.churned')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.churnRate')}</th>
                  <th style={styles.th}>{t('ui.churnAnalytics.trend')}</th>
                </tr>
              </thead>
              <tbody>
                {months.map(m => (
                  <tr key={m.month} style={styles.tr}>
                    <td style={{ ...styles.td, fontWeight: 500 }}>{m.month}</td>
                    <td style={styles.tdNum}>{m.new_contracts}</td>
                    <td style={styles.tdNum}>{m.churned}</td>
                    <td style={{ ...styles.tdNum, fontWeight: 600 }}>{m.churn_rate_pct}%</td>
                    <td style={styles.td}>
                      <div style={{ background: 'var(--border-subtle)', borderRadius: 4, height: 8, width: 160, overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.round((m.churn_rate_pct / maxRate) * 100)}%`,
                          height: '100%',
                          background: m.churn_rate_pct >= 10 ? 'var(--danger)' : 'var(--accent)',
                        }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- At-risk clients ---- */}
      <h2 style={{ fontSize: '1.05rem', margin: '1.75rem 0 0.75rem' }}>{t('ui.churnAnalytics.predictiveAtRiskClients')}</h2>
      <div style={styles.tableCard}>
        {atRiskQ.isLoading ? (
          <p style={styles.msg}>{t('ui.churnAnalytics.loading')}</p>
        ) : atRiskQ.error ? (
          <p style={styles.msgError}>{t('ui.churnAnalytics.failedToLoadAtRisk')}</p>
        ) : atRisk.length === 0 ? (
          <p style={styles.msg}>{t('ui.churnAnalytics.noAtRiskClientsDetected')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('ui.churnAnalytics.client')}</th>
                  <th style={styles.th}>{t('ui.churnAnalytics.name')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.suspended')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.overdueInvoices')}</th>
                  <th style={styles.thNum}>{t('ui.churnAnalytics.maxDaysOverdue')}</th>
                  <th style={styles.th}>{t('ui.churnAnalytics.risk')}</th>
                </tr>
              </thead>
              <tbody>
                {atRisk.map(c => (
                  <tr key={c.client_id} style={styles.tr}>
                    <td style={styles.td}>
                      <Link to={`/clients/${c.client_id}`} style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                        #{c.client_id}
                      </Link>
                    </td>
                    <td style={{ ...styles.td, fontWeight: 500 }}>{c.name}</td>
                    <td style={styles.tdNum}>{c.suspended_contracts}</td>
                    <td style={styles.tdNum}>{c.overdue_invoices}</td>
                    <td style={styles.tdNum}>{c.max_days_overdue}</td>
                    <td style={styles.td}><RiskBadge score={c.risk_score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
