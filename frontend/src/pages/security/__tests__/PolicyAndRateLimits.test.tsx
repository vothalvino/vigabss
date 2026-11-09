// =============================================================================
// Password policy and API token rate limits can be edited (Security & Access
// Control). Both pages only displayed values before.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PasswordPolicySection } from '../PasswordPolicySection';
import { ApiRateLimitsSection } from '../ApiRateLimitsSection';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.mock('@/api/client', () => ({
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  api: { GET: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
let mockUser: { role?: string; permissions?: string[] } = { role: 'admin' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}
const wrap = (node: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
};
const calls = (method: string, suffix: string) => mockFetch.mock.calls.filter(([u, i]) => String(u).endsWith(suffix) && (i?.method ?? 'GET') === method);

const policy = {
  min_length: 8, require_uppercase: 0, require_lowercase: 0, require_digits: 0, require_special_chars: 0,
  max_repeated_chars: null, rotation_days: null, history_count: 0, lockout_attempts: 5, lockout_duration_minutes: 15, configured: false,
};

describe('PasswordPolicySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { role: 'admin' };
    mockFetch.mockImplementation((_u: string, init?: RequestInit) => Promise.resolve(json(
      init?.method === 'PUT' ? { data: { ...policy, ...JSON.parse(String(init.body)), configured: true } } : { data: policy },
    )));
  });

  it('saves every field, with 0 for the limits that are off', async () => {
    const user = userEvent.setup();
    wrap(<PasswordPolicySection />);
    const min = await screen.findByLabelText('Minimum length');
    expect(min).toHaveValue(8);
    await user.clear(min);
    await user.type(min, '12');
    await user.click(screen.getByLabelText('At least one number'));
    await user.clear(screen.getByLabelText('Wrong passwords before locking'));
    await user.type(screen.getByLabelText('Wrong passwords before locking'), '4');
    await user.click(screen.getByRole('button', { name: 'Save password policy' }));
    await waitFor(() => expect(calls('PUT', '/security-admin/password-policy')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT', '/security-admin/password-policy')[0][1].body))).toEqual({
      min_length: 12, max_repeated_chars: 0, history_count: 0, rotation_days: 0, lockout_attempts: 4, lockout_duration_minutes: 15,
      require_uppercase: false, require_lowercase: false, require_digits: true, require_special_chars: false,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('does not send a value out of range', async () => {
    const user = userEvent.setup();
    wrap(<PasswordPolicySection />);
    const min = await screen.findByLabelText('Minimum length');
    await user.clear(min);
    await user.type(min, '4');
    expect(min).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save password policy' })).toBeDisabled();
  });

  it('is read-only without password_policy.update', async () => {
    mockUser = { role: 'support', permissions: ['password_policy.view'] };
    wrap(<PasswordPolicySection />);
    expect(await screen.findByLabelText('Minimum length')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save password policy' })).toBeNull();
  });
});

describe('ApiRateLimitsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { role: 'admin' };
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PUT') return Promise.resolve(json({ success: true }));
      if (u.includes('/api-tokens')) return Promise.resolve(json({ data: [{ id: 7, name: 'Billing sync' }, { id: 9, name: 'Old', revoked_at: '2026-01-01' }] }));
      return Promise.resolve(json({ data: [{ id: 1, api_token_id: 7, requests_per_minute: 30, requests_per_hour: null, requests_per_day: null, burst_size: null, is_active: 1 }] }));
    });
  });

  it('lists limits with token names and the defaults for empty fields', async () => {
    wrap(<ApiRateLimitsSection />);
    expect(await screen.findByText('Billing sync (#7)')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('1000 (default)')).toBeInTheDocument();
  });

  it('edits a limit; an empty field is sent as null (the default)', async () => {
    const user = userEvent.setup();
    wrap(<ApiRateLimitsSection />);
    await screen.findByText('Billing sync (#7)');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const perHour = screen.getByLabelText('Per hour');
    await user.type(perHour, '500');
    await user.clear(screen.getByLabelText('Per minute'));
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(calls('PUT', '/security-admin/api-key-rate-limits/7')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT', '/security-admin/api-key-rate-limits/7')[0][1].body))).toEqual({
      is_active: true, burst_size: null, requests_per_minute: null, requests_per_hour: 500, requests_per_day: null,
    });
  });

  it('adds a limit for a token picked by name; revoked tokens are not offered', async () => {
    const user = userEvent.setup();
    wrap(<ApiRateLimitsSection />);
    await screen.findByText('Billing sync (#7)');
    await user.click(screen.getByRole('button', { name: 'Add a limit for a token' }));
    const picker = screen.getByRole('combobox');
    expect(screen.queryByRole('option', { name: 'Old (#9)' })).toBeNull();
    await user.selectOptions(picker, '7');
    await user.type(screen.getByLabelText('Burst (per second)'), '5');
    await user.click(screen.getByLabelText('Limit is on'));
    await user.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(calls('PUT', '/security-admin/api-key-rate-limits/7')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT', '/security-admin/api-key-rate-limits/7')[0][1].body))).toMatchObject({ is_active: false, burst_size: 5 });
  });

  it('shows no edit controls without api_key_rate_limits.update', async () => {
    mockUser = { role: 'support', permissions: ['api_key_rate_limits.view'] };
    wrap(<ApiRateLimitsSection />);
    await screen.findByText('30');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a limit for a token' })).toBeNull();
  });
});
