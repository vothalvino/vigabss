// =============================================================================
// SigningLinkActions — send the customer its remote signing link (migration 009)
// =============================================================================
// POST /service-orders/:id/signing-links with signed_documents.create: by
// email or SMS to the contact on file, or a copy to hand over. A new link
// replaces the order's earlier ones. The customer signs at /firmar/<token>;
// the activation contract still waits for the installation visit.
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch, ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { styles } from '@/pages/crudStyles';

type Channel = 'email' | 'sms' | 'copy';
interface LinkResult {
  link: { id: number; channel: Channel; destination_masked: string | null; expires_at: string };
  url: string | null;
  message: { queued: boolean; skipped: boolean; code: string | null } | null;
}

const REFUSALS: Record<string, string> = {
  NO_EMAIL: 'signingLink.errors.noEmail',
  NO_PHONE: 'signingLink.errors.noPhone',
  ORDER_NOT_SIGNABLE: 'signingLink.errors.notSignable',
  NO_PENDING_DOCUMENTS: 'signingLink.errors.nothingPending',
  MESSAGE_NOT_QUEUED: 'signingLink.errors.notQueued',
};

function codeOf(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  const body = (err.body ?? {}) as { error?: { code?: string } };
  return body.error?.code ?? null;
}

export function SigningLinkActions({ serviceOrderId }: { serviceOrderId: number }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const send = useMutation({
    mutationFn: (channel: Channel) => apiFetch<{ data: LinkResult }>(`/service-orders/${serviceOrderId}/signing-links`, {
      method: 'POST', body: JSON.stringify({ channel }),
    }).then((r) => r.data),
    onSuccess: (r: LinkResult) => { setResult(r); setError(''); setCopied(false); },
    onError: (err: unknown) => {
      setResult(null);
      const key = REFUSALS[codeOf(err) ?? ''];
      setError(key ? t(key) : t('signingLink.errors.generic'));
    },
  });

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  }

  const small = { ...styles.btnSecondary, padding: '3px 10px', fontSize: '0.78rem' };
  return (
    <div style={{ marginTop: 8, fontSize: '0.8rem' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-secondary)' }}>{t('signingLink.label')}</span>
        <button type="button" style={small} disabled={send.isPending} onClick={() => send.mutate('email')}>{t('signingLink.email')}</button>
        <button type="button" style={small} disabled={send.isPending} onClick={() => send.mutate('sms')}>{t('signingLink.sms')}</button>
        <button type="button" style={small} disabled={send.isPending} onClick={() => send.mutate('copy')}>{t('signingLink.copy')}</button>
      </div>
      {error && <p role="alert" style={{ color: 'var(--danger, #b91c1c)', margin: '6px 0 0' }}>{error}</p>}
      {result && result.url && (
        <div role="status" style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input readOnly value={result.url} aria-label={t('signingLink.urlLabel')} style={{ flex: 1, minWidth: 220, fontSize: '0.78rem', padding: 4 }} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" style={small} onClick={() => { void copy(result.url as string); }}>{copied ? t('signingLink.copied') : t('signingLink.copyButton')}</button>
          <span style={{ width: '100%', color: 'var(--text-secondary)' }}>{t('signingLink.copyHelp')}</span>
        </div>
      )}
      {result && !result.url && (
        <p role="status" style={{ margin: '6px 0 0', color: result.message?.skipped ? 'var(--warning, #b45309)' : 'var(--success, #047857)' }}>
          {result.message?.skipped
            ? t('signingLink.blocked', { code: result.message.code ?? '' })
            : t('signingLink.sent', { destination: result.link.destination_masked ?? '' })}
        </p>
      )}
    </div>
  );
}
