// The cash supervisors took out of a cashier: the list inside an expanded
// row, with the supervisor's "record a pickup" and the owner's confirm.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';
import { CASHIER_ATTENTION_KEY, MY_CASHIER_KEY } from '@/components/cashierReminderData';

export interface CashPickup {
  id: number;
  amount: number;
  status: 'pending' | 'confirmed' | 'cancelled';
  taken_by: number;
  taken_by_name: string | null;
  confirmed_by: number | null;
  note: string | null;
  created_at: string;
}

interface Props {
  session: { id: number; agent_user_id: number; status: string; opening_total?: string | null; opening_expected?: string | null; pickups_total?: string | null };
  colSpan: number;
  userId: number | null;
  /** May record a pickup from this cashier: a supervisor, and not its owner unless the admin. */
  canTake: boolean;
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await authedFetch(`/api/v1/cash-reconciliation/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(json.error?.message || 'failed');
  }
}

export function CashierPickupsRow({ session, colSpan, userId, canTake }: Props) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [taking, setTaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = ['cash-session-pickups', session.id];
  const { data: pickups = [] } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const res = await authedFetch(`/api/v1/cash-reconciliation/sessions/${session.id}`);
      if (!res.ok) throw new Error('failed to load pickups');
      return ((await res.json()) as { data: { pickups?: CashPickup[] } }).data.pickups ?? [];
    },
  });
  const money = (v: number | string | null | undefined) => Number(v ?? 0).toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isOwner = userId !== null && Number(session.agent_user_id) === Number(userId);
  const open = session.status === 'open';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await Promise.all([
        qc.invalidateQueries({ queryKey: key }),
        qc.invalidateQueries({ queryKey: MY_CASHIER_KEY }),
        qc.invalidateQueries({ queryKey: CASHIER_ATTENTION_KEY }),
      ]);
    } catch (err) {
      setError(err instanceof Error && err.message !== 'failed' ? err.message : t('cashReconciliation.pickups.failed'));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setError(t('cashReconciliation.pickups.amountRequired')); return; }
    void run(async () => {
      await post(`sessions/${session.id}/pickups`, { amount: value, ...(note.trim() ? { note: note.trim() } : {}) });
      setAmount(''); setNote(''); setTaking(false);
    });
  }

  const opening = session.opening_total;
  const openedDifferent = opening != null && session.opening_expected != null
    && Math.round(Number(opening) * 100) !== Math.round(Number(session.opening_expected) * 100);

  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '8px 20px 4px', background: '#f8faff', fontSize: '0.82rem' }}>
        {opening != null && (
          <p style={{ margin: '0 0 6px' }}>
            <strong>{t('cashReconciliation.opening.shown')}</strong> {money(opening)}
            {openedDifferent && (
              <span style={{ color: '#991b1b', fontWeight: 600 }}> · {t('cashReconciliation.opening.shownDiffers', { amount: money(session.opening_expected) })}</span>
            )}
          </p>
        )}
        <p style={{ margin: '0 0 6px', fontWeight: 600, color: '#374151' }}>{t('cashReconciliation.pickups.title')}</p>
        {pickups.length === 0 && <p style={{ margin: '0 0 6px', color: '#9ca3af' }}>{t('cashReconciliation.pickups.none')}</p>}
        {pickups.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '0 0 6px', padding: 0 }}>
            {pickups.map((p) => (
              <li key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '3px 0' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{money(p.amount)}</span>
                <span style={{ color: '#6b7280' }}>{t('cashReconciliation.pickups.takenBy', { name: p.taken_by_name || `#${p.taken_by}` })}</span>
                <span style={{ color: p.status === 'pending' ? '#92400e' : p.status === 'confirmed' ? '#065f46' : '#6b7280', fontWeight: 600 }}>
                  {t(`cashReconciliation.pickups.status.${p.status}`)}
                </span>
                {p.note && <span style={{ color: '#6b7280' }}>“{p.note}”</span>}
                {p.status === 'pending' && isOwner && (
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => post(`pickups/${p.id}/confirm`))}>
                    {t('cashReconciliation.pickups.confirm')}
                  </button>
                )}
                {p.status === 'pending' && (isOwner || Number(p.taken_by) === Number(userId)) && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void run(() => post(`pickups/${p.id}/cancel`))}>
                    {isOwner ? t('cashReconciliation.pickups.reject') : t('common.cancel')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {open && canTake && !taking && (
          <button type="button" className="btn" onClick={() => setTaking(true)}>{t('cashReconciliation.pickups.record')}</button>
        )}
        {open && canTake && taking && (
          <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{t('cashReconciliation.pickups.amount')}</span>
              <input type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus style={field} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 180px' }}>
              <span style={{ fontWeight: 600 }}>{t('cashReconciliation.notes')}</span>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} style={field} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>{t('cashReconciliation.pickups.record')}</button>
            <button type="button" className="btn" onClick={() => { setTaking(false); setError(''); }}>{t('common.cancel')}</button>
          </form>
        )}
        {error && <p role="alert" style={{ margin: '6px 0 0', color: '#991b1b' }}>{error}</p>}
      </td>
    </tr>
  );
}

const field: React.CSSProperties = { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', font: 'inherit' };
