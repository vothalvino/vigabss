// Deferred-payment (PPD) invoice CFDIs that are in force while their invoice
// is unpaid. Such a CFDI is income only once it is paid, so the ones that
// will not be collected have to be cancelled: this lists them, oldest first,
// with the cancel action of the CFDI page.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';

export interface UnpaidPpdRow {
  id: number;
  uuid?: string | null;
  serie?: string | null;
  folio?: number | null;
  stamp_date?: string | null;
  total?: number;
  moneda?: string;
  receptor_rfc?: string;
  receptor_nombre?: string;
  client_id?: number | null;
  invoice_id?: number;
  invoice_number?: string;
  balance?: number;
  days_open?: number;
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 10px', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 10px', fontSize: '0.85rem', borderTop: '1px solid var(--border)' };

function money(n: number | undefined, currency: string | undefined) {
  return `${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ''}`.trim();
}

export function UnpaidPpdPanel({ onCancel }: { onCancel: (row: UnpaidPpdRow) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data, isError } = useQuery({
    queryKey: ['cfdi', 'unpaid-ppd'],
    queryFn: async () => {
      const { data: body, error } = await api.GET('/cfdi-documents/unpaid-ppd');
      if (error) throw new Error('unpaid-ppd');
      return body;
    },
  });
  const rows = (data?.data ?? []) as UnpaidPpdRow[];
  if (isError) return <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{t('unpaidPpd.failed')}</p>;
  if (!data || rows.length === 0) return null;
  const currency = rows[0]?.moneda;

  return (
    <section
      aria-label={t('unpaidPpd.title')}
      style={{ background: 'var(--warning-soft)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1rem' }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: 'var(--text-primary)' }}>{t('unpaidPpd.title')}</strong>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {t('unpaidPpd.summary', { count: rows.length, balance: money(data.meta?.balance, currency) })}
        </span>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem' }}
        >
          {open ? t('unpaidPpd.hide') : t('unpaidPpd.show')}
        </button>
      </div>
      <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('unpaidPpd.hint')}</p>
      {open && (
        <div style={{ overflow: 'auto', marginTop: 8, background: 'var(--bg-card)', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{t('unpaidPpd.folio')}</th>
                <th style={th}>{t('unpaidPpd.client')}</th>
                <th style={th}>{t('unpaidPpd.invoice')}</th>
                <th style={th}>{t('unpaidPpd.stamped')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('unpaidPpd.days')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('unpaidPpd.total')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{t('unpaidPpd.balance')}</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={td}>{`${r.serie ?? ''}${r.folio ?? r.id}`}</td>
                  <td style={td}>
                    {r.client_id
                      ? <Link to={`/clients/${r.client_id}`}>{r.receptor_nombre}</Link>
                      : r.receptor_nombre}
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: '0.78rem' }}>{r.receptor_rfc}</span>
                  </td>
                  <td style={td}><Link to={`/invoices/${r.invoice_id}`}>{r.invoice_number}</Link></td>
                  <td style={td}>{r.stamp_date ? new Date(r.stamp_date).toLocaleDateString() : ''}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.days_open}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{money(r.total, r.moneda)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(r.balance, r.moneda)}</td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() => onCancel(r)}
                      style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger)', cursor: 'pointer', fontSize: '0.78rem' }}
                    >
                      {t('ui.cfdiList.cancelCfdi')}
                    </button>
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
