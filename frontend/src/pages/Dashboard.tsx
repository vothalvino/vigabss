// =============================================================================
// VigaBSS 5.0 — Dashboard (role router)
// =============================================================================
// Technicians get the field/NOC dashboard built from endpoints their role can
// load; everyone else lands on the Operations Console — the dense operations
// overview (KPIs, throughput, live events, sites, devices). The former
// AdminDashboard was replaced by OperationsConsole (kept in git history).
//
// A user who can load none of the console's data (a reseller user, a custom
// group without operations access) used to land on it anyway: every request
// answered 403 and the tiles read "MRR $0", "Devices online 0/0". They go to
// the first page they can open instead, Resellers first. An account bound to
// a reseller goes to the reseller app (/punto).
// =============================================================================

import { Navigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { isCarrier } from '@/auth/carrier';
import { ROUTES, canSee, type NavUser } from '@/nav/routes';
import { TechnicianDashboard } from '@/pages/TechnicianDashboard';
import { OperationsConsole } from '@/pages/OperationsConsole';

// The permissions behind the console's requests (GET /dashboard/*, the live
// events feed) and its ticket action.
const OPERATIONS_PERMISSIONS = ['audit_logs.view', 'invoices.view', 'devices.view', 'connection_logs.view', 'tickets.view'];

/** Where a user without operations access lands, or null to show the console. */
export function landingWithoutOperations(user: NavUser): string | null {
  if (user.role === 'admin' || !Array.isArray(user.permissions)) return null;
  if (OPERATIONS_PERMISSIONS.some((p) => user.permissions!.includes(p))) return null;
  const reachable = ROUTES.filter((r) => r.path !== '/' && canSee(user, r));
  return (reachable.find((r) => r.path === '/resellers') ?? reachable[0])?.path ?? null;
}

export function Dashboard() {
  const { user } = useAuth();
  // A reseller-bound account has its own app (PrivateRoute redirects too).
  if (user?.reseller_binding) return <Navigate to="/punto" replace />;
  if (isCarrier(user)) return <Navigate to="/ruta" replace />;
  if (user?.role === 'technician') return <TechnicianDashboard />;
  const landing = user ? landingWithoutOperations(user) : null;
  if (landing) return <Navigate to={landing} replace />;
  return <OperationsConsole />;
}
