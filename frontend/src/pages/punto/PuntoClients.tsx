// =============================================================================
// Reseller app (/punto) — Clientes
// =============================================================================
// The reseller's own clients (and its sub-resellers'), from
// GET /reseller-app/clients. The server limits the list to the subtree.
// =============================================================================

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatMoney } from '@/lib/money';
import { fetchPuntoClients, puntoKeys, toNumber } from './puntoApi';
import { Chip, StatusChip, pageTitle, usePuntoCurrency } from './puntoUi';

const PAGE_SIZE = 20;
const STATUSES = ['', 'active', 'suspended', 'inactive'] as const;

export function PuntoClients() {
  const { t } = useTranslation();
  const currency = usePuntoCurrency();
  const [params, setParams] = useSearchParams();
  const status = STATUSES.includes(params.get('status') as typeof STATUSES[number]) ? params.get('status') ?? '' : '';
  // From the "overdue" card on Inicio: only clients with an overdue invoice.
  const overdue = params.get('overdue') === '1';
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Search after the typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(input.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [input]);

  const list = useQuery({
    queryKey: puntoKeys.clients(search, status, overdue, page),
    queryFn: () => fetchPuntoClients({ search, status, overdue, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  function setStatus(next: string) {
    const p = new URLSearchParams(params);
    if (next) p.set('status', next); else p.delete('status');
    setParams(p, { replace: true });
    setPage(1);
  }

  function clearOverdue() {
    const p = new URLSearchParams(params);
    p.delete('overdue');
    setParams(p, { replace: true });
    setPage(1);
  }

  const total = list.data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h1 style={{ ...pageTitle, margin: 0 }}>{t('punto.clients.title')}</h1>
        <Link to="/punto/prospectos" className="punto-btn-secondary">{t('punto.clients.leads')}</Link>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div className="punto-field" style={{ flex: 1, marginBottom: 0 }}>
          <label htmlFor="punto-client-search">{t('punto.clients.search')}</label>
          <input
            id="punto-client-search"
            type="search"
            value={input}
            placeholder={t('punto.clients.searchPlaceholder')}
            onChange={e => setInput(e.target.value)}
          />
        </div>
        <div className="punto-field" style={{ width: 130, marginBottom: 0 }}>
          <label htmlFor="punto-client-status">{t('punto.clients.status')}</label>
          <select id="punto-client-status" value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => (
              <option key={s || 'all'} value={s}>{s ? t(`punto.status.${s}`) : t('punto.clients.allStatuses')}</option>
            ))}
          </select>
        </div>
      </div>

      {overdue && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <Chip tone="danger">{t('punto.clients.overdueOnly')}</Chip>
          <button type="button" className="punto-btn-secondary" onClick={clearOverdue}>
            {t('punto.clients.showAll')}
          </button>
        </div>
      )}

      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message={t('punto.clients.loadError')} onRetry={() => { void list.refetch(); }} />}
      {list.data && list.data.data.length === 0 && (
        <EmptyState message={search || status || overdue ? t('punto.clients.noMatches') : t('punto.clients.empty')} />
      )}
      {list.data && list.data.data.length > 0 && (
        <ul className="punto-list">
          {list.data.data.map(c => (
            <li key={c.id}>
              <Link to={`/punto/clientes/${c.id}`} className="punto-card punto-list-link">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{c.phone || c.email || '—'}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <StatusChip status={c.status} />
                    {c.overdue && <Chip tone="danger">{t('punto.clients.overdue')}</Chip>}
                  </div>
                </div>
                <div style={{ marginTop: 6, fontSize: '0.85rem' }}>
                  {t('punto.clients.balanceDue')}:{' '}
                  <strong style={{ color: toNumber(c.balance_due) > 0 ? 'var(--danger)' : 'var(--text-primary)' }}>
                    {formatMoney(c.balance_due, currency)}
                  </strong>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.data && total > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <button type="button" className="punto-btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            {t('punto.common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('punto.common.pageOf', { page, pages })}
          </span>
          <button type="button" className="punto-btn-secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
            {t('punto.common.next')}
          </button>
        </div>
      )}
    </div>
  );
}
