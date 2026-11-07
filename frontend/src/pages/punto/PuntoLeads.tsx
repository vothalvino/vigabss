// =============================================================================
// Reseller app (/punto) — Prospectos
// =============================================================================
// The sign-ups this reseller (and its sub-resellers) captured, from
// GET /reseller-app/leads, with where each one stands. A converted lead links
// to its client.
// =============================================================================

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { formatDate } from '@/lib/dates';
import { fetchPuntoLeads, puntoKeys } from './puntoApi';
import { StatusChip, mutedText, pageTitle } from './puntoUi';

const PAGE_SIZE = 20;

export function PuntoLeads() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: puntoKeys.leads(page),
    queryFn: () => fetchPuntoLeads(page, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const total = q.data?.meta.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h1 style={{ ...pageTitle, margin: 0 }}>{t('punto.leads.title')}</h1>
        <Link to="/punto/nuevo" className="punto-btn-secondary">{t('punto.leads.add')}</Link>
      </div>
      <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.leads.intro')}</p>

      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('punto.leads.loadError')} onRetry={() => { void q.refetch(); }} />}
      {q.data && q.data.data.length === 0 && <EmptyState message={t('punto.leads.empty')} />}
      {q.data && q.data.data.length > 0 && (
        <ul className="punto-list">
          {q.data.data.map(l => (
            <li key={l.id} className="punto-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{l.name}</div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{l.phone || '—'}</div>
                </div>
                <StatusChip status={l.status} />
              </div>
              <div style={{ marginTop: 6, fontSize: '0.85rem', display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                <span>{t('punto.leads.plan', { plan: l.desired_plan_name || t('punto.leads.noPlan') })}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{t('punto.leads.createdAt', { date: formatDate(l.created_at) })}</span>
                {l.converted_client_id && (
                  <Link to={`/punto/clientes/${l.converted_client_id}`}>{t('punto.leads.viewClient')}</Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {q.data && total > PAGE_SIZE && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <button type="button" className="punto-btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            {t('punto.common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('punto.common.pageOf', { page, pages })}</span>
          <button type="button" className="punto-btn-secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
            {t('punto.common.next')}
          </button>
        </div>
      )}
    </div>
  );
}
