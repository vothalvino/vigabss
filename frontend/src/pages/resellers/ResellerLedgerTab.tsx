// =============================================================================
// Reseller cash movements (GET/POST /resellers/:id/ledger)
// =============================================================================
// A top-level reseller's account with the ISP: every cash collection (+),
// voided collection (−), cash handed in (deposit, −), cash bag sealed
// (bag_sealed, −; migration 006), adjustment (±), and since phase 4
// (migration 007) the commission it keeps from the cash when an invoice of
// one of its (or its sub-resellers') clients is paid (commission, −), its
// reversal when that invoice stops being paid (commission_reversal, +) and
// what the ISP paid it (payout, +). The summary is what it owes (the cash it
// still holds, net of the commissions it kept: a sealed bag left it at
// sealing) or, when negative, what the ISP owes it; the cash in its sealed
// bags awaiting pickup or on their way (for information); its effective cash
// limit and what it may still collect. A line that came from a cash bag (its
// seal, or the difference counted on receipt) names the bag, and a commission
// line links its invoice. With reseller_ledger.manage the page records a cash
// hand-in ("Registrar entrega de efectivo", at most what it owes), a payout
// (at most what the ISP owes it) or an adjustment (with a required note).
// Neither is ever a payment. Sub-resellers collect and earn on their
// top-level reseller's account, so the tab shows on top-level points only.
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
import { apiErrorCode, toLedgerPage, toNumber, type PuntoLedgerPage } from '../punto/puntoApi';
import { styles } from '../crudStyles';
import { resellerDetailKey } from './resellerOptions';

const PAGE_SIZE = 25;
const MONEY = /^-?\d+(\.\d{1,2})?$/;
const DATETIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

type EntryType = 'deposit' | 'payout' | 'adjustment';

// The i18n keys of each form, under resellerLedger.
const FORM_KEYS: Record<EntryType, { title: string; help: string; amount: string; submit: string; saved: string; invalid: string }> = {
  deposit: { title: 'depositTitle', help: 'depositHelp', amount: 'depositAmount', submit: 'depositSubmit', saved: 'depositSaved', invalid: 'depositInvalid' },
  payout: { title: 'payoutTitle', help: 'payoutHelp', amount: 'payoutAmount', submit: 'payoutSubmit', saved: 'payoutSaved', invalid: 'payoutInvalid' },
  adjustment: { title: 'adjustmentTitle', help: 'adjustmentHelp', amount: 'adjustmentAmount', submit: 'adjustmentSubmit', saved: 'adjustmentSaved', invalid: 'adjustmentInvalid' },
};

// The refusals of POST /resellers/:id/ledger, in the reader's language.
const REFUSALS: Record<string, string> = {
  DEPOSIT_EXCEEDS_BALANCE: 'resellerLedger.depositTooMuch',
  PAYOUT_EXCEEDS_OWED: 'resellerLedger.payoutTooMuch',
};

