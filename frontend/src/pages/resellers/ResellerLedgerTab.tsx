// =============================================================================
// Reseller cash movements (GET/POST /resellers/:id/ledger)
// =============================================================================
// A top-level reseller's account with the ISP: every cash collection (+),
// voided collection (−), cash handed in (deposit, −) and adjustment (±).
// The summary is what it owes (sealed cash bags not yet received included),
// what those bags hold, the cash it still holds outside bags, its effective
// cash limit and what it may still collect. A deposit or an adjustment that
// came from receiving a cash bag names the bag. With reseller_ledger.manage the page records a cash hand-in
// ("Registrar entrega de efectivo") or an adjustment (with a required note).
// A hand-in is a ledger entry only, never a payment. Sub-resellers collect
// on their top-level reseller's account, so only top-level ones are listed.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { extractApiError } from '@/components/ClientFormModal';
import { LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { toLedgerPage, toNumber, type PuntoLedgerPage } from '../punto/puntoApi';
import { styles } from '../crudStyles';

const PAGE_SIZE = 25;
const MONEY = /^-?\d+(\.\d{1,2})?$/;
const DATETIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

type EntryType = 'deposit' | 'adjustment';

function EntryForm({ resellerId, type, currency, onSaved }: { resellerId: number; type: EntryType; currency: string; onSaved: (text: string) => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: async (body: { entry_type: EntryType; amount: number; note?: string }) => {
      await apiFetch(`/resellers/${resellerId}/ledger`, { method: 'POST', body: JSON.stringify(body) });
      return body.amount;
    },
    onSuccess: (value: number) => {
      setAmount(''); setNote('');
      onSaved(t(type === 'deposit' ? 'resellerLedger.depositSaved' : 'resellerLedger.adjustmentSaved', { amount: formatMoney(value, currency) }));
    },
    onError: (err: unknown) => setError(extractApiError(err, t('resellerLedger.saveError'))),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const raw = amount.trim();
    const value = Number(raw);
    if (!MONEY.test(raw) || value === 0 || (type === 'deposit' && value < 0)) {
      setError(t(type === 'deposit' ? 'resellerLedger.depositInvalid' : 'resellerLedger.adjustmentInvalid'));
      return;
    }
    const text = note.trim();
    if (type === 'adjustment' && !text) { setError(t('resellerLedger.noteRequired')); return; }
    save.mutate({ entry_type: type, amount: value, ...(text ? { note: text } : {}) });
  }

  const id = `rl-${type}`;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} style={{ ...styles.tableCard, padding: '0.75rem 1rem', flex: '1 1 280px' }}>
      <h4 id={`${id}-title`} style={{ margin: '0 0 6px' }}>{t(type === 'deposit' ? 'resellerLedger.depositTitle' : 'resellerLedger.adjustmentTitle')}</h4>
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        {t(type === 'deposit' ? 'resellerLedger.depositHelp' : 'resellerLedger.adjustmentHelp')}
      </p>
      <label style={styles.label} htmlFor={`${id}-amount`}>{t(type === 'deposit' ? 'resellerLedger.depositAmount' : 'resellerLedger.adjustmentAmount')}</label>
      <input id={`${id}-amount`} inputMode="decimal" style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} value={amount} onChange={e => setAmount(e.target.value)} />
      <label style={{ ...styles.label, marginTop: 8 }} htmlFor={`${id}-note`}>
        {t(type === 'deposit' ? 'resellerLedger.noteOptional' : 'resellerLedger.noteRequiredLabel')}
      </label>
      <input id={`${id}-note`} maxLength={500} style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} value={note} onChange={e => setNote(e.target.value)} />
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      <button type="submit" style={{ ...styles.btnPrimary, marginTop: 10 }} disabled={save.isPending}>
        {save.isPending ? t('resellerLedger.saving') : t(type === 'deposit' ? 'resellerLedger.depositSubmit' : 'resellerLedger.adjustmentSubmit')}
      </button>
    </form>
  );
}

