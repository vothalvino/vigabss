// =============================================================================
// RutaRoute — guard for the carrier app (/ruta)
// =============================================================================
// The route app is for cash-bag carriers (the seeded "carrier" group). It:
//   • sends an unauthenticated visitor to /login, keeping the destination
//   • shows the forced password change first, like PrivateRoute
//   • sends a reseller-bound account to /punto and anyone else who is not a
//     carrier to the staff console ("/")
// The server enforces the same split: /carrier-app answers 403 to anyone who
// is not a carrier, and a carrier can reach only /auth and /carrier-app.
// =============================================================================

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { ForcePasswordChange } from './ForcePasswordChange';
import { isCarrier } from './carrier';

export function RutaRoute() {
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
  if (user.reseller_binding) return <Navigate to="/punto" replace />;
  if (!isCarrier(user)) return <Navigate to="/" replace />;
  return <Outlet />;
}
