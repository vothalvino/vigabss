// =============================================================================
// A signed legal document: the text exactly as signed, the signature, and the
// evidence summary, with a PDF download
// =============================================================================
// Once signed, the activation contract (or acknowledgment / installation
// authorization) used to show only "Signed by <name>". Staff open it here from
// the contract or work order; the portal reuses SignedDocumentBody for the
// subscriber's own copy.
// =============================================================================

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { authedFetch } from '@/api/client';
import { overlay, modalBox, cancelBtn, submitBtn } from '@/components/ClientFormModal';

const MarkdownView = lazy(() => import('@/components/MarkdownView'));

export interface SignedDocumentData {
  id: number;
  title: string | null;
  rendered_body: string;
  signer_name: string | null;
  signed_at: string | null;
  signature_image: string | null;
  signed_ip?: string | null;
  mx_contract_environment?: string | null;
  mx_registration_number?: string | null;
  mx_registered_at?: string | null;
  mx_template_version?: string | null;
  content_sha256?: string | null;
  evidence_valid?: boolean | null;
}

/** Save a downloaded response under a file name. */
export async function saveResponseAs(response: Response, filename: string): Promise<void> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: '0.84rem', margin: '2px 0', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--text-secondary)', minWidth: 150 }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

export function SignedDocumentBody({ document }: { document: SignedDocumentData }) {
  const { t } = useTranslation();
  const evidence = document.evidence_valid;
  return (
    <div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem', background: 'var(--bg-card)' }}>
        <Suspense fallback={<p>{t('signedDocument.loading')}</p>}>
          <MarkdownView markdown={document.rendered_body} />
        </Suspense>
      </div>
      <h3 style={{ margin: '1rem 0 0.4rem', fontSize: '0.95rem' }}>{t('signedDocument.signature')}</h3>
      {document.signature_image && (
        <img
          src={document.signature_image}
          alt={t('signedDocument.signatureAlt', { name: document.signer_name ?? '' })}
          style={{ maxWidth: 320, maxHeight: 120, background: '#fff', border: '1px solid var(--border)', borderRadius: 6 }}
        />
      )}
      <div style={{ marginTop: '0.5rem' }}>
        <Row label={t('signedDocument.signedBy')}>{document.signer_name ?? '—'}</Row>
        <Row label={t('signedDocument.signedAt')}>{document.signed_at ? new Date(document.signed_at).toLocaleString() : '—'}</Row>
        {document.signed_ip && <Row label={t('signedDocument.signedFrom')}>{document.signed_ip}</Row>}
        {document.mx_contract_environment && (
          <Row label={t('signedDocument.environment')}>
            {document.mx_contract_environment === 'sandbox' ? t('signedDocument.sandbox') : t('signedDocument.production')}
          </Row>
        )}
        {document.mx_registration_number && (
          <Row label={t('signedDocument.registration')}>
            {document.mx_registration_number}
            {document.mx_registered_at ? ` · ${String(document.mx_registered_at).slice(0, 10)}` : ''}
            {document.mx_template_version ? ` · v${document.mx_template_version}` : ''}
          </Row>
        )}
        <Row label={t('signedDocument.evidence')}>
          <span style={{ color: evidence === true ? '#166534' : evidence === false ? '#991b1b' : 'var(--text-secondary)', fontWeight: 600 }}>
            {evidence === true ? t('signedDocument.evidenceVerified') : evidence === false ? t('signedDocument.evidenceBroken') : t('signedDocument.evidenceUnavailable')}
          </span>
        </Row>
      </div>
    </div>
  );
}

/** Staff: open a signed document from the contract or work order. */
export function SignedDocumentViewer({ documentId, onClose }: { documentId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<SignedDocumentData | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<{ data: SignedDocumentData }>(`/signed-documents/${documentId}`)
      .then(res => { if (live) setDocument(res.data); })
      .catch(() => { if (live) setError(t('signedDocument.loadFailed')); });
    return () => { live = false; };
  }, [documentId, t]);

  async function download() {
    setDownloading(true);
    setError('');
    try {
      await saveResponseAs(
        await authedFetch(`/api/v1/signed-documents/${documentId}/pdf`),
        `document-${documentId}.pdf`,
      );
    } catch {
      setError(t('signedDocument.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={document?.title ?? t('signedDocument.title')} onClick={onClose}>
      <div style={{ ...modalBox, width: 760, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={event => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{document?.title ?? t('signedDocument.title')}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={submitBtn} disabled={!document || downloading} onClick={() => void download()}>
              {downloading ? t('signedDocument.downloading') : t('signedDocument.downloadPdf')}
            </button>
            <button type="button" style={cancelBtn} onClick={onClose}>{t('signedDocument.close')}</button>
          </div>
        </div>
        {error && <p role="alert" style={{ color: '#991b1b' }}>{error}</p>}
        {!document && !error && <p>{t('signedDocument.loading')}</p>}
        {document && <SignedDocumentBody document={document} />}
      </div>
    </div>
  );
}

interface SignedDocumentSummary {
  id: number;
  title: string | null;
  status: string;
  signer_name: string | null;
  signed_at: string | null;
}

/**
 * A contract's or a client's signed documents, at any contract status: the
 * activation card that lists them disappears once the contract is active.
 */
export function SignedDocumentsList({ contractId, clientId }: { contractId?: string | number; clientId?: number }) {
  const { t } = useTranslation();
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [documents, setDocuments] = useState<SignedDocumentSummary[] | null>(null);
  const scope = contractId !== undefined ? 'contract_id=' + contractId : 'client_id=' + clientId;
  const query = scope + '&status=signed';

  useEffect(() => {
    let live = true;
    apiFetch<{ data: SignedDocumentSummary[] }>(`/signed-documents?${query}`)
      .then(res => { if (live) setDocuments(res.data); })
      .catch(() => { if (live) setError(t('signedDocument.listFailed')); });
    return () => { live = false; };
  }, [query, t]);

  async function download(id: number) {
    setError('');
    try {
      await saveResponseAs(await authedFetch(`/api/v1/signed-documents/${id}/pdf`), `document-${id}.pdf`);
    } catch {
      setError(t('signedDocument.downloadFailed'));
    }
  }

  if (error) return <p role="alert" style={{ color: '#991b1b' }}>{error}</p>;
  if (!documents) return <p>{t('signedDocument.loading')}</p>;
  if (!documents.length) return <p style={{ color: 'var(--text-secondary)' }}>{t('signedDocument.none')}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {documents.map(d => (
        <div key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '0.55rem 0.7rem', borderRadius: 7, background: 'var(--bg-subtle)', fontSize: '0.84rem' }}>
          <span style={{ flex: 1, fontWeight: 600 }}>{d.title ?? `#${d.id}`}</span>
          <span style={{ color: '#166534' }}>
            {t('signedDocument.signedByOn', { name: d.signer_name ?? '', date: d.signed_at ? new Date(d.signed_at).toLocaleDateString() : '—' })}
          </span>
          <button type="button" style={cancelBtn} onClick={() => setViewingId(d.id)}>{t('signedDocument.view')}</button>
          <button type="button" style={submitBtn} onClick={() => void download(d.id)}>{t('signedDocument.downloadPdf')}</button>
        </div>
      ))}
      {viewingId !== null && <SignedDocumentViewer documentId={viewingId} onClose={() => setViewingId(null)} />}
    </div>
  );
}
