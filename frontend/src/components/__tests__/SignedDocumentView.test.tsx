// A signed document can be opened again: the text as signed, the signature,
// the evidence summary, and a PDF download.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
const authedFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/api/client', () => ({ authedFetch: (...args: unknown[]) => authedFetch(...args) }));
vi.mock('@/components/MarkdownView', () => ({ default: ({ markdown }: { markdown: string }) => <div>{markdown}</div> }));

import { SignedDocumentViewer, SignedDocumentsList } from '../SignedDocumentView';
import { ActivationDocumentRow } from '@/pages/contracts/ActivationSteps';

const SIGNED = {
  id: 7, title: 'Contrato de activación', rendered_body: 'Texto del contrato firmado',
  signer_name: 'Ana López', signed_at: '2026-11-06T18:00:00Z', signature_image: 'data:image/png;base64,AAAA',
  signed_ip: '203.0.113.9', mx_contract_environment: 'sandbox', evidence_valid: true,
};

beforeEach(() => {
  apiFetch.mockReset().mockResolvedValue({ data: SIGNED });
  authedFetch.mockReset().mockResolvedValue(new Response(new Blob(['%PDF']), { status: 200 }));
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe('SignedDocumentViewer', () => {
  it('shows the signed text, signature, signer and evidence status', async () => {
    render(<SignedDocumentViewer documentId={7} onClose={vi.fn()} />);
    expect(await screen.findByText('Texto del contrato firmado')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/signed-documents/7');
    expect(screen.getByRole('img', { name: 'Signature of Ana López' })).toHaveAttribute('src', SIGNED.signature_image);
    expect(screen.getByText('Ana López')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('Test (no legal effect)')).toBeInTheDocument();
    expect(screen.getByText(/Verified — the text and signature are unchanged/)).toBeInTheDocument();
  });

  it('downloads the PDF copy', async () => {
    render(<SignedDocumentViewer documentId={7} onClose={vi.fn()} />);
    await screen.findByText('Texto del contrato firmado');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/api/v1/signed-documents/7/pdf'));
  });
});

describe('ActivationDocumentRow', () => {
  it('offers View on a signed document and opens it', async () => {
    render(<ActivationDocumentRow document={{ id: 7, title: 'Contrato', status: 'signed', signer_name: 'Ana' }} canSign onSign={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('Texto del contrato firmado')).toBeInTheDocument();
  });

  it('does not offer View before the document is signed', () => {
    render(<ActivationDocumentRow document={{ id: 8, title: 'Contrato', status: 'pending' }} canSign onSign={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
  });
});

describe('SignedDocumentsList', () => {
  const LIST = [{ id: 7, title: 'Contrato de activación', status: 'signed', signer_name: 'Ana López', signed_at: '2026-11-06T18:00:00Z' }];

  it("lists a contract's signed documents, whatever the contract status, and opens and downloads one", async () => {
    apiFetch.mockImplementation((path: string) => Promise.resolve(path.startsWith('/signed-documents?') ? { data: LIST } : { data: SIGNED }));
    render(<SignedDocumentsList contractId="41" />);
    expect(await screen.findByText('Contrato de activación')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/signed-documents?contract_id=41&status=signed');
    expect(screen.getByText(/Signed by Ana López on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/api/v1/signed-documents/7/pdf'));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('Texto del contrato firmado')).toBeInTheDocument();
  });

  it("scopes to a customer's documents and says when there are none", async () => {
    apiFetch.mockResolvedValue({ data: [] });
    render(<SignedDocumentsList clientId={5} />);
    expect(await screen.findByText(/No signed documents yet/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/signed-documents?client_id=5&status=signed');
  });
});