export function ResellerLedgerTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = can(user, 'reseller_ledger.manage');
  const canSeePayments = can(user, 'payments.view');
  const currency = user?.organization_currency || 'MXN';
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState('');

  const resellersQ = useQuery({
    queryKey: ['resellers-top-level'],
    queryFn: async () => (await apiFetch<{ data: { id: number; name: string }[] }>('/resellers?parent_id=null&limit=100')).data,
  });
  const ledgerQ = useQuery({
    queryKey: ['reseller-ledger', resellerId, page],
    enabled: resellerId !== null,
    queryFn: async (): Promise<PuntoLedgerPage> => toLedgerPage(await apiFetch(`/resellers/${resellerId}/ledger?page=${page}&limit=${PAGE_SIZE}`)),
    placeholderData: keepPreviousData,
  });
  const fmt = (v: number | string | null | undefined) => formatMoney(v, currency);
  const s = ledgerQ.data?.summary;
  const total = ledgerQ.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function saved(text: string) {
    setMsg(text);
    setPage(1);
    void qc.invalidateQueries({ queryKey: ['reseller-ledger', resellerId] });
  }

  return (
    <div>
      <h3>{t('resellerLedger.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerLedger.help')}</p>
      <label style={styles.filterLabel}>
        {t('resellerLedger.reseller')}
        <select
          style={styles.filterSelect}
          value={resellerId ?? ''}
          onChange={e => { setResellerId(Number(e.target.value) || null); setPage(1); setMsg(''); }}
        >
          <option value="">{t('resellerLedger.selectReseller')}</option>
          {(resellersQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      {msg && <p role="status" style={{ color: 'var(--success)', margin: '12px 0 0' }}>{msg}</p>}

      {resellerId !== null && (ledgerQ.isLoading ? <LoadingState /> : ledgerQ.isError ? (
        <p style={styles.msgError}>{t('resellerLedger.loadError')}</p>
      ) : (
        <>
          {s && (
            <section aria-label={t('resellerLedger.summary')} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
              {[
                { label: t('resellerLedger.balance'), value: fmt(s.balance) },
                ...(s.in_bags !== undefined ? [
                  { label: t('cashBags.ledger.inBags'), value: fmt(s.in_bags) },
                  { label: t('cashBags.ledger.cashOnHand'), value: fmt(s.cash_on_hand) },
                ] : []),
                { label: t('resellerLedger.creditLimit'), value: fmt(s.credit_limit) },
                { label: t('resellerLedger.available'), value: fmt(Math.max(0, toNumber(s.available_to_collect))) },
              ].map(card => (
                <div key={card.label} style={{ ...styles.tableCard, padding: '0.75rem 1rem', minWidth: 180 }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{card.label}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{card.value}</div>
                </div>
              ))}
            </section>
          )}
          {canSeePayments && (
            <p style={{ margin: '0 0 12px' }}><Link to={`/payments?reseller_id=${resellerId}`}>{t('resellerLedger.viewPayments')}</Link></p>
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <EntryForm resellerId={resellerId} type="deposit" currency={currency} onSaved={saved} />
              <EntryForm resellerId={resellerId} type="adjustment" currency={currency} onSaved={saved} />
            </div>
          )}

          <div style={styles.tableCard}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('resellerLedger.colDate')}</th>
                  <th style={styles.th}>{t('resellerLedger.colType')}</th>
                  <th style={styles.thNum}>{t('resellerLedger.colAmount')}</th>
                  <th style={styles.th}>{t('resellerLedger.colNote')}</th>
                  <th style={styles.th}>{t('resellerLedger.colPayment')}</th>
                </tr>
              </thead>
              <tbody>
                {(ledgerQ.data?.data ?? []).length === 0 && (
                  <tr><td colSpan={5} style={styles.emptyCell}>{t('resellerLedger.empty')}</td></tr>
                )}
                {(ledgerQ.data?.data ?? []).map(e => (
                  <tr key={e.id} style={styles.tr}>
                    <td style={styles.td}>{formatDate(e.created_at, DATETIME)}</td>
                    <td style={styles.td}>{t(`resellerLedger.types.${e.entry_type}`, { defaultValue: e.entry_type })}</td>
                    <td style={styles.tdNum}>{toNumber(e.amount) > 0 ? `+${fmt(e.amount)}` : fmt(e.amount)}</td>
                    <td style={styles.td}>
                      {e.cash_bag_id ? <div style={{ fontWeight: 600 }}>{t('cashBags.ledger.bag', { serial: e.cash_bag_serial || `#${e.cash_bag_id}` })}</div> : null}
                      {e.note || (e.cash_bag_id ? null : '—')}
                    </td>
                    <td style={styles.td}>
                      {e.payment_id ? (canSeePayments ? <Link to={`/payments/${e.payment_id}`}>#{e.payment_id}</Link> : `#${e.payment_id}`) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div style={styles.pagination}>
              <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('punto.common.previous')}</button>
              <span style={styles.pageInfo}>{t('punto.common.pageOf', { page, pages })}</span>
              <button type="button" style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('punto.common.next')}</button>
            </div>
          )}
        </>
      ))}
    </div>
  );
}
