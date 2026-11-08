// Reseller program phase 5b: the public signing page, the staff "send signing
// link" control, "Reportar falla" and the lead's signing card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import PublicSigning from '../PublicSigning';
import { SigningLinkActions } from '@/components/SigningLinkActions';
import { LeadSigning, ReportFault } from '../punto/PuntoSupport';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), user: null as unknown }));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/components/MarkdownView', () => ({ default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div> }));
vi.mock('@/components/SignatureCanvas', () => ({
  SignatureCanvas: ({ onChange }: { onChange: (v: string | null) => void }) => (
    <button type="button" onClick={() => onChange('data:image/png;base64,AAAA')}>draw</button>
  ),
}));

const wrap = (ui: ReactNode, path = '/') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllGlobals(); });

// =============================================================================
describe('PublicSigning', () => {
  const TOKEN = `1-${'a'.repeat(43)}`;
  const PAGE = {
    organization_name: 'ISP Ejemplo', customer_first_name: 'Ana', expires_at: '2026-11-11T00:00:00Z',
    documents: [
      { id: 101, template_type: 'installation_authorization', title: 'Installation authorization', status: 'pending', signed_at: null, mx_contract_environment: null, rendered_body: '# Authorization text', signable: true, waiting_for_visit: false, captures_communication_choices: false },
      { id: 102, template_type: 'activation_contract', title: 'Service contract', status: 'pending', signed_at: null, mx_contract_environment: null, rendered_body: '# Contract', signable: false, waiting_for_visit: true, captures_communication_choices: true },
    ],
    communication_contacts: { email: true, phone: false },
    privacy_notice: { version: 'v1', content: 'Notice', hash: 'h' },
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  function renderPage() {
    return wrap(<Routes><Route path="/firmar/:token" element={<PublicSigning />} /></Routes>, `/firmar/${TOKEN}`);
  }

  it('lists the documents; the contract waits for the visit', async () => {
    fetchMock = vi.fn(() => json(200, { data: PAGE }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Hello, Ana' })).toBeInTheDocument();
    const contract = screen.getByRole('region', { name: 'Service contract' });
    expect(within(contract).getByText('When the technician arrives')).toBeInTheDocument();
    expect(within(contract).queryByRole('button', { name: 'Read and sign' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/public/signing/${TOKEN}`, expect.objectContaining({ credentials: 'omit' }));
  });

  it('signs a document: full text, name, signature and acceptance', async () => {
    fetchMock = vi.fn((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? json(200, { data: { document: { id: 101, status: 'signed' }, remaining: 1 } })
      : json(200, { data: PAGE })));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    const auth = await screen.findByRole('region', { name: 'Installation authorization' });
    await user.click(within(auth).getByRole('button', { name: 'Read and sign' }));
    expect(await within(auth).findByTestId('markdown')).toHaveTextContent('# Authorization text');
    await user.click(within(auth).getByRole('button', { name: 'Sign' }));
    expect(within(auth).getByRole('alert')).toHaveTextContent('Write your full name.');
    await user.type(within(auth).getByLabelText('Your full name'), 'Ana Ruiz');
    await user.click(within(auth).getByRole('button', { name: 'draw' }));
    await user.click(within(auth).getByRole('button', { name: 'Sign' }));
    expect(within(auth).getByRole('alert')).toHaveTextContent('Confirm that you read the document');
    await user.click(within(auth).getByLabelText('I have read this document and I agree to sign it.'));
    await user.click(within(auth).getByRole('button', { name: 'Sign' }));
    await screen.findByText('"Installation authorization" is signed.');
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe(`/api/v1/public/signing/${TOKEN}/documents/101/sign`);
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      signer_name: 'Ana Ruiz', signature_image: 'data:image/png;base64,AAAA', accept: true,
    });
  });

  it('explains an expired link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(410, { error: { code: 'LINK_EXPIRED', message: 'expired' } })));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired');
  });
});

// =============================================================================
describe('SigningLinkActions (staff)', () => {
  it('copies a link and shows it once', async () => {
    mocks.apiFetch.mockResolvedValue({ data: { link: { id: 1, channel: 'copy', destination_masked: null, expires_at: 'x' }, url: 'https://isp.example.com/firmar/1-abc', message: null } });
    const user = userEvent.setup();
    wrap(<SigningLinkActions serviceOrderId={70} />);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByLabelText('Signing link')).toHaveValue('https://isp.example.com/firmar/1-abc');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/service-orders/70/signing-links', expect.objectContaining({ method: 'POST', body: JSON.stringify({ channel: 'copy' }) }));
  });

  it('reports where it was sent, or why not', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ data: { link: { id: 2, channel: 'sms', destination_masked: '*** *** 0001', expires_at: 'x' }, url: null, message: { queued: true, skipped: false, code: null } } });
    const user = userEvent.setup();
    wrap(<SigningLinkActions serviceOrderId={70} />);
    await user.click(screen.getByRole('button', { name: 'SMS' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Link sent to *** *** 0001.');
    mocks.apiFetch.mockRejectedValueOnce(new ApiRequestError('no email', 422, { error: { code: 'NO_EMAIL' } }));
    await user.click(screen.getByRole('button', { name: 'Email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The customer has no email on file.');
  });
});

// =============================================================================
describe('Reportar falla', () => {
  it('sends the report and lists it with its status', async () => {
    let tickets: unknown[] = [];
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/reseller-app/tickets' && init?.method === 'POST') {
        tickets = [{ id: 501, client_id: 31, client_name: 'Ana', subject: 'Sin internet', category: 'technical', status: 'open', created_at: '2026-11-08T16:00:00Z', updated_at: null, resolved_at: null }];
        return { data: tickets[0] };
      }
      if (path === '/reseller-app/tickets?client_id=31&limit=20') return { data: tickets, meta: { total: tickets.length, page: 1, limit: 20 } };
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    wrap(<ReportFault clientId={31} />);
    await user.click(await screen.findByRole('button', { name: 'Report a fault' }));
    await user.type(screen.getByLabelText('What happens'), 'Sin internet');
    await user.type(screen.getByLabelText('Details (since when, lights on the equipment…)'), 'Desde ayer sin señal');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Report sent.');
    expect(await screen.findByText('Sin internet')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    const post = mocks.apiFetch.mock.calls.find(([p, init]) => p === '/reseller-app/tickets' && init?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ client_id: 31, subject: 'Sin internet', description: 'Desde ayer sin señal' });
  });
});

// =============================================================================
describe('LeadSigning', () => {
  it('shows the state and asks the ISP to send the link', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/reseller-app/leads/5/signing') {
        return { data: { state: 'pending', pending_documents: 2, signed_documents: 0, can_send: true, contacts: { email: true, phone: false }, last_link: null } };
      }
      if (path === '/reseller-app/leads/5/signing-link' && init?.method === 'POST') {
        return { data: { link: { destination_masked: 'a***@example.com' }, message: { queued: true, skipped: false, code: null } } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    wrap(<LeadSigning leadId={5} />);
    expect(mocks.apiFetch).not.toHaveBeenCalled(); // loads only when opened
    await user.click(screen.getByRole('button', { name: 'Contract signature' }));
    expect(await screen.findByText('2 document(s) to sign, 0 signed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send by SMS' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send by email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The company sent the link to a***@example.com.'));
  });
});
