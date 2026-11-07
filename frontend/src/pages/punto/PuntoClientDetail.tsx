// =============================================================================
// Reseller app (/punto) — one client
// =============================================================================
// GET /reseller-app/clients/:id: contact details, contracts with their plan,
// and the latest invoices. A client outside the reseller's subtree is a 404.
// =============================================================================

import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { fetchPuntoClient, puntoKeys, toNumber } from './puntoApi';
import { StatusChip, mutedText, pageTitle, usePuntoCurrency } from './puntoUi';

const sectionTitle = { margin: '0 0 8px', fontSize: '1rem', fontWeight: 700 } as const;
const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } as const;

export function PuntoClientDetail() {
  const { t } = useTranslation();
  const currency = usePuntoCurrency();
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const q = useQuery({ queryKey: puntoKeys.client(id), queryFn: () => fetchPuntoClient(id), enabled: valid });

  const back = <Link to="/punto/clientes" style={{ fontSize: '0.9rem' }}>{t('punto.clientDetail.back')}</Link>;

  if (!valid || (q.error instanceof ApiRequestError && q.error.status === 404)) {
    return <div>{back}<EmptyState message={t('punto.clientDetail.notFound')} /></div>;
  }
  if (q.isLoading) return <div>{back}<LoadingState /></div>;
  if (q.isError || !q.data) {
    return <div>{back}<ErrorState message={t('punto.clientDetail.loadError')} onRetry={() => { void q.refetch(); }} /></div>;
  }

  const c = q.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {back}
      <div className="punto-card">
        <div style={row}>
          <h1 style={{ ...pageTitle, margin: 0 }}>{c.name}</h1>
          <StatusChip status={c.status} />
        </div>
        <dl style={{ margin: '10px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '0.9rem' }}>
          <dt style={mutedText}>{t('punto.clientDetail.phone')}</dt>
          <dd style={{ margin: 0 }}>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : '—'}</dd>
          <dt style={mutedText}>{t('punto.clientDetail.email')}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-all' }}>{c.email || '—'}</dd>
          <dt style={mutedText}>{t('punto.clientDetail.address')}</dt>
          <dd style={{ margin: 0 }}>{[c.address, c.city].filter(Boolean).join(', ') || '—'}</dd>
          <dt style={mutedText}>{t('punto.clientDetail.balanceDue')}</dt>
          <dd style={{ margin: 0, fontWeight: 700, color: toNumber(c.balance_due) > 0 ? 'var(--danger)' : undefined }}>
            {formatMoney(c.balance_due, currency)}
          </dd>
        </dl>
      </div>

      <section className="punto-card" aria-labelledby="punto-contracts">
        <h2 id="punto-contracts" style={sectionTitle}>{t('punto.clientDetail.contracts')}</h2>
        {c.contracts.length === 0 ? <p style={mutedText}>{t('punto.clientDetail.noContracts')}</p> : (
          <ul className="punto-list">
            {c.contracts.map(k => (
              <li key={k.id} style={row}>
                <div>
                  <div style={{ fontWeight: 600 }}>{k.plan_name || t('punto.clientDetail.noPlan')}</div>
                  <div style={mutedText}>{t('punto.clientDetail.monthly', { amount: formatMoney(k.monthly_price, currency) })}</div>
                </div>
                <StatusChip status={k.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="punto-card" aria-labelledby="punto-invoices">
        <h2 id="punto-invoices" style={sectionTitle}>{t('punto.clientDetail.invoices')}</h2>
        {c.invoices.length === 0 ? <p style={mutedText}>{t('punto.clientDetail.noInvoices')}</p> : (
          <ul className="punto-list">
            {c.invoices.map(inv => (
              <li key={inv.id} style={{ ...row, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{inv.invoice_number || `#${inv.id}`}</div>
                  <div style={mutedText}>{t('punto.clientDetail.dueDate', { date: formatDate(inv.due_date) })}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <StatusChip status={inv.status} />
                  <span style={{ fontSize: '0.85rem' }}>
                    {t('punto.clientDetail.invoiceBalance', { balance: formatMoney(inv.balance, currency), total: formatMoney(inv.total, currency) })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
