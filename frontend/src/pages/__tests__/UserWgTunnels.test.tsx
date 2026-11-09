// =============================================================================
// VigaBSS 5.0 — UserWgTunnels page tests
// =============================================================================
// Covers the self-service WireGuard tunnel page, in particular:
//   - AddPeerModal: full_tunnel checkbox renders checked by default
//   - AddPeerModal: unchecking the checkbox POSTs full_tunnel=false
//   - AddPeerModal: leaving the checkbox checked POSTs full_tunnel=true
// Uses msw/vitest global fetch mock via vi.stubGlobal('fetch', ...) so no
// real HTTP requests are made.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserWgTunnels } from '../UserWgTunnels';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// tokenStore mock — returns a stable bearer token so authHeaders() fires
vi.mock('@/api/client', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() },
  tokenStore: {
    getAccess:  () => 'test-access-token',
    setAccess:  vi.fn(),
    getRefresh: () => null,
    setRefresh: vi.fn(),
    clear:      vi.fn(),
  },
  authedFetch: vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
}));

// react-i18next: return the key as the translation (avoids loading locale files)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_PEERS_RESPONSE = { data: [] };

const CREATED_PEER_RESPONSE = {
  data: {
    id: 42,
    name: 'Laptop',
    tunnel_address: '10.99.0.42',
    allowed_ips_snapshot: [],
    last_handshake_at: null,
    server_peer_synced: 0,
    revoked_at: null,
    created_at: new Date().toISOString(),
  },
  config: '[Interface]\nPrivateKey = K\n',
  config_base64: btoa('[Interface]\nPrivateKey = K\n'),
  qr_svg: '<svg><rect/></svg>',
};

function makeFetchMock(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    // GET /api/v1/wg-peers → empty peer list
    if (method === 'GET' && String(url).includes('/wg-peers')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.peers ?? EMPTY_PEERS_RESPONSE),
        text: () => Promise.resolve(''),
        status: 200,
      });
    }

    // POST /api/v1/wg-peers → created peer
    if (method === 'POST' && String(url).includes('/wg-peers')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...CREATED_PEER_RESPONSE, _requestBody: body }),
        text: () => Promise.resolve(''),
        status: 201,
      });
    }

    // Default fallback
    return Promise.resolve({
      ok: false,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      status: 404,
    });
  });
}

function renderPage(fetchMock = makeFetchMock()) {
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UserWgTunnels />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// =============================================================================
// AddPeerModal — full_tunnel checkbox
// =============================================================================

describe('AddPeerModal — full_tunnel checkbox', () => {
  it('Add Peer button opens the modal', async () => {
    const user = userEvent.setup();
    renderPage();

    // Wait for the list to load (empty state)
    await waitFor(() => expect(screen.queryByText('wgTunnels.loading')).not.toBeInTheDocument());

    const addButton = screen.getByRole('button', { name: /wgTunnels\.addPeer/i });
    await user.click(addButton);

    expect(screen.getByRole('heading', { name: 'wgTunnels.addPeer' })).toBeInTheDocument();
  });

  it('renders the full_tunnel checkbox checked by default', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.queryByText('wgTunnels.loading')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /wgTunnels\.addPeer/i }));

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.checked).toBe(true);
  });

  it('checkbox is labelled with wgTunnels.fullTunnelLabel', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.queryByText('wgTunnels.loading')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /wgTunnels\.addPeer/i }));

    // The label text is the i18n key (our t() mock returns the key)
    expect(screen.getByText('wgTunnels.fullTunnelLabel')).toBeInTheDocument();
  });

  it('POSTs full_tunnel=true when checkbox remains checked', async () => {
    const fetchMock = makeFetchMock();
    const user = userEvent.setup();
    renderPage(fetchMock);

    await waitFor(() => expect(screen.queryByText('wgTunnels.loading')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /wgTunnels\.addPeer/i }));

    // Type a peer name
    await user.type(screen.getByPlaceholderText('wgTunnels.modal.namePlaceholder'), 'Laptop');

    // Do NOT uncheck the checkbox — it defaults to true
    await user.click(screen.getByRole('button', { name: 'wgTunnels.modal.add' }));

    await waitFor(() => {
      const postCall = (fetchMock.mock.calls as unknown[][]).find(
        (args) => {
          const [url, init] = args as [string, RequestInit | undefined];
          return (init?.method ?? 'GET').toUpperCase() === 'POST' && String(url).includes('/wg-peers');
        },
      );
      expect(postCall).toBeDefined();
      const [, callInit] = postCall as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as Record<string, unknown>;
      expect(body.full_tunnel).toBe(true);
      expect(body.name).toBe('Laptop');
    });
  });

  it('POSTs full_tunnel=false when user unchecks the checkbox', async () => {
    const fetchMock = makeFetchMock();
    const user = userEvent.setup();
    renderPage(fetchMock);

    await waitFor(() => expect(screen.queryByText('wgTunnels.loading')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /wgTunnels\.addPeer/i }));

    await user.type(screen.getByPlaceholderText('wgTunnels.modal.namePlaceholder'), 'Phone');

    // Uncheck the full_tunnel checkbox
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByRole('button', { name: 'wgTunnels.modal.add' }));

    await waitFor(() => {
      const postCall = (fetchMock.mock.calls as unknown[][]).find(
        (args) => {
          const [url, init] = args as [string, RequestInit | undefined];
          return (init?.method ?? 'GET').toUpperCase() === 'POST' && String(url).includes('/wg-peers');
        },
      );
      expect(postCall).toBeDefined();
      const [, callInit] = postCall as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as Record<string, unknown>;
      expect(body.full_tunnel).toBe(false);
      expect(body.name).toBe('Phone');
    });
  });
});

// =============================================================================
// The hub cannot take a tunnel (off, or no key): say so, offer nothing to
// create, and show the server's reason when a QR is asked for. A config made
// while the hub was off had an empty PublicKey that phones reject.
// =============================================================================

describe('when the WireGuard hub is not ready', () => {
  const PEER = { ...CREATED_PEER_RESPONSE.data, server_peer_synced: 0 };
  const HUB_OFF = { ready: false, code: 'WIREGUARD_HUB_OFF', message: 'The WireGuard hub is turned off' };

  function hubOffFetch() {
    return vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/config')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: { code: 'WIREGUARD_HUB_OFF', message: 'The WireGuard hub is turned off for this installation' } }),
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [PEER], hub: HUB_OFF }), text: () => Promise.resolve('') });
    });
  }

  it('warns and disables Add Peer', async () => {
    renderPage(hubOffFetch());
    expect(await screen.findByText('wgTunnels.hubOff.title')).toBeInTheDocument();
    expect(screen.getByText('wgTunnels.hubOff.detail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'wgTunnels.addPeer' })).toBeDisabled();
  });

  it('shows the server reason instead of a broken QR', async () => {
    const user = userEvent.setup();
    renderPage(hubOffFetch());
    await screen.findByText('Laptop');
    await user.click(screen.getByRole('button', { name: 'wgTunnels.action.showQr' }));
    expect(await screen.findByText('The WireGuard hub is turned off for this installation')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a ready hub shows no warning', async () => {
    renderPage(makeFetchMock({ peers: { data: [], hub: { ready: true, code: null, message: null } } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'wgTunnels.addPeer' })).toBeEnabled());
    expect(screen.queryByText('wgTunnels.hubOff.title')).toBeNull();
  });
});