function EntryForm({ resellerId, type, currency, owed, onSaved }: {
  resellerId: number; type: EntryType; currency: string;
  /** For a payout: what the ISP owes the reseller (minus a negative balance, else 0). */
  owed?: number;
  onSaved: (text: string) => void;
}) {
  const { t } = useTranslation();
  const keys = FORM_KEYS[type];
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
      onSaved(t(`resellerLedger.${keys.saved}`, { amount: formatMoney(value, currency) }));
    },
    onError: (err: unknown) => {
      const refusal = REFUSALS[apiErrorCode(err) ?? ''];
      setError(refusal ? t(refusal) : extractApiError(err, t('resellerLedger.saveError')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const raw = amount.trim();
    const value = Number(raw);
    if (!MONEY.test(raw) || value === 0 || (type !== 'adjustment' && value < 0)) {
      setError(t(`resellerLedger.${keys.invalid}`));
      return;
    }
    if (type === 'payout' && Math.round(value * 100) > Math.round((owed ?? 0) * 100)) {
      setError(t('resellerLedger.payoutTooMuch'));
      return;
    }
    const text = note.trim();
    if (type === 'adjustment' && !text) { setError(t('resellerLedger.noteRequired')); return; }
    save.mutate({ entry_type: type, amount: value, ...(text ? { note: text } : {}) });
  }

  const id = `rl-${type}`;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} style={{ ...styles.tableCard, padding: '0.75rem 1rem', flex: '1 1 280px' }}>
      <h4 id={`${id}-title`} style={{ margin: '0 0 6px' }}>{t(`resellerLedger.${keys.title}`)}</h4>
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        {t(`resellerLedger.${keys.help}`)}
      </p>
      {type === 'payout' && (
        <p style={{ margin: '0 0 8px', fontSize: '0.85rem', fontWeight: 600 }}>
          {(owed ?? 0) > 0
            ? t('resellerLedger.payoutOwed', { amount: formatMoney(owed ?? 0, currency) })
            : t('resellerLedger.payoutNothingOwed')}
        </p>
      )}
      <label style={styles.label} htmlFor={`${id}-amount`}>{t(`resellerLedger.${keys.amount}`)}</label>
      <input id={`${id}-amount`} inputMode="decimal" style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} value={amount} onChange={e => setAmount(e.target.value)} />
      <label style={{ ...styles.label, marginTop: 8 }} htmlFor={`${id}-note`}>
        {t(type === 'adjustment' ? 'resellerLedger.noteRequiredLabel' : 'resellerLedger.noteOptional')}
      </label>
      <input id={`${id}-note`} maxLength={500} style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} value={note} onChange={e => setNote(e.target.value)} />
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      <button type="submit" style={{ ...styles.btnPrimary, marginTop: 10 }} disabled={save.isPending}>
        {save.isPending ? t('resellerLedger.saving') : t(`resellerLedger.${keys.submit}`)}
      </button>
    </form>
  );
}

export function ResellerLedgerTab({ resellerId }: { resellerId: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = can(user, 'reseller_ledger.manage');
  const canSeePayments = can(user, 'payments.view');
  const canSeeInvoices = can(user, 'invoices.view');
  const currency = user?.organization_currency || 'MXN';
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState('');

  const ledgerQ = useQuery({
    queryKey: ['reseller-ledger', resellerId, page],
    queryFn: async (): Promise<PuntoLedgerPage> => toLedgerPage(await apiFetch(`/resellers/${resellerId}/ledger?page=${page}&limit=${PAGE_SIZE}`)),
    placeholderData: keepPreviousData,
  });
  const fmt = (v: number | string | null | undefined) => formatMoney(v, currency);
  const s = ledgerQ.data?.summary;
  // A negative balance is what the ISP owes the reseller: its commissions
  // passed the cash it holds.
  const balance = s ? toNumber(s.balance) : 0;
  const owedToReseller = Math.max(0, -balance);
  const total = ledgerQ.data?.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function saved(text: string) {
    setMsg(text);
    setPage(1);
    void qc.invalidateQueries({ queryKey: ['reseller-ledger', resellerId] });
    // The reseller page's header shows the same money.
    void qc.invalidateQueries({ queryKey: resellerDetailKey(resellerId) });
  }

  return (
    <div>
      <h3>{t('resellerLedger.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerLedger.help')}</p>
      {msg && <p role="status" style={{ color: 'var(--success)', margin: '12px 0 0' }}>{msg}</p>}

      {(ledgerQ.isLoading ? <LoadingState /> : ledgerQ.isError ? (
        <p style={styles.msgError}>{t('resellerLedger.loadError')}</p>
      ) : (
        <>
          {s && (
            <section aria-label={t('resellerLedger.summary')} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
              {[
                balance < 0
                  ? { label: t('resellerLedger.owedToReseller'), value: fmt(owedToReseller) }
                  : { label: t('resellerLedger.balance'), value: fmt(s.balance) },
                ...(s.in_bags !== undefined ? [
                  { label: t('cashBags.ledger.inBags'), value: fmt(s.in_bags) },
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
              <EntryForm resellerId={resellerId} type="payout" currency={currency} owed={owedToReseller} onSaved={saved} />
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
                      {e.invoice_id ? (
                        <div style={{ fontWeight: 600 }}>
                          {canSeeInvoices
                            ? <Link to={`/invoices/${e.invoice_id}`}>{t('resellerLedger.invoice', { number: e.invoice_number || `#${e.invoice_id}` })}</Link>
                            : t('resellerLedger.invoice', { number: e.invoice_number || `#${e.invoice_id}` })}
                        </div>
                      ) : null}
                      {e.note || (e.cash_bag_id || e.invoice_id ? null : '—')}
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
