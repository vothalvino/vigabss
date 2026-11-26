// The organization's bank accounts on the money tie-out page: what was
// deposited into each in the month, what each is for, and adding one.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';
import { formatMoney } from '@/lib/money';
import {
  type BankAccountRow, type TieOutReport, button, card, cardTitle, done, hint, input, JSON_HEADERS, primaryButton, td, th,
} from './tieOutShared';

const PURPOSES = ['client_invoices', 'general_public', 'any'] as const;

export function TieOutBank({ report, onChanged }: { report: TieOutReport; onChanged: () => void }) {
  const { t } = useTranslation();
  const bank = report.bank;
  const accounts = bank?.accounts ?? [];
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHint, setAccountHint] = useState('');
  const [purpose, setPurpose] = useState<(typeof PURPOSES)[number]>('any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => {
      await done(authedFetch('/api/v1/money-tieout/bank-accounts', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
        name: name.trim(), purpose,
        ...(bankName.trim() ? { bank_name: bankName.trim() } : {}),
        ...(accountHint.trim() ? { account_hint: accountHint.trim() } : {}),
      }) }));
      setName(''); setBankName(''); setAccountHint(''); setPurpose('any');
    });
  }
  const update = (a: BankAccountRow, body: Record<string, string>) => run(() => done(authedFetch(`/api/v1/money-tieout/bank-accounts/${a.id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) })));

  return (
    <section style={card} aria-label={t('tieOut.bank.title')}>
      <h2 style={cardTitle}>{t('tieOut.bank.title')}</h2>
      <p style={hint}>{t('tieOut.bank.hint')}</p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('tieOut.bank.cashForClients')}</div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatMoney(bank?.cash_for_client_invoices)}</div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('tieOut.bank.cashForPublic')}</div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatMoney(bank?.cash_for_general_public)}</div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('tieOut.bank.deposited')}</div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatMoney(bank?.deposited)}</div>
        </div>
      </div>
      {accounts.length === 0
        ? <p style={hint}>{t('tieOut.bank.none')}</p>
        : (
          <div style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>{t('tieOut.bank.account')}</th>
                  <th style={th}>{t('tieOut.bank.purpose')}</th>
                  <th style={{ ...th, textAlign: 'right' }}>{t('tieOut.bank.depositsInMonth')}</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {accounts.map(a => (
                  <tr key={a.id} style={a.status === 'inactive' ? { opacity: 0.6 } : undefined}>
                    <td style={td}>
                      {a.name}
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: '0.78rem' }}>
                        {[a.bank_name, a.account_hint].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td style={td}>
                      <select
                        aria-label={`${t('tieOut.bank.purpose')}: ${a.name}`}
                        style={input}
                        value={a.purpose}
                        disabled={busy}
                        onChange={e => void update(a, { purpose: e.target.value })}
                      >
                        {PURPOSES.map(p => <option key={p} value={p}>{t(`tieOut.bank.purposes.${p}`)}</option>)}
                      </select>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{formatMoney(a.deposited)}{a.deposits ? ` (${a.deposits})` : ''}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button
                        type="button"
                        style={button}
                        disabled={busy}
                        onClick={() => void update(a, { status: a.status === 'active' ? 'inactive' : 'active' })}
                      >
                        {a.status === 'active' ? t('tieOut.bank.deactivate') : t('tieOut.bank.activate')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        <input style={input} aria-label={t('tieOut.bank.name')} placeholder={t('tieOut.bank.name')} maxLength={100} value={name} onChange={e => setName(e.target.value)} />
        <input style={input} aria-label={t('tieOut.bank.bankName')} placeholder={t('tieOut.bank.bankName')} maxLength={100} value={bankName} onChange={e => setBankName(e.target.value)} />
        <input style={{ ...input, width: 110 }} aria-label={t('tieOut.bank.accountHint')} placeholder={t('tieOut.bank.accountHint')} maxLength={20} value={accountHint} onChange={e => setAccountHint(e.target.value)} />
        <select style={input} aria-label={t('tieOut.bank.purpose')} value={purpose} onChange={e => setPurpose(e.target.value as (typeof PURPOSES)[number])}>
          {PURPOSES.map(p => <option key={p} value={p}>{t(`tieOut.bank.purposes.${p}`)}</option>)}
        </select>
        <button type="submit" style={primaryButton} disabled={busy || !name.trim()}>{t('tieOut.bank.add')}</button>
      </form>
      {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '8px 0 0' }}>{error}</p>}
    </section>
  );
}
