// New General Public invoices, from a range of payment days. Staff choose the
// days and load the paid invoices that were never stamped (the client did not
// ask for a CFDI), each with the payment that settled it: its id, its day and
// its form. They untick what to leave out, by invoice or a whole form of
// payment at once, and choose whether each form of payment gets its own
// invoice or all go into one. The drafts are stamped from the list, after a
// look at them.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { parseApiError } from '@/api/errors';
import { formatMoney } from '@/lib/money';
import { Modal } from '@/components/ui/Modal';
import { styles } from '../crudStyles';
import type { paths } from '@/api/schema';

type Unreported = NonNullable<paths['/facturas-publicas/unreported-invoices']['get']['responses'][200]['content']['application/json']>;
type Row = NonNullable<Unreported['data']>[number];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function GlobalInvoiceBuilder({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  /** The drafts created; the first is opened. */
  onCreated: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const today = new Date();
  const [from, setFrom] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(ymd(today));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [separate, setSeparate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Other days are another list: what was loaded no longer applies.
  function changeRange(apply: () => void) {
    apply();
    setRows(null);
    setPicked(new Set());
    setError(null);
  }

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api.GET('/facturas-publicas/unreported-invoices', { params: { query: { date_from: from, date_to: to } } });
    setBusy(false);
    const failure: unknown = res.error;
    if (failure) { setError(parseApiError(failure, t('facturaGlobal.actionFailed'))); return; }
    const list = res.data?.data ?? [];
    setRows(list);
    // Everything is included unless it is unticked.
    setPicked(new Set(list.map(r => r.invoice_id as number)));
  }

  async function create() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    const all = picked.size === rows.length;
    const res = await api.POST('/facturas-publicas/generate', {
      body: { date_from: from, date_to: to, separate, ...(all ? {} : { invoice_ids: [...picked] }) },
    });
    setBusy(false);
    const failure: unknown = res.error;
    if (failure) { setError(parseApiError(failure, t('facturaGlobal.actionFailed'))); return; }
    const ids = (res.data?.data ?? []).map(r => r.id as number).filter(Boolean);
    if (ids.length) onCreated(ids);
  }

  function toggle(id: number) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleForma(forma: string, on: boolean) {
    setPicked(prev => {
      const next = new Set(prev);
      for (const r of rows ?? []) {
        if (r.forma_pago !== forma) continue;
        if (on) next.add(r.invoice_id as number); else next.delete(r.invoice_id as number);
      }
      return next;
    });
  }

  const list = rows ?? [];
  const formas = [...new Set(list.map(r => r.forma_pago as string))];
  const chosen = list.filter(r => picked.has(r.invoice_id as number));
  const chosenTotal = chosen.reduce((n, r) => n + (r.total ?? 0), 0);
  const chosenFormas = new Set(chosen.map(r => r.forma_pago)).size;
  const documents = chosen.length === 0 ? 0 : separate ? chosenFormas : 1;
  const formaName = (f: string | undefined) => t(`facturaGlobal.builder.formas.${f}`, { defaultValue: f ?? '' });

  return (
    <Modal open={open} title={t('facturaGlobal.builder.title')} onClose={onClose} style={{ maxWidth: 960, width: '95vw' }}>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('facturaGlobal.builder.help')}</p>
      <form onSubmit={load} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={styles.label}>
          {t('facturaGlobal.builder.from')}
          <input style={styles.input} type="date" required value={from} max={to} onChange={e => changeRange(() => setFrom(e.target.value))} />
        </label>
        <label style={styles.label}>
          {t('facturaGlobal.builder.to')}
          <input style={styles.input} type="date" required value={to} min={from} onChange={e => changeRange(() => setTo(e.target.value))} />
        </label>
        <button type="submit" style={styles.btnSecondary} disabled={busy}>{t('facturaGlobal.builder.load')}</button>
      </form>

      {error && <p role="alert" style={styles.msgError}>{error}</p>}

      {rows !== null && list.length === 0 && <p style={styles.msg}>{t('facturaGlobal.builder.none')}</p>}

      {list.length > 0 && (
        <>
          <fieldset style={{ margin: '14px 0 0', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
            <legend style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0 4px' }}>{t('facturaGlobal.builder.forma')}</legend>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
              {formas.map(f => {
                const mine = list.filter(r => r.forma_pago === f);
                const on = mine.filter(r => picked.has(r.invoice_id as number)).length;
                return (
                  <label key={f} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={on === mine.length}
                      ref={el => { if (el) el.indeterminate = on > 0 && on < mine.length; }}
                      onChange={e => toggleForma(f, e.target.checked)}
                    />
                    {t('facturaGlobal.builder.formaCount', { forma: formaName(f), count: mine.length, amount: formatMoney(mine.reduce((n, r) => n + (r.total ?? 0), 0)) })}
                  </label>
                );
              })}
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={separate} onChange={e => setSeparate(e.target.checked)} />
              {t('facturaGlobal.builder.separate')}
            </label>
          </fieldset>

          <div style={{ overflow: 'auto', maxHeight: '40vh', marginTop: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>
                    <input
                      type="checkbox"
                      aria-label={t('facturaGlobal.builder.all')}
                      checked={picked.size === list.length}
                      onChange={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map(r => r.invoice_id as number)))}
                    />
                  </th>
                  <th style={styles.th}>{t('facturaGlobal.builder.invoice')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.client')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.paymentId')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.date')}</th>
                  <th style={styles.th}>{t('facturaGlobal.builder.forma')}</th>
                  <th style={styles.thNum}>{t('facturaGlobal.builder.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map(r => {
                  const id = r.invoice_id as number;
                  return (
                    <tr key={id} style={styles.tr}>
                      <td style={styles.td}>
                        <input
                          type="checkbox"
                          aria-label={t('facturaGlobal.builder.include', { invoice: r.invoice_number })}
                          checked={picked.has(id)}
                          onChange={() => toggle(id)}
                        />
                      </td>
                      <td style={styles.td}>{r.invoice_number}</td>
                      <td style={styles.td}>{r.client_name ?? '—'}</td>
                      <td style={styles.td}>{r.payment_id}</td>
                      <td style={styles.td}>{String(r.payment_date ?? '').slice(0, 10)}</td>
                      <td style={styles.td}>{formaName(r.forma_pago)}</td>
                      <td style={styles.tdNum}>{formatMoney(r.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p role="status" style={{ margin: '10px 0 0', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {t('facturaGlobal.builder.summary', { picked: chosen.length, total: list.length, amount: formatMoney(chosenTotal), count: documents })}
          </p>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" style={styles.btnSecondary} onClick={onClose}>{t('facturaGlobal.cancel')}</button>
        <button type="button" style={styles.btnPrimary} disabled={busy || chosen.length === 0} onClick={() => void create()}>
          {t('facturaGlobal.builder.create', { count: documents || 1 })}
        </button>
      </div>
    </Modal>
  );
}
