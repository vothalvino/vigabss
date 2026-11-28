// What a supervisor sets for every cashier of the company: how much cash a
// drawer may hold before it should be handed in, and whether a cashier over
// that amount is stopped from taking more cash or only reminded.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';
import { CASHIER_ATTENTION_KEY, CASHIER_STAFF_KEY, MY_CASHIER_KEY } from '@/components/cashierReminderData';

interface Rules { pickup_threshold: number; pickup_strict: boolean; match_tolerance: number; max_open_hours: number }
const KEY = ['cashier-rules'] as const;

export function CashierRulesBox({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await authedFetch('/api/v1/cash-reconciliation/rules');
      if (!res.ok) throw new Error('rules fetch failed');
      return ((await res.json()) as { data: Rules }).data;
    },
    retry: false,
  });
  const [threshold, setThreshold] = useState('');
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!rules.data) return;
    setThreshold(String(rules.data.pickup_threshold));
    setStrict(rules.data.pickup_strict);
  }, [rules.data]);

  if (!rules.data) return null;
  const off = Number(threshold) <= 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(threshold);
    if (!Number.isFinite(value) || value < 0) { setMsg({ ok: false, text: t('cashReconciliation.rules.invalid') }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await authedFetch('/api/v1/cash-reconciliation/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickup_threshold: value, pickup_strict: strict && value > 0 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message || t('cashReconciliation.rules.failed'));
      }
      setMsg({ ok: true, text: t('cashReconciliation.rules.saved') });
      await Promise.all([KEY, MY_CASHIER_KEY, CASHIER_ATTENTION_KEY, CASHIER_STAFF_KEY].map((queryKey) => qc.invalidateQueries({ queryKey })));
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t('cashReconciliation.rules.failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={box} aria-labelledby="cashier-rules-title">
      <h2 id="cashier-rules-title" style={{ margin: '0 0 4px', fontSize: '1rem' }}>{t('cashReconciliation.rules.title')}</h2>
      <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('cashReconciliation.rules.help')}</p>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.85rem', fontWeight: 600 }}>
          {t('cashReconciliation.rules.threshold')}
          <input type="number" min="0" step="0.01" inputMode="decimal" value={threshold} disabled={!canEdit}
            onChange={(e) => setThreshold(e.target.value)} style={field} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem' }}>
          <input type="checkbox" checked={strict && !off} disabled={!canEdit || off} onChange={(e) => setStrict(e.target.checked)} />
          {t('cashReconciliation.rules.strict')}
        </label>
        {canEdit && <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>}
      </div>
      <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
        {off ? t('cashReconciliation.rules.offHint') : strict ? t('cashReconciliation.rules.strictHint') : t('cashReconciliation.rules.remindHint')}
      </p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ margin: '8px 0 0', fontSize: '0.85rem', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </form>
  );
}

const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 16, background: 'var(--bg-card)' };
const field: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #d1d5db)', font: 'inherit', width: 160 };
