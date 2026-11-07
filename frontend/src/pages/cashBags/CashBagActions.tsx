// =============================================================================
// Cash bags (staff) — receive, void and lost
// =============================================================================
// Receive (cash_bags.receive): the bag arrived (in_transit) or the reseller
// brought it in person (ready_for_pickup). The counted cash is compared with
// what the reseller declared before confirming. The declared amount left the
// reseller's ledger when the bag was sealed (bag_sealed, migration 006), so
// POST /cash-bags/:id/receive books only a difference: an adjustment when the
// count differs (a short bag raises what the reseller owes, an over bag
// lowers it), nothing when it matches.
// Void (cash_bags.manage): a bag that never held declared cash (in stock,
// with a carrier or empty at a reseller) is taken out of use. Lost
// (cash_bags.manage): a sealed bag that never arrived. No ledger entry is
// posted: the reseller does not owe the declared amount (it left its ledger
// at sealing) and the loss is the ISP's, unless an administrator records an
// adjustment. Both need a reason.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { extractApiError } from '@/components/ClientFormModal';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import { bagRefusalKey, closeCashBag, receiveCashBag, toAmount, type CashBag, type ReceiveResult } from './cashBagsApi';
import { VarianceText, mono } from './cashBagUi';

const AMOUNT = /^\d+(\.\d{1,2})?$/;

export const RECEIVABLE = new Set(['in_transit', 'ready_for_pickup']);
export const VOIDABLE = new Set(['in_stock', 'with_carrier', 'at_reseller']);
export const LOSABLE = new Set(['ready_for_pickup', 'in_transit']);

export function ReceiveForm({ bag, currency, onDone, onCancel }: { bag: CashBag; currency: string; onDone: (r: ReceiveResult) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const declared = toAmount(bag.declared_amount);
  const [counted, setCounted] = useState(() => declared.toFixed(2));
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const valid = AMOUNT.test(counted.trim());
  const value = valid ? Number(counted.trim()) : null;
  const variance = value === null ? null : Math.round((value - declared) * 100) / 100;
  const fmt = (v: number | string | null) => formatMoney(v, currency);

  const receive = useMutation({
    mutationFn: () => receiveCashBag(bag.id, { counted_amount: value ?? 0, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (r: ReceiveResult) => onDone(r),
    onError: (err: unknown) => { setConfirming(false); const key = bagRefusalKey(err); setError(key ? t(key) : extractApiError(err, t('cashBags.receive.error'))); },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (value === null) { setError(t('cashBags.receive.countedInvalid')); return; }
    if (!confirming) { setConfirming(true); return; }
    receive.mutate();
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="cash-bag-receive-title" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h4 id="cash-bag-receive-title" style={{ margin: 0 }}>{t('cashBags.receive.title', { serial: bag.serial })}</h4>
      {bag.status === 'ready_for_pickup' && <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('cashBags.receive.inPerson')}</p>}
      <div>{t('cashBags.receive.declared')}: <strong>{fmt(declared)}</strong></div>
      <label style={styles.label} htmlFor="cash-bag-counted">{t('cashBags.receive.counted')}</label>
      <input id="cash-bag-counted" inputMode="decimal" autoComplete="off" style={styles.input} value={counted}
        onChange={e => { setCounted(e.target.value); setConfirming(false); }} />
      {variance !== null && (
        <p style={{ margin: 0 }} aria-live="polite">{t('cashBags.receive.difference')}: <VarianceText variance={variance} currency={currency} /></p>
      )}
      <label style={styles.label} htmlFor="cash-bag-receive-note">{t('cashBags.receive.note')}</label>
      <input id="cash-bag-receive-note" maxLength={400} style={styles.input} value={note} onChange={e => setNote(e.target.value)} />
      {confirming && value !== null && variance !== null && (
        <p style={{ margin: 0, fontWeight: 600 }}>
          {variance === 0
            ? t('cashBags.receive.confirmEqual', { declared: fmt(declared), reseller: bag.reseller_name ?? '' })
            : t('cashBags.receive.confirmDiff', { declared: fmt(declared), reseller: bag.reseller_name ?? '', adjustment: fmt(Math.round((declared - value) * 100) / 100) })}
        </p>
      )}
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" style={styles.btnPrimary} disabled={receive.isPending}>
          {receive.isPending ? t('cashBags.receive.saving') : confirming ? t('cashBags.receive.confirm') : t('cashBags.receive.review')}
        </button>
        <button type="button" style={styles.btnSecondary} onClick={onCancel}>{t('cashBags.common.cancel')}</button>
      </div>
    </form>
  );
}

export function ReasonForm({ bag, action, onDone, onCancel }: { bag: CashBag; action: 'void' | 'lost'; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => closeCashBag(bag.id, action, reason.trim()),
    onSuccess: () => onDone(),
    onError: (err: unknown) => { const key = bagRefusalKey(err); setError(key ? t(key) : extractApiError(err, t('cashBags.reason.error'))); },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const r = reason.trim();
    if (r.length < 3 || r.length > 500) { setError(t('cashBags.reason.invalid')); return; }
    save.mutate();
  }

  const id = `cash-bag-${action}`;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h4 id={`${id}-title`} style={{ margin: 0 }}>{t(action === 'void' ? 'cashBags.reason.voidTitle' : 'cashBags.reason.lostTitle')} <span style={mono}>{bag.serial}</span></h4>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t(action === 'void' ? 'cashBags.reason.voidHelp' : 'cashBags.reason.lostHelp')}</p>
      <label style={styles.label} htmlFor={`${id}-reason`}>{t('cashBags.reason.label')}</label>
      <textarea id={`${id}-reason`} rows={2} maxLength={500} style={styles.input} value={reason} onChange={e => setReason(e.target.value)} />
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" style={styles.btnDanger} disabled={save.isPending}>
          {save.isPending ? t('cashBags.common.saving') : t(action === 'void' ? 'cashBags.reason.voidSubmit' : 'cashBags.reason.lostSubmit')}
        </button>
        <button type="button" style={styles.btnSecondary} onClick={onCancel}>{t('cashBags.common.cancel')}</button>
      </div>
    </form>
  );
}
