// =============================================================================
// Reseller app (/punto) — the receipt of a collection
// =============================================================================
// GET /reseller-app/payments/:id/receipt: a collection of this reseller only
// (404 otherwise). The page prints on a 58mm thermal roll (punto.css @media
// print hides the app around it), and "Enviar por WhatsApp" opens wa.me with a
// short text copy so the reseller picks the chat; no phone number is needed.
// The ISP is the provider: the receipt names it and carries the server's
// legend that the reseller collected on its behalf.
// =============================================================================

import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import { fetchPuntoReceipt, puntoKeys, type PuntoCollectResult, type PuntoReceipt as Receipt } from './puntoApi';
import { formatDateTime } from './puntoUi';

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="punto-receipt-line" style={strong ? { fontWeight: 700 } : undefined}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The short text sent through WhatsApp. */
function whatsappText(r: Receipt, t: TFunction): string {
  const fmt = (v: number | string | null) => formatMoney(v, r.currency);
  const lines = [
    r.isp.name,
    r.status === 'voided' ? t('punto.receipt.voided') : '',
    t('punto.receipt.waNumber', { number: r.receipt_number, date: formatDateTime(r.issued_at) }),
    t('punto.receipt.waClient', { number: r.client.number, name: r.client.name }),
    t('punto.receipt.waPaid', { amount: fmt(r.amount) }),
  ];
  if (r.remaining_balance !== null && r.remaining_balance !== undefined) {
    lines.push(t('punto.receipt.waRemaining', { amount: fmt(r.remaining_balance) }));
  }
  lines.push(r.legend);
  return lines.filter(Boolean).join('\n');
}

export function PuntoReceipt() {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const result = (useLocation().state as { result?: PuntoCollectResult } | null)?.result;
  const q = useQuery({ queryKey: puntoKeys.receipt(id), queryFn: () => fetchPuntoReceipt(id), enabled: valid });

  if (!valid || (q.error instanceof ApiRequestError && q.error.status === 404)) {
    return <EmptyState message={t('punto.receipt.notFound')} />;
  }
  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data) return <ErrorState message={t('punto.receipt.loadError')} onRetry={() => { void q.refetch(); }} />;

  const r = q.data;
  const fmt = (v: number | string | null) => formatMoney(v, r.currency);
  const method = t(`punto.receipt.methods.${r.payment_method}`, { defaultValue: r.payment_method });
  const wa = `https://wa.me/?text=${encodeURIComponent(whatsappText(r, t))}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {result && (
        <div className="punto-no-print" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p role="status" style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 600 }}>
            {t('punto.receipt.done', { amount: fmt(r.amount) })}
          </p>
          {result.reconnected && (
            <p style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {t('punto.receipt.reconnected')}
            </p>
          )}
        </div>
      )}

      <article className="punto-card punto-receipt" aria-label={t('punto.receipt.title')}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>{r.isp.name}</div>
          {r.isp.rfc && <div>{t('punto.receipt.rfc', { rfc: r.isp.rfc })}</div>}
          {r.isp.address && <div>{r.isp.address}</div>}
          {r.isp.phone && <div>{t('punto.receipt.phone', { phone: r.isp.phone })}</div>}
        </div>
        <hr />
        <div style={{ textAlign: 'center', fontWeight: 700 }}>{t('punto.receipt.title')}</div>
        {r.status === 'voided' && (
          <div role="status" style={{ textAlign: 'center', fontWeight: 700, color: 'var(--danger)' }}>{t('punto.receipt.voided')}</div>
        )}
        <Line label={t('punto.receipt.number')} value={r.receipt_number} />
        <Line label={t('punto.receipt.date')} value={formatDateTime(r.issued_at)} />
        <Line label={t('punto.receipt.collectedBy')} value={r.collected_by.reseller_name} />
        {r.collected_by.user_name && <Line label={t('punto.receipt.cashier')} value={r.collected_by.user_name} />}
        <hr />
        <Line label={t('punto.receipt.client')} value={`#${r.client.number}`} />
        <div>{r.client.name}</div>
        <hr />
        {r.allocations.map((a, i) => (
          <Line key={`${a.invoice_number ?? ''}-${i}`} label={a.invoice_number || t('punto.receipt.invoice')} value={fmt(a.amount)} />
        ))}
        {r.allocations.length > 0 && <hr />}
        <Line label={t('punto.receipt.total')} value={fmt(r.amount)} strong />
        <Line label={t('punto.receipt.method')} value={method} />
        {r.remaining_balance !== null && r.remaining_balance !== undefined && (
          <Line label={t('punto.receipt.remaining')} value={fmt(r.remaining_balance)} />
        )}
        <hr />
        <p style={{ margin: 0, fontSize: '0.8rem' }}>{r.legend}</p>
      </article>

      <div className="punto-no-print" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button type="button" className="punto-btn-primary" onClick={() => window.print()}>{t('punto.receipt.print')}</button>
        <a className="punto-btn-secondary" href={wa} target="_blank" rel="noopener noreferrer">{t('punto.receipt.whatsapp')}</a>
        <Link className="punto-btn-secondary" to="/punto/cobrar">{t('punto.receipt.newCollection')}</Link>
        <Link to="/punto/caja" style={{ textAlign: 'center', fontSize: '0.9rem' }}>{t('punto.receipt.toCash')}</Link>
      </div>
    </div>
  );
}
