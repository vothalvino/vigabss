// The subscriber sees the documents they signed, reads one, and downloads a copy.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const portalApiFetch = vi.fn();
const portalAuthedFetch = vi.fn();
vi.mock('@/api/portalApiFetch', () => ({ portalApiFetch: (...args: unknown[]) => portalApiFetch(...args) }));
vi.mock('@/auth/PortalAuthContext', () => ({ portalAuthedFetch: (...args: unknown[]) => portalAuthedFetch(...args) }));
vi.mock('@/components/MarkdownView', () => ({ default: ({ markdown }: { markdown: string }) => <div>{markdown}</div> }));

import { PortalDocuments } from '../PortalDocuments';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PortalDocuments /></QueryClientProvider>);
}

beforeEach(() => {
  portalApiFetch.mockReset().mockImplementation(async (path: string) => (
    path === '/documents'
      ? { data: [{ id: 7, title: 'Contrato de activación', signer_name: 'Ana López', signed_at: '2026-11-06T18:00:00Z' }] }
      : { data: { id: 7, title: 'Contrato de activación', rendered_body: 'Texto del contrato firmado', signer_name: 'Ana López', signed_at: '2026-11-06T18:00:00Z', signature_image: null, evidence_valid: true } }
  ));
  portalAuthedFetch.mockReset().mockResolvedValue(new Response(new Blob(['%PDF']), { status: 200 }));
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('PortalDocuments', () => {
  it('lists the subscriber’s signed documents', async () => {
    renderPage();
    expect(await screen.findByText('Contrato de activación')).toBeInTheDocument();
    expect(screen.getByText('Ana López')).toBeInTheDocument();
  });

  it('opens a document to read it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByText('Texto del contrato firmado')).toBeInTheDocument();
    expect(portalApiFetch).toHaveBeenCalledWith('/documents/7');
  });

  it('downloads the PDF copy', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(portalAuthedFetch).toHaveBeenCalledWith('/api/v1/portal/documents/7/pdf'));
  });

  it('says so when there are none', async () => {
    portalApiFetch.mockResolvedValueOnce({ data: [] });
    renderPage();
    expect(await screen.findByText('You have no signed documents yet.')).toBeInTheDocument();
  });
});
