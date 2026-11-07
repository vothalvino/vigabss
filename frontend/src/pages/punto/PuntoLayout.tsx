// =============================================================================
// Reseller app (/punto) — layout
// =============================================================================
// The shell of the app for staff accounts bound to a reseller (a "Punto de
// Venta"). It is separate from the staff Layout on purpose: no staff
// navigation and no request to a staff endpoint, which the server refuses to
// a bound account. Mobile first: a bottom tab bar on narrow screens and a tab
// row under the header from 768px (punto.css). Tabs follow the account's
// permissions: without reseller_app.use only a no-access notice is shown,
// "Cobrar" needs reseller_app.collect and "Nuevo" reseller_app.signup.
// Prospectos is not a tab: Inicio and Clientes link to it. The header gives
// the reseller's name its own line; the language picker sits on the second
// line so a long name is not cut to a few letters at 360px.
// =============================================================================

import { Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { LoadingState } from '@/components/FetchStates';
import './punto.css';

const ICONS = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  clients: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
      <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.8 2.5 3 5.2" />
    </>
  ),
  add: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  collect: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </>
  ),
  cash: (
    <>
      <path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 8l2.5-4h13L21 8" />
      <path d="M10 12.5h4" />
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

// `permission` is what the tab's requests need beyond reseller_app.use.
const TABS = [
  { to: '/punto', end: true, icon: 'home', labelKey: 'punto.nav.home', permission: null },
  { to: '/punto/cobrar', end: false, icon: 'collect', labelKey: 'punto.nav.collect', permission: 'reseller_app.collect' },
  { to: '/punto/clientes', end: false, icon: 'clients', labelKey: 'punto.nav.clients', permission: null },
  { to: '/punto/nuevo', end: false, icon: 'add', labelKey: 'punto.nav.newClient', permission: 'reseller_app.signup' },
  { to: '/punto/caja', end: false, icon: 'cash', labelKey: 'punto.nav.cash', permission: null },
] as const;

/**
 * Shown instead of the app to a bound account whose group lacks
 * reseller_app.use: every /reseller-app request would answer 403, and the
 * server keeps it out of the staff console too.
 */
function NoAccess() {
  const { t } = useTranslation();
  return (
    <section className="punto-card" role="alert" aria-labelledby="punto-no-access">
      <h1 id="punto-no-access" style={{ margin: '0 0 8px', fontSize: '1.1rem' }}>{t('punto.access.title')}</h1>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('punto.access.body')}</p>
    </section>
  );
}

export function PuntoLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const canUse = can(user, 'reseller_app.use');
  const tabs = TABS.filter(tab => !tab.permission || can(user, tab.permission));

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="punto-shell">
      <header className="punto-header">
        <div className="punto-header-row">
          <span className="punto-header-name">{user?.reseller_binding?.reseller_name ?? t('punto.layout.title')}</span>
          <button type="button" className="punto-btn-secondary punto-header-signout" onClick={() => { void signOut(); }}>
            {t('punto.layout.signOut')}
          </button>
        </div>
        <div className="punto-header-row">
          <span className="punto-header-sub">{t('punto.layout.subtitle')}</span>
          <LanguageSwitcher style={{ maxWidth: 120, fontSize: '0.78rem', padding: '2px 4px' }} />
        </div>
      </header>

      {canUse && (
        <nav className="punto-tabs punto-no-print" aria-label={t('punto.layout.navLabel')}>
          {tabs.map(tab => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `punto-tab${isActive ? ' active' : ''}`}
            >
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
