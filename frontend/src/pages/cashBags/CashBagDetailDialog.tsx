// =============================================================================
// Cash bags (staff) — one bag with its history (GET /cash-bags/:id)
// =============================================================================
// Every state change of a bag is an event with who made it and when: handed
// to a carrier, dropped at a reseller, sealed with the declared amount,
// picked up, received with the counted amount, voided or lost with the
// reason. The actions the bag's state and the user's permissions allow are
// offered here; `start` opens one of them straight away (the board's
// "Recibir").
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { Modal } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import { cashBagKeys, fetchCashBag, type ReceiveResult } from './cashBagsApi';
import { LOSABLE, RECEIVABLE, ReasonForm, ReceiveForm, VOIDABLE } from './CashBagActions';
import { BagStatusBadge, VarianceText, formatMoment, mono } from './cashBagUi';

export type BagAction = 'receive' | 'void' | 'lost' | null;

export function CashBagDetailDialog({ bagId, start = null, onClose }: { bagId: number; start?: BagAction; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const currencyFallback = user?.organization_currency || 'MXN';
  const canReceive = can(user, 'cash_bags.receive');
  const canManage = can(user, 'cash_bags.manage');
  const [action, setAction] = useState<BagAction>(start);
  const [result, setResult] = useState<ReceiveResult | null>(null);
  const [msg, setMsg] = useState('');
  const q = useQuery({ queryKey: cashBagKeys.detail(bagId), queryFn: () => fetchCashBag(bagId) });
  const bag = q.data;
  const currency = bag?.currency || currencyFallback;
  const fmt = (v: number | string | null) => formatMoney(v, currency);

  function changed(text: string) {
    setAction(null);
    setMsg(text);
    void qc.invalidateQueries({ queryKey: cashBagKeys.all });
    // The reseller's ledger and money change with a receipt.
    void qc.invalidateQueries({ queryKey: ['reseller-ledger'] });
  }

  return (
    <Modal open title={t('cashBags.detail.title', { serial: bag?.serial ?? '' })} onClose={onClose} style={{ width: 640 }}>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('cashBags.detail.loadError')} onRetry={() => { void q.refetch(); }} />}
      {bag && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {msg && <p role="status" style={{ color: 'var(--success)', margin: 0, fontWeight: 600 }}>{msg}</p>}
          {result && result.ledger.length === 0 && <p style={{ margin: 0 }}>{t('cashBags.receive.noLines')}</p>}
          {result && result.ledger.length > 0 && (
            <ul aria-label={t('cashBags.receive.ledgerLines')} style={{ margin: 0, paddingLeft: 18 }}>
              {result.ledger.map((l, i) => (
                <li key={i}>{t(`resellerLedger.types.${l.entry_type}`, { defaultValue: l.entry_type })}: {fmt(l.amount)}{l.note ? ` — ${l.note}` : ''}</li>
              ))}
            </ul>
          )}
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
            <dt>{t('cashBags.col.serial')}</dt><dd style={{ margin: 0, ...mono }}>{bag.serial}</dd>
            <dt>{t('cashBags.col.status')}</dt><dd style={{ margin: 0 }}><BagStatusBadge status={bag.status} /></dd>
            <dt>{t('cashBags.col.reseller')}</dt><dd style={{ margin: 0 }}>{bag.reseller_name ?? '—'}</dd>
            <dt>{t('cashBags.col.carrier')}</dt><dd style={{ margin: 0 }}>{bag.carrier_name ?? '—'}</dd>
            <dt>{t('cashBags.col.declared')}</dt><dd style={{ margin: 0 }}>{fmt(bag.declared_amount)}</dd>
            <dt>{t('cashBags.col.counted')}</dt><dd style={{ margin: 0 }}>{fmt(bag.counted_amount)}</dd>
            <dt>{t('cashBags.col.variance')}</dt><dd style={{ margin: 0 }}><VarianceText variance={bag.variance} currency={currency} /></dd>
          </dl>

          {action === null && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {canReceive && RECEIVABLE.has(bag.status) && <button type="button" style={styles.btnPrimary} onClick={() => setAction('receive')}>{t('cashBags.actions.receive')}</button>}
              {canManage && VOIDABLE.has(bag.status) && <button type="button" style={styles.btnDanger} onClick={() => setAction('void')}>{t('cashBags.actions.void')}</button>}
              {canManage && LOSABLE.has(bag.status) && <button type="button" style={styles.btnDanger} onClick={() => setAction('lost')}>{t('cashBags.actions.lost')}</button>}
            </div>
          )}
          {action === 'receive' && RECEIVABLE.has(bag.status) && (
            <ReceiveForm bag={bag} currency={currency} onCancel={() => setAction(null)}
              onDone={r => { setResult(r); changed(t('cashBags.receive.done', { serial: bag.serial })); }} />
          )}
          {(action === 'void' || action === 'lost') && (
            <ReasonForm bag={bag} action={action} onCancel={() => setAction(null)}
              onDone={() => changed(t(action === 'void' ? 'cashBags.reason.voidDone' : 'cashBags.reason.lostDone', { serial: bag.serial }))} />
          )}

          <section aria-labelledby="cash-bag-history">
            <h4 id="cash-bag-history" style={{ margin: '4px 0 6px' }}>{t('cashBags.detail.history')}</h4>
            {bag.events.length === 0 ? <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('cashBags.detail.noEvents')}</p> : (
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bag.events.map(ev => (
                  <li key={ev.id}>
                    <div>
                      <strong>{t(`cashBags.status.${ev.to_status}`, { defaultValue: ev.to_status })}</strong>
                      {' · '}{formatMoment(ev.created_at)}{ev.actor_name ? ` · ${ev.actor_name}` : ''}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {[
                        ev.amount !== null ? t('cashBags.detail.amount', { amount: fmt(ev.amount) }) : null,
                        ev.reseller_name, ev.carrier_name, ev.note,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
