// =============================================================================
// Reseller app (/punto) — Inicio
// =============================================================================
// The reseller's numbers from GET /reseller-app/me and the main action, a new
// sign-up. Collecting cash and the daily cut come in a later phase and are
// not shown yet.
// =============================================================================

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { fetchPuntoMe, puntoKeys } from './puntoApi';
import { mutedText, pageTitle } from './puntoUi';

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
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={pageTitle}>{t('punto.home.title')}</h1>
        {me.data && <p style={mutedText}>{t('punto.home.greeting', { name: me.data.reseller.name })}</p>}
      </div>

      {canSignup && <Link to="/punto/nuevo" className="punto-btn-primary">{t('punto.home.newClient')}</Link>}

      {me.isLoading && <LoadingState />}
      {me.isError && <ErrorState message={t('punto.home.loadError')} onRetry={() => { void me.refetch(); }} />}
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
