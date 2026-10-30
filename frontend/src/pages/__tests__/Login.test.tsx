// =============================================================================
// VigaBSS 5.0 — Login page tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Login } from '../Login';
import * as AuthContextModule from '@/auth/AuthContext';
import type { LoginResult } from '@/auth/AuthContext';

// ---------------------------------------------------------------------------
// Mock navigation
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// Mock useAuth
// ---------------------------------------------------------------------------

type LoginFn = (email: string, password: string) => Promise<LoginResult>;
type CompleteFn = (mfaToken: string, code: string) => Promise<void>;

function mockAuth(login: LoginFn, completeMfaLogin: CompleteFn = vi.fn()) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user: null,
    loading: false,
    initialized: true,
    login,
    completeMfaLogin,
    logout: vi.fn(),
    refresh: vi.fn(),
    switchOrganization: vi.fn(),
  } as ReturnType<typeof AuthContextModule.useAuth>);
}

function renderLogin(path = '/login') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Login />
    </MemoryRouter>
  );
}

function submitPassword(email = 'admin@test.com', password = 'secret') {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Login page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the login form', () => {
    mockAuth(vi.fn());
    renderLogin();
    expect(screen.getByText('VigaBSS')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('v0.1.0-alpha.1')).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('calls login() and navigates on success', async () => {
    const loginFn = vi.fn<LoginFn>().mockResolvedValue({ status: 'authenticated' });
    mockAuth(loginFn);
    renderLogin();

    submitPassword('admin@test.com', 'secret');

    await waitFor(() => expect(loginFn).toHaveBeenCalledWith('admin@test.com', 'secret'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });

  it('shows error message on login failure', async () => {
    const loginFn = vi.fn<LoginFn>().mockRejectedValue(new Error('Invalid credentials'));
    mockAuth(loginFn);
    renderLogin();

    submitPassword('bad@test.com', 'wrong');

    await waitFor(() => expect(screen.getByText('Invalid credentials')).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // SEC-03: the page used to wait for an error message containing "totp" that
  // the server never sent. The real contract is a successful response carrying
  // a challenge; no session exists until the code is verified.
  it('asks for the two-factor code when the server returns a challenge, then completes the login', async () => {
    const loginFn = vi.fn<LoginFn>().mockResolvedValue({ status: 'mfa_required', mfaToken: 'challenge-1' });
    const completeFn = vi.fn<CompleteFn>().mockResolvedValue(undefined);
    mockAuth(loginFn, completeFn);
    renderLogin();

    submitPassword('totp@test.com', 'pass');

    await waitFor(() => expect(screen.getByLabelText(/two-factor/i)).toBeInTheDocument());
    expect(screen.getByText(/authenticator app/i)).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The password step is gone.
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/two-factor/i), { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => expect(completeFn).toHaveBeenCalledWith('challenge-1', '123456'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true }));
  });

  it('accepts a backup code and shows a server rejection of the code', async () => {
    const loginFn = vi.fn<LoginFn>().mockResolvedValue({ status: 'mfa_required', mfaToken: 'challenge-2' });
    const completeFn = vi.fn<CompleteFn>().mockRejectedValue(new Error('Invalid 2FA code'));
    mockAuth(loginFn, completeFn);
    renderLogin();

    submitPassword();
    await waitFor(() => expect(screen.getByLabelText(/two-factor/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/two-factor/i), { target: { value: 'ABCD-EF12' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => expect(screen.getByText('Invalid 2FA code')).toBeInTheDocument());
    expect(completeFn).toHaveBeenCalledWith('challenge-2', 'ABCD-EF12');
    expect(mockNavigate).not.toHaveBeenCalledWith('/', { replace: true });
  });

  it('can go back from the code step to the password step', async () => {
    const loginFn = vi.fn<LoginFn>().mockResolvedValue({ status: 'mfa_required', mfaToken: 'challenge-3' });
    mockAuth(loginFn);
    renderLogin();

    submitPassword();
    await waitFor(() => expect(screen.getByLabelText(/two-factor/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/two-factor/i)).not.toBeInTheDocument();
  });

  it('opens directly on the code step for an SSO challenge in the URL fragment', async () => {
    const completeFn = vi.fn<CompleteFn>().mockResolvedValue(undefined);
    mockAuth(vi.fn(), completeFn);
    renderLogin('/login#mfa_token=sso-challenge');

    expect(screen.getByLabelText(/two-factor/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/two-factor/i), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => expect(completeFn).toHaveBeenCalledWith('sso-challenge', '654321'));
  });
});
