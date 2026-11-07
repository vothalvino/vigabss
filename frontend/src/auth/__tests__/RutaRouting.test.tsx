// =============================================================================
// Carriers use /ruta; reseller-bound accounts use /punto; staff the console
// =============================================================================
// /auth/me says `carrier` for a cash-bag carrier. A carrier is sent from "/"
// (Dashboard), every staff route (PrivateRoute) and /punto (PuntoRoute) to
// the route app; RutaRoute sends a bound account to /punto and staff to "/".
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as AuthContextModule from '../AuthContext';
import type { AuthUser } from '../AuthContext';
import { PrivateRoute } from '../PrivateRoute';
import { PuntoRoute } from '../PuntoRoute';
import { RutaRoute } from '../RutaRoute';
import { isCarrier } from '../carrier';
import { Dashboard } from '@/pages/Dashboard';

vi.mock('@/pages/OperationsConsole', () => ({ OperationsConsole: () => <p>operations console</p> }));
vi.mock('@/pages/TechnicianDashboard', () => ({ TechnicianDashboard: () => <p>technician dashboard</p> }));

const staff: AuthUser = {
  id: 1, email: 'staff@example.com', name: 'Staff', role: 'admin', organization_id: 1,
  is_active: true, email_verified_at: null, twofa_enabled: false, reseller_binding: null, carrier: false,
};
const carrier: AuthUser = {
  ...staff, id: 3, email: 'ruta@example.com', role: 'readonly', carrier: true,
  permissions: ['carrier_app.use', 'carrier_app.pickup'],
};
const bound: AuthUser = {
  ...staff, id: 2, email: 'punto@example.com', role: 'billing',
  permissions: ['reseller_app.use'], reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' },
};

function mockAuth(user: AuthUser | null) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user, loading: false, initialized: true,
    login: vi.fn(), completeMfaLogin: vi.fn(), logout: vi.fn(), refresh: vi.fn(), switchOrganization: vi.fn(),
  } as ReturnType<typeof AuthContextModule.useAuth>);
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route element={<PuntoRoute />}>
          <Route path="/punto" element={<p>reseller app</p>} />
        </Route>
        <Route element={<RutaRoute />}>
          <Route path="/ruta" element={<p>carrier app</p>} />
        </Route>
        <Route element={<PrivateRoute />}>
          <Route index element={<Dashboard />} />
          <Route path="clients" element={<p>staff clients</p>} />
          <Route path="cash-bags" element={<p>staff cash bags</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('carrier routing', () => {
  it('a carrier landing on "/" after sign-in reaches the route app', () => {
    mockAuth(carrier);
    renderAt('/');
    expect(screen.getByText('carrier app')).toBeInTheDocument();
  });

  it('a carrier never sees a staff route, even the cash-bags page', () => {
    mockAuth(carrier);
    renderAt('/clients');
    expect(screen.getByText('carrier app')).toBeInTheDocument();
    renderAt('/cash-bags');
    expect(screen.queryByText('staff cash bags')).not.toBeInTheDocument();
  });

  it('a carrier never reaches the reseller app', () => {
    mockAuth(carrier);
    renderAt('/punto');
    expect(screen.getByText('carrier app')).toBeInTheDocument();
    expect(screen.queryByText('reseller app')).not.toBeInTheDocument();
  });

  it('a reseller-bound account never reaches the route app', () => {
    mockAuth(bound);
    renderAt('/ruta');
    expect(screen.getByText('reseller app')).toBeInTheDocument();
    expect(screen.queryByText('carrier app')).not.toBeInTheDocument();
  });

  it('org staff are sent from /ruta to the console', () => {
    mockAuth(staff);
    renderAt('/ruta');
    expect(screen.getByText('operations console')).toBeInTheDocument();
  });

  it('sends a signed-out visitor of /ruta to the sign-in page', () => {
    mockAuth(null);
    renderAt('/ruta');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
});

describe('isCarrier', () => {
  it('reads the flag, its object form, and the seeded group of an older response', () => {
    expect(isCarrier(carrier)).toBe(true);
    expect(isCarrier({ carrier: { user_id: 3, name: 'Ruta' } })).toBe(true);
    expect(isCarrier(staff)).toBe(false);
    expect(isCarrier(null)).toBe(false);
    expect(isCarrier({ group: { id: 9, name: 'carrier', kind: null, is_system: 1 } })).toBe(true);
    // A custom group that merely shares the name is not the system group.
    expect(isCarrier({ group: { id: 10, name: 'carrier', kind: null, is_system: 0 } })).toBe(false);
    // An explicit false wins over the group.
    expect(isCarrier({ carrier: false, group: { id: 9, name: 'carrier', kind: null, is_system: 1 } })).toBe(false);
  });
});
