// =============================================================================
// Carrier app (/ruta) — Recoger
// =============================================================================
// At a reseller the carrier scans (or types) the serial printed on a sealed
// bag. POST /carrier-app/pickup checks that the serial is a bag of that very
// reseller that is ready for pickup and moves it to "En camino"; any other
// serial is refused with the same 404, so the page cannot tell a typo from a
// bag of someone else. The phone's position goes along when it shares one.
// ?punto=<id> preselects the reseller (from Inicio).
// =============================================================================

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { SerialScanInput } from '@/components/SerialScanInput';
import { mutedText, pageTitle, sectionTitle } from '../punto/puntoUi';
import { RUTA_QUERIES, currentPosition, fetchRutaResellers, pickupRutaBag, rutaKeys, type RutaPickupResult } from './rutaApi';
import { byPickupFirst } from './RutaHome';

/** The reseller picker shared by Recoger and Entregar (bound to ?punto=). */
export function useRutaReseller() {
  const [params, setParams] = useSearchParams();
  const resellers = useQuery({ queryKey: rutaKeys.resellers, queryFn: fetchRutaResellers });
  const id = Number(params.get('punto'));
  const list = [...(resellers.data ?? [])].sort(byPickupFirst);
  const selected = list.find(r => r.id === id) ?? null;
  const select = (next: number | null) => setParams(next ? new URLSearchParams({ punto: String(next) }) : new URLSearchParams(), { replace: true });
  return { resellers, list, selected, select };
}

export function RutaResellerSelect({ id, label, list, value, onChange, showReady }: {
  id: string;
  label: string;
  list: { id: number; name: string; readyForPickup: number; emptyBags: number }[];
  value: number | null;
  onChange: (id: number | null) => void;
  showReady: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="punto-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={e => onChange(Number(e.target.value) || null)}>
        <option value="">{t('ruta.common.chooseReseller')}</option>
        {list.map(r => (
          <option key={r.id} value={r.id}>
            {showReady ? t('ruta.common.resellerReady', { name: r.name, count: r.readyForPickup }) : t('ruta.common.resellerEmpty', { name: r.name, count: r.emptyBags })}
          </option>
        ))}
      </select>
    </div>
  );
}

export function RutaPickup() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { resellers, list, selected, select } = useRutaReseller();
  const [error, setError] = useState('');
  const [done, setDone] = useState<RutaPickupResult[]>([]);

  const pickup = useMutation({
    mutationFn: async (serial: string) => {
      const position = await currentPosition();
      return pickupRutaBag({ reseller_id: selected!.id, serial, ...(position ?? {}) });
    },
    onSuccess: (result: RutaPickupResult) => {
      setDone(prev => [result, ...prev]);
      for (const queryKey of RUTA_QUERIES) void qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 404) setError(t('ruta.pickup.notFound'));
      else if (err instanceof ApiRequestError && err.status === 409) setError(t('ruta.pickup.conflict'));
      else if (err instanceof ApiRequestError && err.status === 403) setError(t('ruta.pickup.forbidden'));
      else setError(t('ruta.pickup.error'));
    },
  });

  function onSerial(serial: string) {
    setError('');
    if (!selected) { setError(t('ruta.common.pickReseller')); return; }
    pickup.mutate(serial);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('ruta.pickup.title')}</h1>
      {resellers.isLoading && <LoadingState />}
      {resellers.isError && <ErrorState message={t('ruta.home.loadError')} onRetry={() => { void resellers.refetch(); }} />}
      {resellers.data && list.length === 0 && <EmptyState message={t('ruta.home.noResellers')} />}
      {list.length > 0 && (
        <section className="punto-card" aria-labelledby="ruta-pickup-form">
          <h2 id="ruta-pickup-form" style={sectionTitle}>{t('ruta.pickup.formTitle')}</h2>
          <RutaResellerSelect
            id="ruta-pickup-reseller"
            label={t('ruta.common.reseller')}
            list={list}
            value={selected?.id ?? null}
            onChange={id => { setError(''); setDone([]); select(id); }}
            showReady
          />
          {selected && selected.readyForPickup === 0 && done.length === 0 && (
            <p style={{ ...mutedText, marginBottom: 12 }}>{t('ruta.pickup.noneReady')}</p>
          )}
          <SerialScanInput
            label={t('ruta.pickup.serial')}
            submitLabel={pickup.isPending ? t('ruta.pickup.checking') : t('ruta.pickup.submit')}
            help={t('ruta.pickup.help')}
            busy={pickup.isPending}
            clearOnSubmit
            error={error}
            onSerial={onSerial}
          />
        </section>
      )}
      {done.length > 0 && (
        <section className="punto-card" aria-labelledby="ruta-pickup-done" style={{ background: 'var(--success-soft)' }}>
          <h2 id="ruta-pickup-done" style={sectionTitle}>{t('ruta.pickup.doneTitle')}</h2>
          <ul className="punto-list" role="status">
            {done.map(b => (
              <li key={b.serial} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }}>{b.serial}</strong>
                <span>{t('ruta.pickup.matched')}</span>
              </li>
            ))}
          </ul>
          <Link to="/ruta/mis-bolsas" style={{ display: 'inline-block', marginTop: 8 }}>{t('ruta.pickup.toBags')}</Link>
        </section>
      )}
    </div>
  );
}
