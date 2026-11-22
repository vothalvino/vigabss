// The WhatsApp connection is managed from the app (AI Support → Settings →
// WhatsApp). Secrets are write-only: the screen shows whether each is set and
// sends only what the operator typed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockApiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return { apiFetch: (...args: unknown[]) => mockApiFetch(...args), ApiRequestError };
});

import { ApiRequestError } from '@/api/apiFetch';
import { WhatsAppSettingsTab } from '../WhatsAppSettingsTab';

const VIEW = {
  phone_number_id: '123456789012345',
  business_number: '+5215512345678',
  has_access_token: true,
  has_app_secret: false,
  has_verify_token: false,
  sources: { phone_number_id: 'settings', business_number: 'settings', access_token: 'environment', app_secret: null, verify_token: null },
  webhook_url: 'https://isp.example.com/api/v1/whatsapp/webhook',
  graph_version: 'v26.0',
  can_receive: false,
  can_send: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/whatsapp-settings' && (!init || !init.method)) return Promise.resolve({ data: VIEW });
    if (path === '/whatsapp-settings' && init?.method === 'PUT') {
      return Promise.resolve({ data: { ...VIEW, has_app_secret: true, has_verify_token: true, can_receive: true } });
    }
    if (path === '/whatsapp-settings/test') {
      return Promise.resolve({ data: { ok: true, display_phone_number: '+52 55 1234 5678', verified_name: 'Example ISP' } });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe('WhatsAppSettingsTab', () => {
  it('shows the webhook URL for Meta, the stored values and what is still missing', async () => {
    render(<WhatsAppSettingsTab />);
    expect(await screen.findByTestId('whatsapp-webhook-url')).toHaveTextContent('https://isp.example.com/api/v1/whatsapp/webhook');
    expect(screen.getByLabelText(/Phone number ID/)).toHaveValue('123456789012345');
    expect(screen.getByText('Can send replies')).toBeInTheDocument();
    expect(screen.getByText('Cannot receive yet')).toBeInTheDocument();
    expect(screen.getByText(/from the server environment/)).toBeInTheDocument();
  });

  it('never shows a secret: the secret fields start empty', async () => {
    render(<WhatsAppSettingsTab />);
    expect(await screen.findByLabelText(/Access token/)).toHaveValue('');
    expect(screen.getByLabelText(/App secret/)).toHaveValue('');
    expect(screen.getByLabelText(/Verify token/)).toHaveValue('');
  });

  it('saves only what was changed, leaving blank secrets untouched', async () => {
    const user = userEvent.setup();
    render(<WhatsAppSettingsTab />);
    await user.type(await screen.findByLabelText(/App secret/), 'app-secret-value-1234');
    await user.type(screen.getByLabelText(/Verify token/), 'my-verify-token');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument());
    const put = mockApiFetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({ app_secret: 'app-secret-value-1234', verify_token: 'my-verify-token' });
    // The typed secrets are cleared from the form once saved.
    expect(screen.getByLabelText(/App secret/)).toHaveValue('');
    expect(screen.getByText('Can receive messages')).toBeInTheDocument();
  });

  it('Test connection reports the number Meta answers with', async () => {
    const user = userEvent.setup();
    render(<WhatsAppSettingsTab />);
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected: Example ISP (+52 55 1234 5678).')).toBeInTheDocument();
  });

  it('shows the server\'s reason when saving fails', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) => (init?.method === 'PUT'
      ? Promise.reject(new Error('phone_number_id must be the numeric phone number ID from Meta'))
      : Promise.resolve({ data: VIEW })));
    render(<WhatsAppSettingsTab />);
    const id = await screen.findByLabelText(/Phone number ID/);
    await user.clear(id);
    await user.type(id, 'abc');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/numeric phone number ID/);
  });

  it('tells anyone but the install operator that the tab is not theirs', async () => {
    mockApiFetch.mockRejectedValue(new ApiRequestError('forbidden', 403));
    render(<WhatsAppSettingsTab />);
    expect(await screen.findByText(/Only the install operator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('warns when replies are failing, with what to do about a rejected token', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/whatsapp-settings') {
        return Promise.resolve({ data: { ...VIEW, send_failure: {
          message: 'Authentication Error', auth: true, since: '2026-11-22T05:17:35.000Z', last: '2026-11-22T05:20:00.000Z', count: 3,
        } } });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<WhatsAppSettingsTab />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('WhatsApp replies are not being delivered.');
    expect(alert).toHaveTextContent(/3 failed since .*Authentication Error/);
    expect(alert).toHaveTextContent(/access token was rejected/);
  });

  it('shows no warning while replies go out', async () => {
    render(<WhatsAppSettingsTab />);
    await screen.findByTestId('whatsapp-webhook-url');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
