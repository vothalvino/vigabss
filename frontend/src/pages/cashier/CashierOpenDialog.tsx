// Opening a cashier starts with counting the drawer. The cash stays in it
// between shifts, so the count is compared with what this person closed with.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';

interface Props { onClose: () => void; onOpened: () => void }

async function fetchOpening(): Promise<number | null> {
  const res = await authedFetch('/api/v1/cash-reconciliation/opening');
  if (!res.ok) return null;
  return ((await res.json()) as { data: { expected: number | null } }).data.expected;
}

export function CashierOpenDialog({ onClose, onOpened }: Props) {
  const { t, i18n } = useTranslation();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expected = useQuery({ queryKey: ['cashier-opening'], queryFn: fetchOpening, staleTime: 0, retry: false }).data;
  const title = t('cashReconciliation.openSession');
  const amount = Number(counted);
  const differs = counted !== '' && expected !== null && expected !== undefined && Math.round(amount * 100) !== Math.round(expected * 100);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (counted.trim() === '' || !Number.isFinite(amount) || amount < 0) { setError(t('cashReconciliation.opening.required')); return; }
    setBusy(true);
    setError('');
    try {
      const res = await authedFetch('/api/v1/cash-reconciliation/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opening_total: amount, ...(notes.trim() ? { notes: notes.trim() } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message || t('cashReconciliation.opening.failed'));
      }
      onOpened();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cashReconciliation.opening.failed'));
    } finally {
      setBusy(false);
    }
  }

  const money = (v: number) => v.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title}>
      <form style={box} onSubmit={submit}>
        <h3 style={{ margin: '0 0 6px' }}>{title}</h3>
        <p style={help}>{t('cashReconciliation.opening.help')}</p>
        <label htmlFor="cashier-opening-count" style={label}>{t('cashReconciliation.opening.counted')}</label>
        <input
          id="cashier-opening-count" style={input} type="number" min="0" step="0.01" inputMode="decimal"
          value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus
        />
        {expected !== null && expected !== undefined && (
          <p style={{ ...help, margin: '6px 0 0' }}>{t('cashReconciliation.opening.lastClose', { amount: money(expected) })}</p>
        )}
        {differs && (
          <p role="status" style={{ margin: '6px 0 0', color: 'var(--warning)', fontSize: '0.85rem', fontWeight: 600 }}>
            {t('cashReconciliation.opening.differs')}
          </p>
        )}
        <label htmlFor="cashier-opening-notes" style={{ ...label, marginTop: 12 }}>{t('cashReconciliation.notes')}</label>
        <input id="cashier-opening-notes" style={input} type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        {error && <p role="alert" style={{ margin: '8px 0 0', color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('common.saving') : title}</button>
        </div>
      </form>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
};
const box: React.CSSProperties = { background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #111827)', borderRadius: 10, padding: 20, maxWidth: 440, width: '100%' };
const help: React.CSSProperties = { margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.875rem' };
const label: React.CSSProperties = { display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, border: '1px solid var(--border, #d1d5db)', font: 'inherit' };
