// =============================================================================
// VigaBSS 5.0 — SecurityAccessControlPage tests (§17)
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SecurityAccessControlPage } from '../SecurityAccessControlPage';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/api/client', () => ({
  // Pages reach the API through authedFetch (FE-20); pass it to the stubbed fetch.
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  api: { GET: vi.fn() },
  tokenStore: {
    getAccess: () => 'test-token',
    setAccess: vi.fn(),
    getRefresh: () => null,
    setRefresh: vi.fn(),
    clear: vi.fn(),
  },
}));

let mockUser: { role?: string; permissions?: string[] } = { role: 'admin' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleCredential = {
  id: 1,
  credential_id: 'AABBCCDDEEFF11223344',
  friendly_name: 'YubiKey 5C',
  aaguid: null,
  created_at: '2025-01-10T00:00:00Z',
};

const samplePolicy = {
  min_length: 12,
  max_length: 128,
  require_uppercase: 1,
  require_lowercase: 1,
  require_digits: 1,
  require_symbols: 0,
  rotation_days: 90,
  lockout_attempts: 5,
  lockout_duration_minutes: 30,
};

const sampleIpEntry = {
  id: 1,
  cidr: '192.168.1.10',
  description: 'Dev office',
  is_active: 1,
  expires_at: null,
};

const sampleIpStatus = {
  enabled: true,
  source: 'database',
  configurationValid: true,
  activeEntries: 1,
  invalidEntries: 0,
  currentIp: '203.0.113.7',
  currentIpAllowed: true,
};

const sampleRateLimit = {
  id: 1,
  api_token_id: 42,
  requests_per_minute: 60,
  requests_per_hour: 1000,
  requests_per_day: null,
};

const sampleFirewallRule = {
  id: 1,
  name: 'Block external SSH',
  action: 'deny',
  protocol: 'tcp',
  direction: 'inbound',
  src_ip: null,
  dst_ip: '10.0.0.1',
  is_active: 1,
};

const sampleEncryptionKey = {
  id: 1,
  key_id: 'primary-aes-key',
  algorithm: 'AES-256-GCM',
  key_length_bits: 256,
  status: 'active',
  rotated_at: null,
  expires_at: null,
};

const sampleTlsConfig = {
  min_tls_version: 'TLSv1.2',
  recommended_tls_version: 'TLSv1.3',
  cipher_suites: ['TLS_AES_256_GCM_SHA384'],
  notes: 'VigaBSS enforces TLSv1.2+ for all API endpoints.',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  } as Response;
}

function setupMocks() {
  mockFetch.mockImplementation((url: string) => {
    const path = typeof url === 'string' ? url : '';
    if (path.endsWith('/security-admin/webauthn'))
      return Promise.resolve(makeJsonResponse({ data: [sampleCredential] }));
    if (path.endsWith('/security-admin/password-policy'))
      return Promise.resolve(makeJsonResponse({ data: samplePolicy }));
    if (path.endsWith('/security-admin/admin-ip-allowlist/status'))
      return Promise.resolve(makeJsonResponse({ data: sampleIpStatus }));
    if (path.endsWith('/security-admin/admin-ip-allowlist'))
      return Promise.resolve(makeJsonResponse({ data: [sampleIpEntry] }));
    if (path.endsWith('/security-admin/api-key-rate-limits'))
      return Promise.resolve(makeJsonResponse({ data: [sampleRateLimit] }));
    if (path.endsWith('/network-security/firewall-rules'))
      return Promise.resolve(makeJsonResponse({ data: [sampleFirewallRule] }));
    if (path.endsWith('/network-security/ddos-protection'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/network-security/blackhole-routes'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/network-security/dns-blocklists'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/network-security/cpe-security-scans'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/data-security/encryption-keys'))
      return Promise.resolve(makeJsonResponse({ data: [sampleEncryptionKey] }));
    if (path.endsWith('/data-security/data-masking'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/data-security/secure-deletion-log'))
      return Promise.resolve(makeJsonResponse({ data: [] }));
    if (path.endsWith('/data-security/tls-config'))
      return Promise.resolve(makeJsonResponse({ data: sampleTlsConfig }));
    return Promise.resolve(makeJsonResponse({ data: [] }));
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SecurityAccessControlPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecurityAccessControlPage (§17)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { role: 'admin' };
    setupMocks();
  });

  it('renders the page heading', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('has only the two tabs that apply settings', () => {
    renderPage();
    const tabs = ['User Security', 'API Security'];
    for (const name of tabs) expect(screen.getByRole('button', { name: new RegExp(name, 'i') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /network security/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /data security/i })).toBeNull();
  });

  it('shows User Security tab content on mount', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /password policy/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /webauthn/i })).toBeNull();
  });

  // Firewall, DDoS, blackhole, DNS, CPE scans, encryption keys, data masking,
  // WebAuthn, the TLS text and the deletion log were stored but never applied,
  // so the page no longer loads or shows them.
  it('never loads the sections nothing applies', async () => {
    renderPage();
    await screen.findByLabelText('Minimum length');
    await userEvent.click(screen.getByRole('button', { name: /api security/i }));
    await screen.findByText('60');
    const urls = mockFetch.mock.calls.map(([u]) => String(u));
    for (const dead of ['/network-security/', '/data-security/', '/security-admin/webauthn']) {
      expect(urls.filter(u => u.includes(dead))).toEqual([]);
    }
  });

  it('shows password policy min length after load', async () => {
    renderPage();
    expect(await screen.findByLabelText('Minimum length')).toHaveValue(12);
  });

  it('shows admin IP allowlist entry after load', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('192.168.1.10')).toBeInTheDocument(),
    );
  });

  it('stages a new entry inactive unless activation is explicitly selected', async () => {
    renderPage();
    const cidrInput = await screen.findByPlaceholderText('203.0.113.7');
    await userEvent.type(cidrInput, '203.0.113.7/32');
    await userEvent.click(screen.getByRole('button', { name: /add allowlist entry/i }));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(([, options]) => options?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
        cidr: '203.0.113.7/32',
        is_active: false,
      });
    });
  });

  it('switches to API Security tab and shows rate limits', async () => {
    renderPage();
    const tabs = screen.getAllByRole('button');
    const apiTab = tabs.find(b => /api/i.test(b.textContent ?? ''));
    expect(apiTab).toBeDefined();
    await userEvent.click(apiTab!);
    await waitFor(() =>
      expect(screen.getByText('60')).toBeInTheDocument(),
    );
  });

  it('handles no password policy gracefully', async () => {
    mockFetch.mockImplementation((url: string) => {
      const path = typeof url === 'string' ? url : '';
      if (path.endsWith('/security-admin/password-policy'))
        return Promise.resolve(makeJsonResponse({}, false));
      if (path.endsWith('/security-admin/webauthn'))
        return Promise.resolve(makeJsonResponse({ data: [] }));
      if (path.endsWith('/security-admin/admin-ip-allowlist/status'))
        return Promise.resolve(makeJsonResponse({ data: { ...sampleIpStatus, enabled: false, source: 'none', activeEntries: 0 } }));
      if (path.endsWith('/security-admin/admin-ip-allowlist'))
        return Promise.resolve(makeJsonResponse({ data: [] }));
      return Promise.resolve(makeJsonResponse({ data: [] }));
    });
    renderPage();
    await waitFor(() =>
      expect(screen.queryByText('12')).not.toBeInTheDocument(),
    );
  });
});
