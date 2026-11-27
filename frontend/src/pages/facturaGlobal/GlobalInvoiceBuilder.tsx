// New General Public invoice, built from payments. Staff choose one form of
// payment (the CFDI states a single one) and the days, load the payments
// whose invoices are still to be reported, untick any to leave out, and
// create a draft. Stamping is done from the draft, after a look at it.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { parseApiError } from '@/api/errors';
import { formatMoney } from '@/lib/money';
import { Modal } from '@/components/ui/Modal';
import { styles } from '../crudStyles';
import type { paths } from '@/api/schema';

type Eligible = NonNullable<paths['/facturas-publicas/eligible-payments']['get']['responses'][200]['content']['application/json']>;
type PaymentRow = NonNullable<Eligible['data']>[number];

// SAT c_FormaPago, the ones a payment here can carry.
export const GLOBAL_FORMAS = ['01', '03', '04', '28', '02'] as const;

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function GlobalInvoiceBuilder({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { t } = useTranslation();
  const today = new Date();
  const [forma, setForma] = useState<string>('01');
  const [from, setFrom] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(ymd(today));
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different form or range is a different list: what was loaded no longer applies.
  function change(apply: () => void) {
    apply();
    setRows(null);
    setPicked(new Set());
    setError(null);
  }

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.GET('/facturas-publicas/eligible-payments', { params: { query: { date_from: from, date_to: to, forma_pago: forma } } });
    setBusy(false);
    const failure: unknown = res.error;
    if (failure) { setError(parseApiError(failure, t('facturaGlobal.actionFailed'))); return; }
    const list = res.data?.data ?? [];
    setRows(list);
    // Everything is included unless it is unticked.
    setPicked(new Set(list.map(r => r.payment_id as number)));
  }

  async function create() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    const all = picked.size === rows.length;
    const res = await api.POST('/facturas-publicas/generate', {
      body: { date_from: from, date_to: to, forma_pago: forma, ...(all ? {} : { payment_ids: [...picked] }) },
    });
    setBusy(false);
    const failure: unknown = res.error;
    if (failure) { setError(parseApiError(failure, t('facturaGlobal.actionFailed'))); return; }
    const id = res.data?.data?.id;
    if (id) onCreated(id);
  }

  function toggle(id: number) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const allPicked = rows !== null && rows.length > 0 && picked.size === rows.length;
  const pickedTotal = (rows ?? []).filter(r => picked.has(r.payment_id as number)).reduce((n, r) => n + (r.total ?? 0), 0);

  return (
    <Modal open={open} title={t('facturaGlobal.builder.title')} onClose={onClose} style={{ maxWidth: 880, width: '95vw' }}>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('facturaGlobal.builder.help')}</p>
      <form onSubmit={load} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={styles.label}>
          {t('facturaGlobal.builder.forma')}
          <select style={styles.filterSelect} value={forma} onChange={e => change(() => setForma(e.target.value))}>
            {GLOBAL_FORMAS.map(f => <option key={f} value={f}>{t(`facturaGlobal.builder.formas.${f}`)}</option>)}
          </select>
        </label>
        <label style={styles.label}>
          {t('facturaGlobal.builder.from')}
          <input style={styles.input} type="date" required value={from} max={to} onChange={e => change(() => setFrom(e.target.value))} />
        </label>
        <label style={styles.label}>
          {t('facturaGlobal.builder.to')}
          <input style={styles.input} type="date" required value={to} min={from} onChange={e => change(() => setTo(e.target.value))} />
        </label>
        <button type="submit" style={styles.btnSecondary} disabled={busy}>{t('facturaGlobal.builder.load')}</button>
      </form>

      {error && <p role="alert" style={styles.msgError}>{error}</p>}

      {rows !== null && rows.length === 0 && <p style={styles.msg}>{t('facturaGlobal.builder.none')}</p>}

      {rows !== null && rows.length > 0 && (
        <>
          <div style={{ overflow: 'auto', maxHeight: '45vh', marginTop: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>
                    <input
                      type="checkbox"
                      aria-label={t('facturaGlobal.builder.all')}
                      checked={allPicked}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map(r => r.payment_id as number)))}
                    />
                  </th>
                  <th style={styles.th}>{t('facturaGlobal.builder.date')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.client')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.method')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.invoices')}</th>
                  <th style={styles.thNum}>{t('facturaGlobal.builder.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const id = r.payment_id as number;
                  return (
                    <tr key={id} style={styles.tr}>
                      <td style={styles.td}>
                        <input
                          type="checkbox"
                          aria-label={t('facturaGlobal.builder.include', { id })}
                          checked={picked.has(id)}
                          onChange={() => toggle(id)}
                        />
                      </td>
                      <td style={styles.td}>{String(r.payment_date ?? '').slice(0, 10)}</td>
                      <td style={styles.td}>{r.client_name ?? '—'}</td>
                      <td style={styles.td}>{t(`paymentMethods.${r.payment_method}`, { defaultValue: r.payment_method ?? '' })}</td>
                      <td style={styles.td}>{(r.invoices ?? []).map(i => i.invoice_number).join(', ')}</td>
                      <td style={styles.tdNum}>{formatMoney(r.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p role="status" style={{ margin: '10px 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {t('facturaGlobal.builder.summary', { picked: picked.size, total: rows.length, amount: formatMoney(pickedTotal) })}
          </p>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" style={styles.btnSecondary} onClick={onClose}>{t('facturaGlobal.cancel')}</button>
        <button type="button" style={styles.btnPrimary} disabled={busy || !rows || picked.size === 0} onClick={() => void create()}>
          {t('facturaGlobal.builder.create')}
        </button>
      </div>
    </Modal>
  );
}
