// =============================================================================
// Carrier app (/ruta) — Entregar bolsas vacías
// =============================================================================
// The carrier leaves empty bags from its stock at a reseller: choose the
// reseller, scan or type each serial (or tap it in the stock list), then
// POST /carrier-app/dropoff. The server takes all of them or none and names
// the serials that are not in the carrier's stock (422); those stay marked
// in the list so the carrier can remove them and try again.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { SerialScanInput } from '@/components/SerialScanInput';
import { errorText, mutedText, pageTitle, sectionTitle } from '../punto/puntoUi';
import { RUTA_QUERIES, dropoffRutaBags, failedSerials, fetchRutaBags, rutaKeys, type RutaDropoffResult } from './rutaApi';
import { RutaResellerSelect, useRutaReseller } from './RutaPickup';

export const DROPOFF_MAX = 50;
const mono = { fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' } as const;

export function RutaDropoff() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { resellers, list, selected, select } = useRutaReseller();
  const bags = useQuery({ queryKey: rutaKeys.bags, queryFn: fetchRutaBags });
  const stock = (bags.data ?? []).filter(b => b.status === 'with_carrier');
  const [serials, setSerials] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ name: string; serials: string[] } | null>(null);

  const dropoff = useMutation({
    mutationFn: () => dropoffRutaBags({ reseller_id: selected!.id, serials }),
    onSuccess: (result: RutaDropoffResult) => {
      setDone({ name: selected?.name ?? '', serials: result.serials.length ? result.serials : serials });
      setSerials([]);
      setFailed([]);
      for (const queryKey of RUTA_QUERIES) void qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      const bad = failedSerials(err);
      setFailed(bad);
      if (err instanceof ApiRequestError && (err.status === 422 || err.status === 409) && bad.length) setError(t('ruta.dropoff.someFailed', { serials: bad.join(', ') }));
      else if (err instanceof ApiRequestError && err.status === 404) setError(t('ruta.dropoff.notAssigned'));
      else if (err instanceof ApiRequestError && err.status === 422) setError(t('ruta.dropoff.refused'));
      else setError(t('ruta.dropoff.error'));
    },
  });

  function add(serial: string) {
    setError('');
    setDone(null);
    if (serials.includes(serial)) { setError(t('ruta.dropoff.already', { serial })); return; }
    if (serials.length >= DROPOFF_MAX) { setError(t('ruta.dropoff.tooMany', { max: DROPOFF_MAX })); return; }
    setSerials(prev => [...prev, serial]);
  }

  function remove(serial: string) {
    setSerials(prev => prev.filter(s => s !== serial));
    setFailed(prev => prev.filter(s => s !== serial));
  }

  function submit() {
    setError('');
    if (!selected) { setError(t('ruta.common.pickReseller')); return; }
    if (serials.length === 0) { setError(t('ruta.dropoff.none')); return; }
    dropoff.mutate();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('ruta.dropoff.title')}</h1>
      {resellers.isLoading && <LoadingState />}
      {resellers.isError && <ErrorState message={t('ruta.home.loadError')} onRetry={() => { void resellers.refetch(); }} />}
      {resellers.data && list.length === 0 && <EmptyState message={t('ruta.home.noResellers')} />}
      {done && (
        <div role="status" className="punto-card" style={{ background: 'var(--success-soft)' }}>
          <strong>{t('ruta.dropoff.done', { count: done.serials.length, name: done.name })}</strong>
          <p style={{ ...mutedText, ...mono, marginTop: 4 }}>{done.serials.join(', ')}</p>
        </div>
      )}
      {list.length > 0 && (
        <section className="punto-card" aria-labelledby="ruta-dropoff-form">
          <h2 id="ruta-dropoff-form" style={sectionTitle}>{t('ruta.dropoff.formTitle')}</h2>
          <RutaResellerSelect
            id="ruta-dropoff-reseller"
            label={t('ruta.common.reseller')}
            list={list}
            value={selected?.id ?? null}
            onChange={id => { setError(''); setDone(null); select(id); }}
            showReady={false}
          />
          <SerialScanInput
            label={t('ruta.dropoff.serial')}
            submitLabel={t('ruta.dropoff.add')}
            help={t('ruta.dropoff.help')}
            clearOnSubmit
            onSerial={add}
          />
        </section>
      )}

      {serials.length > 0 && (
        <section className="punto-card" aria-labelledby="ruta-dropoff-list">
          <h2 id="ruta-dropoff-list" style={sectionTitle}>{t('ruta.dropoff.listTitle', { count: serials.length })}</h2>
          <ul className="punto-list">
            {serials.map(s => (
              <li key={s} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span style={{ ...mono, color: failed.includes(s) ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                  {s}{failed.includes(s) ? ` · ${t('ruta.dropoff.notInStock')}` : ''}
                </span>
                <button type="button" className="punto-btn-secondary" style={{ minHeight: 36 }} onClick={() => remove(s)} aria-label={t('ruta.dropoff.removeSerial', { serial: s })}>
                  {t('ruta.dropoff.remove')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <p role="alert" style={errorText}>{error}</p>}
      {list.length > 0 && (
        <button type="button" className="punto-btn-primary" disabled={dropoff.isPending || serials.length === 0} onClick={submit}>
          {dropoff.isPending ? t('ruta.dropoff.saving') : t('ruta.dropoff.submit', { count: serials.length })}
        </button>
      )}

      <section className="punto-card" aria-labelledby="ruta-dropoff-stock">
        <h2 id="ruta-dropoff-stock" style={sectionTitle}>{t('ruta.dropoff.stockTitle')}</h2>
        {bags.isLoading && <LoadingState />}
        {bags.isError && <ErrorState message={t('ruta.bags.loadError')} onRetry={() => { void bags.refetch(); }} />}
        {bags.data && stock.length === 0 && <p style={mutedText}>{t('ruta.dropoff.noStock')}</p>}
        {stock.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {stock.map(b => (
              <button
                key={b.serial}
                type="button"
                className="punto-btn-secondary"
                style={{ width: 'auto', minHeight: 40, ...mono }}
                aria-pressed={serials.includes(b.serial)}
                onClick={() => (serials.includes(b.serial) ? remove(b.serial) : add(b.serial))}
              >
                {b.serial}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
