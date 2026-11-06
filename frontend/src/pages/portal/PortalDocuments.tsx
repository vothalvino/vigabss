// =============================================================================
// Portal Documents: the subscriber's signed documents
// =============================================================================
// The activation contract (and any acknowledgment or installation
// authorization) the subscriber signed, with the exact text, their signature
// and a PDF copy to keep.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { portalApiFetch } from '@/api/portalApiFetch';
import { portalAuthedFetch } from '@/auth/PortalAuthContext';
import { SignedDocumentBody, saveResponseAs, type SignedDocumentData } from '@/components/SignedDocumentView';
import { portalPageStyles as styles } from './portalPageStyles';

interface DocumentSummary {
  id: number;
  title: string | null;
  signer_name: string | null;
  signed_at: string | null;
}

export function PortalDocuments() {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState('');

  const listQ = useQuery({
    queryKey: ['portal-documents'],
    queryFn: () => portalApiFetch<{ data: DocumentSummary[] }>('/documents'),
  });
  const documentQ = useQuery({
    queryKey: ['portal-document', openId],
    queryFn: () => portalApiFetch<{ data: SignedDocumentData }>(`/documents/${openId}`),
    enabled: openId !== null,
  });
  const documents = listQ.data?.data ?? [];

  async function download(id: number) {
    setDownloadError('');
    try {
      await saveResponseAs(await portalAuthedFetch(`/api/v1/portal/documents/${id}/pdf`), `document-${id}.pdf`);
    } catch {
      setDownloadError(t('portalDocuments.downloadError'));
    }
  }

  return (
    <div>
      <h1 style={styles.heading}>{t('portalDocuments.title')}</h1>
      <p style={styles.sub}>{t('portalDocuments.subtitle')}</p>
      {downloadError && <p role="alert" style={styles.error}>{downloadError}</p>}
      <section style={styles.card}>
        {listQ.isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
        {listQ.error && <p role="alert" style={styles.error}>{t('portalDocuments.loadError')}</p>}
        {!listQ.isLoading && !listQ.error && documents.length === 0 && <p style={styles.muted}>{t('portalDocuments.none')}</p>}
        {documents.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalDocuments.document')}</th>
                <th style={styles.th}>{t('portalDocuments.signedAt')}</th>
                <th style={styles.th}>{t('portalDocuments.signedBy')}</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.id}>
                  <td style={styles.td}>{d.title ?? `#${d.id}`}</td>
                  <td style={styles.td}>{d.signed_at ? new Date(d.signed_at).toLocaleDateString() : '—'}</td>
                  <td style={styles.td}>{d.signer_name ?? '—'}</td>
                  <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                    <button type="button" style={styles.pageBtn} onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                      {openId === d.id ? t('portalDocuments.hide') : t('portalDocuments.view')}
                    </button>{' '}
                    <button type="button" style={styles.pageBtn} onClick={() => void download(d.id)}>
                      {t('portalDocuments.downloadPdf')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {openId !== null && (
        <section style={{ ...styles.card, marginTop: '1rem' }} aria-label={documentQ.data?.data.title ?? t('portalDocuments.document')}>
          {documentQ.isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
          {documentQ.error && <p role="alert" style={styles.error}>{t('portalDocuments.loadError')}</p>}
          {documentQ.data && (
            <>
              <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>{documentQ.data.data.title}</h2>
              <SignedDocumentBody document={documentQ.data.data} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
