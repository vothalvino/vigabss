// =============================================================================
// Reseller-bound accounts use /punto; everyone else uses the staff console
// =============================================================================
// /auth/me carries reseller_binding for the active org. A bound account is
// sent from "/" (Dashboard) and from every staff route (PrivateRoute) to the
// reseller app; PuntoRoute sends an unbound account back to the console.
// =============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as AuthContextModule from '../AuthContext';
import type { AuthUser } from '../AuthContext';
import { PrivateRoute } from '../PrivateRoute';
import { PuntoRoute } from '../PuntoRoute';
import { Dashboard } from '@/pages/Dashboard';

vi.mock('@/pages/OperationsConsole', () => ({ OperationsConsole: () => <p>operations console</p> }));
vi.mock('@/pages/TechnicianDashboard', () => ({ TechnicianDashboard: () => <p>technician dashboard</p> }));

const staff: AuthUser = {
  id: 1, email: 'staff@example.com', name: 'Staff', role: 'admin', organization_id: 1,
  is_active: true, email_verified_at: null, twofa_enabled: false, reseller_binding: null,
};
const bound: AuthUser = {
  ...staff, id: 2, email: 'punto@example.com', role: 'billing',
  permissions: ['reseller_app.use', 'reseller_app.signup', 'reseller_portal.dashboard'],
  reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' },
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
        <Route element={<PrivateRoute />}>
          <Route index element={<Dashboard />} />
          <Route path="clients" element={<p>staff clients</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('reseller-bound routing', () => {
  it('Dashboard sends a bound account to /punto', () => {
    mockAuth(bound);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/punto" element={<p>reseller app</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('reseller app')).toBeInTheDocument();
  });

  it('a bound account landing on "/" after sign-in reaches the reseller app', () => {
    mockAuth(bound);
    renderAt('/');
    expect(screen.getByText('reseller app')).toBeInTheDocument();
  });

  it('a bound account never sees a staff route', () => {
    mockAuth(bound);
    renderAt('/clients');
    expect(screen.getByText('reseller app')).toBeInTheDocument();
    expect(screen.queryByText('staff clients')).not.toBeInTheDocument();
  });

  it('org staff keep the console and are sent away from /punto', () => {
    mockAuth(staff);
    renderAt('/');
    expect(screen.getByText('operations console')).toBeInTheDocument();
    renderAt('/punto');
    expect(screen.queryByText('reseller app')).not.toBeInTheDocument();
  });

  it('an older /auth/me without reseller_binding is treated as unbound', () => {
    const { reseller_binding: _omit, ...legacy } = staff;
    void _omit;
    mockAuth(legacy as AuthUser);
    renderAt('/clients');
    expect(screen.getByText('staff clients')).toBeInTheDocument();
  });

  it('sends a signed-out visitor of /punto to the sign-in page', () => {
    mockAuth(null);
    renderAt('/punto');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
});
