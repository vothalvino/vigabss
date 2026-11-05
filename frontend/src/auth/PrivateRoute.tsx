// =============================================================================
// VigaBSS 5.0 — PrivateRoute
// =============================================================================
// Wraps protected routes:
//   • Redirects unauthenticated users to /login
//   • Renders the not-allowed page when the user may not open the page
//   • Shows a full-page spinner while auth state is initialising
//
// A page in the nav registry opens when the session's resolved permissions
// include one of its viewPermissions, so custom groups and grants to built-in
// groups work (FE-25). The role tier (requiredRole) decides only for pages
// outside the registry or a session without resolved permissions.
// =============================================================================

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { permitsByPermissions, routeForPath } from '@/nav/routes';
import { useAuth } from './AuthContext';
import { ForcePasswordChange } from './ForcePasswordChange';
import { hasRole } from './roles';

export { hasRole };

function NotAllowed() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'sans-serif',
        gap: 8,
      }}
    >
      <h2>{t('notAllowed.title')}</h2>
      <p>{t('notAllowed.body')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PrivateRoute
// ---------------------------------------------------------------------------

interface PrivateRouteProps {
  /** Minimum role required to access this route. Omit for any authenticated user. */
  requiredRole?: string;
}

export function PrivateRoute({ requiredRole }: PrivateRouteProps) {
  const { t } = useTranslation();
  const { user, loading, initialized } = useAuth();
  const location = useLocation();

  // Show nothing (or a spinner) until auth is resolved on mount.
  if (loading || !initialized) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'sans-serif',
          color: '#555',
        }}
      >
        {t('ui.privateRoute.loading')}
      </div>
    );
  }

  // Not authenticated — send to login, preserving the intended destination.
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // The installer-created administrator must replace the printed password
  // before anything else; the server refuses every other request until then.
  if (user.must_change_password) {
    return <ForcePasswordChange />;
  }

  const route = routeForPath(location.pathname);
  const byPermissions = user.role === 'admin' || !route ? null : permitsByPermissions(user, route);
  const allowed = byPermissions ?? (!requiredRole || hasRole(user.role, requiredRole));
  if (!allowed) return <NotAllowed />;

  return <Outlet />;
}
