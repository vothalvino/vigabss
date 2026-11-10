// =============================================================================
// ChangePasswordRoute — /change-password, for any signed-in account
// =============================================================================
// Staff, reseller, collector and carrier accounts all change their own
// password here, so this route sits outside PrivateRoute / PuntoRoute /
// RutaRoute (each of which sends the other kinds of account away). The server
// endpoint is self-service: it needs a session and the current password, no
// permission.
// =============================================================================

import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { ForcePasswordChange } from './ForcePasswordChange';

export function ChangePasswordRoute() {
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
  return <ForcePasswordChange voluntary={!user.must_change_password} />;
}
