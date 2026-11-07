// =============================================================================
// Carrier app (/ruta) — layout
// =============================================================================
// The shell of the app for cash-bag carriers. Like the reseller app it is
// separate from the staff Layout: no staff navigation and no request outside
// /auth and /carrier-app, which is all the server lets a carrier reach. It
// reuses the reseller app's mobile-first styles (punto.css): a bottom tab
// bar on narrow screens, a tab row under the header from 768px. Without
// carrier_app.use only a no-access notice is shown; Recoger and Entregar
// need carrier_app.pickup. The app never shows an amount.
// =============================================================================

import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { LoadingState } from '@/components/FetchStates';
import { fetchRutaMe, rutaKeys } from './rutaApi';
import '../punto/punto.css';

const ICONS = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  pickup: (
    <>
      <path d="M6 8h12l-1 12H7z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      <path d="M12 12v5M9.5 14.5L12 17l2.5-2.5" />
    </>
  ),
  dropoff: (
    <>
      <path d="M6 8h12l-1 12H7z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      <path d="M12 17v-5M9.5 14.5L12 12l2.5 2.5" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

function TabIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const TABS = [
  { to: '/ruta', end: true, icon: 'home', labelKey: 'ruta.nav.home', permission: null },
  { to: '/ruta/recoger', end: false, icon: 'pickup', labelKey: 'ruta.nav.pickup', permission: 'carrier_app.pickup' },
  { to: '/ruta/entregar', end: false, icon: 'dropoff', labelKey: 'ruta.nav.dropoff', permission: 'carrier_app.pickup' },
  { to: '/ruta/mis-bolsas', end: false, icon: 'route', labelKey: 'ruta.nav.bags', permission: null },
] as const;

function NoAccess() {
  const { t } = useTranslation();
  return (
    <section className="punto-card" role="alert" aria-labelledby="ruta-no-access">
      <h1 id="ruta-no-access" style={{ margin: '0 0 8px', fontSize: '1.1rem' }}>{t('ruta.access.title')}</h1>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('ruta.access.body')}</p>
    </section>
  );
}

export function RutaLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const canUse = can(user, 'carrier_app.use');
  const tabs = TABS.filter(tab => !tab.permission || can(user, tab.permission));
  const me = useQuery({ queryKey: rutaKeys.me, queryFn: fetchRutaMe, enabled: canUse });

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="punto-shell">
      <header className="punto-header">
        <div className="punto-header-row">
          <span className="punto-header-name">{me.data?.name || user?.name || t('ruta.layout.title')}</span>
          <button type="button" className="punto-btn-secondary punto-header-signout" onClick={() => { void signOut(); }}>
            {t('ruta.layout.signOut')}
          </button>
        </div>
        <div className="punto-header-row">
          <span className="punto-header-sub">{t('ruta.layout.subtitle')}</span>
          <LanguageSwitcher style={{ maxWidth: 120, fontSize: '0.78rem', padding: '2px 4px' }} />
        </div>
      </header>

      {canUse && (
        <nav className="punto-tabs punto-no-print" aria-label={t('ruta.layout.navLabel')}>
          {tabs.map(tab => (
            <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `punto-tab${isActive ? ' active' : ''}`}>
              <TabIcon name={tab.icon} />
              <span>{t(tab.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
      )}

      <main className="punto-main">
        {canUse ? (
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        ) : <NoAccess />}
      </main>
    </div>
  );
}
