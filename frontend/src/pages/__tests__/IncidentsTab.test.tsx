// Network incidents for technicians: what is wrong, since when and in what
// pattern; closing needs a comment; customer messages may wait for approval.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IncidentsTab } from '../topology/IncidentsTab';

let permissions = ['devices.update'];
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, permissions } }) }));
vi.mock('@/auth/permissions', () => ({ can: (_u: unknown, p: string) => permissions.includes(p) }));
const apiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const incident = (extra = {}) => ({
  id: 7, device_name: 'PtP Cerro', device_type: 'ptp', site_name: 'Torre Norte', part: 'line', cause_code: 'capacity_live', worst_state: 'degraded', status: 'open',
  first_seen_at: '2026-03-06T19:00:00Z', last_seen_at: '2026-03-09T19:55:00Z', last_good_at: '2026-03-10T02:00:00Z',
  evidence: { reasons: [{ code: 'capacity_live', value: 93, limit: 85, mbps: 112, capacity_mbps: 120 }] },
  affected_contracts: 37, reopened_count: 0, closed_at: null, closed_by: null, closing_comment: null, customer_message: null, reports: 2, drafts: 0, ...extra,
});
const detail = (extra = {}) => ({
  ...incident(),
  pattern: { days_bad: 4, days_window: 7, bad_minutes: 240, recurring: true, continuous: false, peak: 93, kind: 'capacity', windows: [{ start: '2026-03-08T19:00:00Z', end: '2026-03-08T19:55:00Z' }, { start: '2026-03-09T19:00:00Z', end: '2026-03-09T19:55:00Z' }] },
  reports: [
    { id: 1, client_name: 'Ana López', contract_id: 9, channel: 'portal', reported_at: '2026-03-09T19:20:00Z', notice_status: 'none', notice_text: null },
    { id: 2, client_name: 'Luis Pérez', contract_id: 12, channel: 'whatsapp', reported_at: '2026-03-09T19:40:00Z', notice_status: 'none', notice_text: null },
  ],
  ...extra,
});

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><IncidentsTab /></QueryClientProvider>);
}
let list: unknown[];
let one: unknown;
let draft: { text: string; customer_text: string; translated: boolean };
beforeEach(() => {
  permissions = ['devices.update'];
  list = [incident()];
  one = detail();
  draft = { text: 'Reemplazamos un equipo que da servicio a su zona.', customer_text: 'Reemplazamos un equipo que da servicio a su zona.', translated: false };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method) return { data: {} };
    if (path.startsWith('/network-incidents?')) return { data: list };
    if (path.includes('/draft?')) return { data: draft };
    return { data: one };
  });
});

