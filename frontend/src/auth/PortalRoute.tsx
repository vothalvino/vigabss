// =============================================================================
// VigaBSS 5.0 — Portal Private Route Guard
// =============================================================================
// Redirects unauthenticated visitors to /portal/login.
// =============================================================================

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { usePortalAuth } from '@/auth/PortalAuthContext';
import { useTranslation } from 'react-i18next';

export function PortalRoute() {
  const { t } = useTranslation();
  const { client, loading, initialized } = usePortalAuth();
  const location = useLocation();

  if (loading || !initialized) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif', color: '#555' }}>
        {t('ui.portalRoute.loading')}
      </div>
    );
  }

  if (!client) {
    return <Navigate to="/portal/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
