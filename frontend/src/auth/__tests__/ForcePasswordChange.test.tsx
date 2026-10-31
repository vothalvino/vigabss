// =============================================================================
// Forced password change at first login (migration 480)
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PrivateRoute } from '../PrivateRoute';

const mockAuthedFetch = vi.fn();
vi.mock('@/api/client', () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));
const mockLogout = vi.fn(async () => {});
let mockUser: Record<string, unknown> | null = null;
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false, initialized: true, logout: mockLogout }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}));

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      <Routes>
        <Route element={<PrivateRoute />}>
          <Route path="/clients" element={<p>Clients page</p>} />
        </Route>
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockAuthedFetch.mockReset();
  mockLogout.mockClear();
  mockUser = { id: 1, email: 'ops@isp.example', role: 'admin', must_change_password: 1 };
});

describe('ForcePasswordChange', () => {
  it('replaces the app until the password is changed', () => {
    renderApp();
    expect(screen.getByText('forcePasswordChange.title')).toBeInTheDocument();
    expect(screen.queryByText('Clients page')).toBeNull();
  });

  it('an account without the flag sees the app', () => {
    mockUser = { ...mockUser, must_change_password: 0 };
    renderApp();
    expect(screen.getByText('Clients page')).toBeInTheDocument();
  });

  it('checks the new password locally before sending it', () => {
    renderApp();
    fireEvent.change(screen.getByLabelText('forcePasswordChange.current'), { target: { value: 'printed-once' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.new'), { target: { value: 'a-new-password' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.confirm'), { target: { value: 'a-different-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'forcePasswordChange.submit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('forcePasswordChange.mismatch');
    expect(mockAuthedFetch).not.toHaveBeenCalled();
  });

  it('changes the password, signs out and returns to the login page', async () => {
    mockAuthedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    renderApp();
    fireEvent.change(screen.getByLabelText('forcePasswordChange.current'), { target: { value: 'printed-once' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.new'), { target: { value: 'a-new-password' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.confirm'), { target: { value: 'a-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'forcePasswordChange.submit' }));

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
    const [url, init] = mockAuthedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/change-password');
    expect(JSON.parse(String(init.body))).toEqual({ currentPassword: 'printed-once', newPassword: 'a-new-password' });
    expect(mockLogout).toHaveBeenCalled();
  });

  it('shows the server refusal (wrong current password)', async () => {
    mockAuthedFetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Current password is incorrect' } }), { status: 401 }));
    renderApp();
    fireEvent.change(screen.getByLabelText('forcePasswordChange.current'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.new'), { target: { value: 'a-new-password' } });
    fireEvent.change(screen.getByLabelText('forcePasswordChange.confirm'), { target: { value: 'a-new-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'forcePasswordChange.submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(mockLogout).not.toHaveBeenCalled();
  });
});
