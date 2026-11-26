// A supervisor's decision on a count that did not match: approve it (the
// difference is explained) or dispute it (it is not). Either needs a note.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';

export type CashierDecision = 'approve' | 'dispute';

interface Props {
  sessionId: number;
  decision: CashierDecision;
  variance: string | null;
  onClose: () => void;
  onDone: () => void;
}

export function CashierReviewDialog({ sessionId, decision, variance, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = t(decision === 'approve' ? 'cashReconciliation.review.approveTitle' : 'cashReconciliation.review.disputeTitle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = note.trim();
    if (text.length < 3) { setError(t('cashReconciliation.review.noteRequired')); return; }
    setBusy(true);
    setError('');
    try {
      const res = await authedFetch(`/api/v1/cash-reconciliation/sessions/${sessionId}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message || t('cashReconciliation.review.failed'));
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cashReconciliation.review.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title}>
      <form style={box} onSubmit={submit}>
        <h3 style={{ margin: '0 0 6px' }}>{title}</h3>
        <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          {t(decision === 'approve' ? 'cashReconciliation.review.approveHelp' : 'cashReconciliation.review.disputeHelp', { variance: variance ?? '' })}
        </p>
        <label htmlFor={`cashier-review-note-${sessionId}`} style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>
          {t('cashReconciliation.review.note')}
        </label>
        <textarea
          id={`cashier-review-note-${sessionId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, border: '1px solid var(--border, #d1d5db)', font: 'inherit' }}
          autoFocus
        />
        {error && <p role="alert" style={{ margin: '8px 0 0', color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t('common.saving') : t(decision === 'approve' ? 'cashReconciliation.approve' : 'cashReconciliation.dispute')}
          </button>
        </div>
      </form>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
};
const box: React.CSSProperties = {
  background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #111827)', borderRadius: 10, padding: 20, maxWidth: 460, width: '100%',
};
