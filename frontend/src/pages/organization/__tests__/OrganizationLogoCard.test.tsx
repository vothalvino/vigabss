import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganizationLogoCard } from '../OrganizationLogoCard';

const authedFetch = vi.fn();
vi.mock('@/api/client', () => ({ authedFetch: (...args: unknown[]) => authedFetch(...args) }));

function show(canEdit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><OrganizationLogoCard orgId={7} canEdit={canEdit} /></QueryClientProvider>);
}
const png = (size = 100) => new File([new Uint8Array(size)], 'logo.png', { type: 'image/png' });
const image = () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array(4)], { type: 'image/png' }) });
const none = () => ({ ok: false, status: 404 });

describe('OrganizationLogoCard', () => {
  beforeEach(() => authedFetch.mockReset());

  it('says there is no logo and offers to upload one', async () => {
    authedFetch.mockResolvedValue(none());
    show();
    expect(await screen.findByText('No logo yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload logo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('uploads the chosen image and shows it', async () => {
    authedFetch.mockResolvedValueOnce(none());
    show();
    await screen.findByText('No logo yet');
    authedFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: {} }) }).mockResolvedValue(image());
    fireEvent.change(screen.getByLabelText('Choose a logo image'), { target: { files: [png()] } });
    expect(await screen.findByText('Logo saved.')).toBeInTheDocument();
    const call = authedFetch.mock.calls.find(([url, init]) => url === '/api/v1/organizations/7/logo' && (init as RequestInit)?.method === 'POST');
    expect((call?.[1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(await screen.findByAltText('Current company logo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace logo' })).toBeInTheDocument();
  });

  it('refuses an image over the limit without sending it', async () => {
    authedFetch.mockResolvedValue(none());
    show();
    await screen.findByText('No logo yet');
    fireEvent.change(screen.getByLabelText('Choose a logo image'), { target: { files: [png(600 * 1024)] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('512 KB');
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s reason when it refuses the file', async () => {
    authedFetch.mockResolvedValueOnce(none());
    show();
    await screen.findByText('No logo yet');
    authedFetch.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: { message: 'The file is not a PNG, JPG or WebP image.' } }) });
    fireEvent.change(screen.getByLabelText('Choose a logo image'), { target: { files: [png()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a PNG, JPG or WebP');
  });

  it('removes the logo', async () => {
    authedFetch.mockResolvedValueOnce(image());
    show();
    await screen.findByAltText('Current company logo');
    authedFetch.mockResolvedValueOnce({ ok: true, status: 204 }).mockResolvedValue(none());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Logo removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No logo yet')).toBeInTheDocument());
  });

  it('shows no buttons to someone who may only look', async () => {
    authedFetch.mockResolvedValue(none());
    show(false);
    await screen.findByText('No logo yet');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
