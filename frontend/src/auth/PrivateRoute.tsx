// =============================================================================
// VigaBSS 5.0 — PrivateRoute
// =============================================================================
// Wraps protected routes:
//   • Redirects unauthenticated users to /login
//   • Renders the not-allowed page when the user may not open the page
//   • Renders the not-in-region page for a page of another country's rules
//   • Sends an account bound to a reseller to the reseller app (/punto)
//   • Sends a cash-bag carrier to the route app (/ruta)
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
import { isCarrier } from './carrier';
import { hasRole } from './roles';

export { hasRole };

function NotAllowed({ reason = 'notAllowed' }: { reason?: 'notAllowed' | 'notInRegion' }) {
  const { t } = useTranslation();
  const title = reason === 'notInRegion' ? t('notInRegion.title') : t('notAllowed.title');
  const body = reason === 'notInRegion' ? t('notInRegion.body') : t('notAllowed.body');
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
      <h2>{title}</h2>
      <p>{body}</p>
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

  // An account bound to a reseller uses the reseller app only; the server
  // refuses the staff endpoints to it, so the console would show only errors.
  if (user.reseller_binding) {
    return <Navigate to="/punto" replace />;
  }

  // A carrier uses the route app only; the server fences it the same way.
  if (isCarrier(user)) {
    return <Navigate to="/ruta" replace />;
  }

  const route = routeForPath(location.pathname);
  // A page for one country's rules is not part of a company set up for
  // another: the menu leaves it out and the server refuses its data, so a
  // typed address gets a plain answer and not a page of errors. This holds
  // for an administrator too.
  if (route?.requiredLocale && user.organization_locale !== route.requiredLocale) {
    return <NotAllowed reason="notInRegion" />;
  }
  const byPermissions = user.role === 'admin' || !route ? null : permitsByPermissions(user, route);
  const allowed = byPermissions ?? (!requiredRole || hasRole(user.role, requiredRole));
  if (!allowed) return <NotAllowed />;

  return <Outlet />;
}
