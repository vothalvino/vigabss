// =============================================================================
// PuntoRoute — guard for the reseller app (/punto)
// =============================================================================
// The reseller app is for staff accounts bound to a reseller
// (reseller_user_bindings). It:
//   • sends an unauthenticated visitor to /login, keeping the destination
//   • shows the forced password change first, like PrivateRoute
//   • sends a carrier to its route app (/ruta) and any other account without
//     a binding back to the staff console ("/")
// The server enforces the same split: /reseller-app answers 403 to an
// unbound account, and a bound account can reach only the reseller app.
// =============================================================================

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { ForcePasswordChange } from './ForcePasswordChange';
import { isCarrier } from './carrier';

export function PuntoRoute() {
  const { t } = useTranslation();
  const { user, loading, initialized } = useAuth();
  const location = useLocation();

  if (loading || !initialized) {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-secondary)' }}>
        {t('ui.privateRoute.loading')}
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (user.must_change_password) return <ForcePasswordChange />;
  if (!user.reseller_binding) return <Navigate to={isCarrier(user) ? '/ruta' : '/'} replace />;
  return <Outlet />;
}
