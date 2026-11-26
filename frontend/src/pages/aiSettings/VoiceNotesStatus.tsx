// =============================================================================
// VigaBSS 5.0 — "Voice notes: ready / not ready, and why"
// =============================================================================
// The WhatsApp bot answers "I couldn't listen to your voice message" whatever
// stops a transcription. This line, on the WhatsApp and Providers screens,
// says whether voice notes work for the organization and, if not, the one
// thing to change (GET /ai/voice-notes/status).
// =============================================================================

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';

interface VoiceStatus {
  ready: boolean;
  reason: 'not_connected' | 'assistant_off' | 'channel_off' | 'no_provider' | 'over_budget' | null;
  provider: { id: number; name: string; kind: string } | null;
  model: string | null;
}

/** `refreshKey`: change it to ask again (for example after the provider choice changed). */
export function VoiceNotesStatus({ refreshKey = '' }: { refreshKey?: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: VoiceStatus }>('/api/v1/ai/voice-notes/status')
      .then((res) => { if (!cancelled) setStatus(res?.data ?? null); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  // No answer (no permission, an older server): say nothing rather than guess.
  if (!status) return null;
  return (
    <p role="status" data-testid="voice-notes-status" style={{
      margin: 0, fontSize: '0.85rem', padding: '0.5rem 0.75rem', borderRadius: 6,
      border: `1px solid ${status.ready ? '#86efac' : '#fcd34d'}`,
      background: status.ready ? 'var(--success-soft)' : 'var(--warning-soft)',
      color: status.ready ? 'var(--success)' : 'var(--warning)',
    }}>
      <strong>{t('voiceNotes.label')}</strong>{' '}
      {status.ready
        ? t('voiceNotes.ready', { provider: status.provider?.name ?? '', model: status.model ?? '' })
        : t(`voiceNotes.reason.${status.reason ?? 'no_provider'}`)}
    </p>
  );
}
