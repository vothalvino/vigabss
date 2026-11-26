// The safe on the money tie-out page: what it holds, recording a count, a
// bank deposit or other cash in or out, and the month's movements.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, authedFetch } from '@/api/client';
import { formatMoney } from '@/lib/money';
import {
  type SafeMovementRow, type TieOutReport, TIEOUT_KEY, button, card, cardTitle, done, hint, input, JSON_HEADERS, primaryButton, td, th,
} from './tieOutShared';

const KINDS = ['count', 'deposit', 'other_out', 'other_in'] as const;
type Kind = (typeof KINDS)[number];

export function TieOutSafe({ report, onChanged }: { report: TieOutReport; onChanged: () => void }) {
  const { t } = useTranslation();
  const year = report.period?.year;
  const month = report.period?.month;
  const inSafe = report.cash?.in_transit_end?.in_safe;
  const tracked = Boolean(report.cash?.tracked);
  const accounts = (report.bank?.accounts ?? []).filter(a => a.status === 'active');
  const [kind, setKind] = useState<Kind>('count');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const movements = useQuery({
    queryKey: [...TIEOUT_KEY, 'safe', year, month],
    queryFn: async () => {
      const { data, error: apiError } = await api.GET('/money-tieout/safe-movements', { params: { query: { year, month } } });
      if (apiError) throw new Error('safe movements');
      return (data?.data ?? []) as SafeMovementRow[];
    },
  });
  // Until the safe has been counted, a count is the only thing to record.
  const activeKind: Kind = tracked ? kind : 'count';

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tieOut.failed'));
    } finally {
      setBusy(false);
    }
  }
  function record(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(value) || value < 0 || (activeKind !== 'count' && value <= 0)) {
      setError(t('tieOut.safe.invalidAmount'));
      return;
    }
    if (activeKind === 'deposit' && !accountId) { setError(t('tieOut.safe.chooseAccount')); return; }
    void run(async () => {
      await done(authedFetch('/api/v1/money-tieout/safe-movements', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
        kind: activeKind, amount: value,
        ...(activeKind === 'deposit' ? { bank_account_id: Number(accountId) } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }) }));
      setAmount(''); setReference(''); setNote('');
    });
  }
  function remove(row: SafeMovementRow) {
    if (!window.confirm(t('tieOut.safe.confirmRemove'))) return;
    void run(() => done(authedFetch(`/api/v1/money-tieout/safe-movements/${row.id}`, { method: 'DELETE' })));
  }
  const rows = movements.data ?? [];

  return (
    <section style={card} aria-label={t('tieOut.safe.title')}>
      <h2 style={cardTitle}>{t('tieOut.safe.title')}</h2>
      <p style={hint}>{tracked ? t('tieOut.safe.hint') : t('tieOut.safe.notCounted')}</p>
      {tracked && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('tieOut.safe.holds')}</div>
          <div style={{ fontWeight: 700, fontSize: '1.2rem', color: 'var(--text-primary)' }}>{formatMoney(inSafe)}</div>
        </div>
      )}
      <form onSubmit={record} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select style={input} aria-label={t('tieOut.safe.kind')} value={activeKind} disabled={!tracked} onChange={e => setKind(e.target.value as Kind)}>
          {KINDS.map(k => <option key={k} value={k}>{t(`tieOut.safe.kinds.${k}`)}</option>)}
        </select>
        <input
          style={{ ...input, width: 130 }} type="number" min="0" step="0.01" inputMode="decimal"
          aria-label={t('tieOut.safe.amount')} placeholder={t('tieOut.safe.amount')}
          value={amount} onChange={e => setAmount(e.target.value)}
        />
        {activeKind === 'deposit' && (
          <select style={input} aria-label={t('tieOut.safe.account')} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">{t('tieOut.safe.account')}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        {activeKind === 'deposit' && (
          <input style={input} aria-label={t('tieOut.safe.reference')} placeholder={t('tieOut.safe.reference')} maxLength={100} value={reference} onChange={e => setReference(e.target.value)} />
        )}
        <input style={{ ...input, flex: '1 1 160px' }} aria-label={t('tieOut.safe.note')} placeholder={t('tieOut.safe.note')} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
        <button type="submit" style={primaryButton} disabled={busy}>{t('tieOut.safe.record')}</button>
      </form>
      {activeKind === 'deposit' && accounts.length === 0 && <p style={{ ...hint, marginTop: 8 }}>{t('tieOut.safe.noAccounts')}</p>}
      {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '8px 0 0' }}>{error}</p>}
      {rows.length > 0 && (
        <div style={{ overflow: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{t('tieOut.safe.when')}</th>
                <th style={th}>{t('tieOut.safe.kind')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('tieOut.safe.amount')}</th>
                <th style={th}>{t('tieOut.safe.detail')}</th>
                <th style={th}>{t('tieOut.safe.by')}</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.moved_at ? new Date(r.moved_at).toLocaleString() : ''}</td>
                  <td style={td}>{t(`tieOut.safe.kinds.${r.kind ?? 'count'}`)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{formatMoney(r.amount)}</td>
                  <td style={td}>
                    {r.kind === 'count' && r.expected_amount != null && (r.amount ?? 0) !== r.expected_amount
                      ? t('tieOut.safe.countDifference', { expected: formatMoney(r.expected_amount), difference: formatMoney((r.amount ?? 0) - r.expected_amount) })
                      : [r.bank_account_name, r.reference, r.note].filter(Boolean).join(' · ')}
                  </td>
                  <td style={td}>{r.created_by_name ?? ''}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button type="button" style={button} disabled={busy} onClick={() => remove(r)}>{t('tieOut.safe.remove')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
