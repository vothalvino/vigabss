// One person's cash limit, on their cashier page: how much cash their drawer
// may hold before it should be handed in, and whether going over it stops
// them from taking more cash or only reminds them. A supervisor sets it per
// person; a person with no limit of their own follows the organization's.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';
import { formatMoney } from '@/lib/money';

export interface PersonLimitRules {
  pickup_threshold: number;
  pickup_strict: boolean;
  default_pickup_threshold?: number;
  default_pickup_strict?: boolean;
}

const input: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-body)',
  color: 'var(--text-primary)', fontSize: '0.9rem', width: 140,
};
const button: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.85rem',
};

export function CashierLimitBox({ userId, name, rules, own, onSaved }: {
  userId: number;
  name: string;
  rules: PersonLimitRules;
  /** The limit shown was set for this person, not taken from the organization. */
  own: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(String(rules.pickup_threshold));
  const [strict, setStrict] = useState(rules.pickup_strict);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    setThreshold(String(rules.pickup_threshold));
    setStrict(rules.pickup_strict);
  }, [rules.pickup_threshold, rules.pickup_strict]);
  const off = Number(threshold) <= 0;

  async function send(request: Promise<Response>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await request;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message || t('cashierLimit.failed'));
      }
      setMsg({ ok: true, text: done });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t('cashierLimit.failed') });
    } finally {
      setBusy(false);
    }
  }
  function save(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(threshold);
    if (threshold.trim() === '' || !Number.isFinite(value) || value < 0) { setMsg({ ok: false, text: t('cashierLimit.invalid') }); return; }
    void send(authedFetch(`/api/v1/cash-reconciliation/staff/${userId}/limit`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickup_threshold: value, pickup_strict: strict && value > 0 }),
    }), t('cashierLimit.saved'));
  }
  function useDefault() {
    void send(authedFetch(`/api/v1/cash-reconciliation/staff/${userId}/limit`, { method: 'DELETE' }), t('cashierLimit.reset'));
  }

  return (
    <section
      aria-label={t('cashierLimit.title', { name })}
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px', marginBottom: 16 }}
    >
      <h2 style={{ fontSize: '1rem', margin: '0 0 4px' }}>{t('cashierLimit.title', { name })}</h2>
      <p style={{ margin: '0 0 10px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
        {own
          ? t('cashierLimit.ownNote')
          : t('cashierLimit.defaultNote', {
            amount: (rules.default_pickup_threshold ?? 0) > 0 ? formatMoney(rules.default_pickup_threshold) : t('cashierLimit.none'),
          })}
      </p>
      <form onSubmit={save} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.9rem' }}>
          {t('cashierLimit.amount')}
          <input style={input} type="number" min="0" step="0.01" inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.9rem', opacity: off ? 0.6 : 1 }}>
          <input type="checkbox" checked={strict && !off} disabled={off} onChange={e => setStrict(e.target.checked)} />
          {t('cashierLimit.strict')}
        </label>
        <button type="submit" style={button} disabled={busy}>{t('cashierLimit.save')}</button>
        {own && <button type="button" style={button} disabled={busy} onClick={useDefault}>{t('cashierLimit.useDefault')}</button>}
      </form>
      <p style={{ margin: '8px 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{off ? t('cashierLimit.offHint') : t('cashierLimit.hint')}</p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ margin: '8px 0 0', fontSize: '0.85rem', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </section>
  );
}