describe('Incidents', () => {
  it('lists what is wrong with the numbers, who is behind it and who reported it', async () => {
    show();
    const row = (await screen.findByText('PtP Cerro')).closest('li') as HTMLElement;
    expect(row.getAttribute('data-state')).toBe('degraded');
    expect(within(row).getByText('Degraded: traffic 112 Mbps is 93% of the 120 Mbps the radio can carry right now (limit 85%)')).toBeInTheDocument();
    expect(row).toHaveTextContent('37 contracts behind it');
    expect(row).toHaveTextContent('2 customers reported it');
    // Fine at night, and still open.
    expect(row).toHaveTextContent('fine right now');
    expect(apiFetch).toHaveBeenCalledWith('/network-incidents?status=open');
  });

  it('shows the pattern over days and what kind of problem it is', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('Comes back.')).toBeInTheDocument();
    expect(screen.getByText(/Bad on 4 of the last 7 days, 4.0 hours in total\./)).toBeInTheDocument();
    expect(screen.getByText(/A capacity problem/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'When it was bad' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Ana López')).toBeInTheDocument();
  });

  it('cannot be closed without saying what was done', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    const form = await screen.findByRole('form', { name: 'Close this incident' });
    const button = within(form).getByRole('button', { name: 'Close incident' });
    expect(button).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('What was done?'), { target: { value: 'ok' } });
    expect(button).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('What was done?'), { target: { value: 'cambie el radio, estaba saturado' } });
    fireEvent.click(button);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/close', { method: 'POST', body: JSON.stringify({ comment: 'cambie el radio, estaba saturado' }) }));
  });

  it('a draft message can be edited and sent, or not sent', async () => {
    list = [incident({ status: 'resolved', drafts: 1 })];
    one = detail({ status: 'resolved', closed_by: 'Marta Ruiz', closed_at: '2026-03-10T15:00:00Z', closing_comment: 'cambie el radio', customer_message: 'Reemplazamos un equipo que da servicio a su zona.', reports: [
      { id: 1, client_name: 'Ana López', contract_id: 9, channel: 'portal', reported_at: '2026-03-09T19:20:00Z', notice_status: 'draft', notice_text: 'Reemplazamos un equipo que da servicio a su zona.' },
      { id: 2, client_name: 'Luis Pérez', contract_id: 12, channel: 'whatsapp', reported_at: '2026-03-09T19:40:00Z', notice_status: 'sent', notice_text: 'Reemplazamos un equipo que da servicio a su zona.' },
    ] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Closed' }));
    expect(await screen.findByText('1 message waiting for approval')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const box = await screen.findByLabelText('Message for Ana López');
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.change(box, { target: { value: 'Reemplazamos un equipo de su zona. Gracias por su paciencia.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/send', { method: 'POST', body: JSON.stringify({ text: 'Reemplazamos un equipo de su zona. Gracias por su paciencia.' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Do not send' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/discard', { method: 'POST' }));
    // The one already sent has no box.
    expect(screen.queryByLabelText('Message for Luis Pérez')).toBeNull();
    expect(screen.getByText(/Closed by Marta Ruiz/)).toBeInTheDocument();
    expect(screen.getByText(/Technician's note: cambie el radio/)).toBeInTheDocument();
  });

  describe('a draft in another language', () => {
    const german = 'Wir haben ein Gerät ersetzt, das Ihre Gegend versorgt.';
    beforeEach(() => {
      list = [incident({ status: 'resolved', drafts: 1 })];
      one = detail({ status: 'resolved', reports: [{ id: 1, client_name: 'Ana López', contract_id: 9, channel: 'portal', reported_at: '2026-03-09T19:20:00Z', notice_status: 'draft', notice_text: german }] });
      draft = { text: 'We replaced a piece of equipment that serves your area.', customer_text: german, translated: true };
    });
    async function open() {
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Closed' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
      const box = await screen.findByLabelText('Message for Ana López');
      await waitFor(() => expect(box).toHaveValue('We replaced a piece of equipment that serves your area.'));
      return box;
    }

    it('is read in the reviewer\'s language, with what the customer will receive shown under it', async () => {
      await open();
      expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/draft?lang=en');
      expect(screen.getByText('The customer receives it in their own language:')).toBeInTheDocument();
      expect(screen.getByText(german)).toBeInTheDocument();
    });

    it('sent unchanged, the server is told the reviewer\'s language so the customer gets the original', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/send', {
        method: 'POST', body: JSON.stringify({ text: 'We replaced a piece of equipment that serves your area.', lang: 'en' }),
      }));
    });

    it('once edited it cannot be sent until the customer\'s version has been read, and exactly that is sent', async () => {
      const edited = 'We replaced a piece of equipment. Thank you for your patience.';
      const inGerman = 'Wir haben ein Gerät ersetzt. Vielen Dank für Ihre Geduld.';
      const base = apiFetch.getMockImplementation() as (path: string, init?: RequestInit) => Promise<unknown>;
      apiFetch.mockImplementation(async (path: string, init?: RequestInit) => (path.endsWith('/preview') ? { data: { customer_text: inGerman } } : base(path, init)));
      const box = await open();
      fireEvent.change(box, { target: { value: edited } });
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      expect(screen.queryByText(german)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'See what the customer gets' }));
      expect(await screen.findByText(inGerman)).toBeInTheDocument();
      expect(screen.getByText('With your changes, the customer receives:')).toBeInTheDocument();
      expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/preview', { method: 'POST', body: JSON.stringify({ text: edited }) });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/network-incidents/7/reports/1/send', { method: 'POST', body: JSON.stringify({ text: inGerman }) }));
    });

    it('editing again after a preview asks for a new one', async () => {
      const base = apiFetch.getMockImplementation() as (path: string, init?: RequestInit) => Promise<unknown>;
      apiFetch.mockImplementation(async (path: string, init?: RequestInit) => (path.endsWith('/preview') ? { data: { customer_text: 'Erste Fassung der Nachricht.' } } : base(path, init)));
      const box = await open();
      fireEvent.change(box, { target: { value: 'First version of the edited message.' } });
      fireEvent.click(screen.getByRole('button', { name: 'See what the customer gets' }));
      await screen.findByText('Erste Fassung der Nachricht.');
      fireEvent.change(box, { target: { value: 'Second version of the edited message.' } });
      expect(screen.queryByText('Erste Fassung der Nachricht.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      expect(screen.getByRole('button', { name: 'See what the customer gets' })).toBeInTheDocument();
    });
  });

  it('says that nobody will be written to when no customer reported it', async () => {
    one = detail({ reports: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText(/Nobody will be written to when it is closed/)).toBeInTheDocument();
  });

  it('without permission it can be read but not closed or sent', async () => {
    permissions = [];
    one = detail({ reports: [{ id: 1, client_name: 'Ana López', contract_id: 9, channel: 'portal', reported_at: '2026-03-09T19:20:00Z', notice_status: 'draft', notice_text: 'Borrador del mensaje.' }] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));
    await screen.findByText('Ana López');
    expect(screen.queryByRole('form', { name: 'Close this incident' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('an empty list says so', async () => {
    list = [];
    show();
    expect(await screen.findByText('No open incidents.')).toBeInTheDocument();
  });
});
