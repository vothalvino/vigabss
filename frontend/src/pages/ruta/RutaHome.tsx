// =============================================================================
// Carrier app (/ruta) — Inicio
// =============================================================================
// The carrier's day: how many bags it holds (empty stock and picked up) and
// the resellers assigned to it (GET /carrier-app/resellers), those with bags
// ready for pickup first. Each one shows its address, a tel: link, a map link
// when the reseller has coordinates, and "Recoger" when a bag is ready.
// =============================================================================

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { EmptyState, ErrorState, LoadingState } from '@/components/FetchStates';
import { Chip, mutedText, pageTitle } from '../punto/puntoUi';
import { fetchRutaMe, fetchRutaResellers, mapHref, rutaKeys, telHref, type RutaReseller } from './rutaApi';

/** Ready bags first, then by name. */
export function byPickupFirst(a: RutaReseller, b: RutaReseller): number {
  if ((a.readyForPickup > 0) !== (b.readyForPickup > 0)) return a.readyForPickup > 0 ? -1 : 1;
  return a.name.localeCompare(b.name, 'es');
}

function ResellerCard({ r, canPickup }: { r: RutaReseller; canPickup: boolean }) {
  const { t } = useTranslation();
  const place = [r.address, r.city].filter(Boolean).join(', ');
  return (
    <li className="punto-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, overflowWrap: 'anywhere' }}>{r.name}</h2>
        {r.readyForPickup > 0
          ? <Chip tone="warning">{t('ruta.home.ready', { count: r.readyForPickup })}</Chip>
          : <Chip>{t('ruta.home.noneReady')}</Chip>}
      </div>
      {place && <p style={{ ...mutedText, overflowWrap: 'anywhere' }}>{place}</p>}
      <p style={mutedText}>{t('ruta.home.emptyBags', { count: r.emptyBags })}</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: '0.9rem' }}>
        {r.phone && <a href={telHref(r.phone)}>{t('ruta.home.call', { phone: r.phone })}</a>}
        {r.latitude !== null && r.longitude !== null && (
          <a href={mapHref(r.latitude, r.longitude)} target="_blank" rel="noopener noreferrer">{t('ruta.home.map')}</a>
        )}
      </div>
      {canPickup && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.readyForPickup > 0 && (
            <Link to={`/ruta/recoger?punto=${r.id}`} className="punto-btn-primary" aria-label={t('ruta.home.pickupAt', { name: r.name })}>
              {t('ruta.home.pickup')}
            </Link>
          )}
          <Link to={`/ruta/entregar?punto=${r.id}`} className="punto-btn-secondary" aria-label={t('ruta.home.dropoffAt', { name: r.name })}>
            {t('ruta.home.dropoff')}
          </Link>
        </div>
      )}
    </li>
  );
}

export function RutaHome() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canPickup = can(user, 'carrier_app.pickup');
  const me = useQuery({ queryKey: rutaKeys.me, queryFn: fetchRutaMe });
  const resellers = useQuery({ queryKey: rutaKeys.resellers, queryFn: fetchRutaResellers });
  const list = [...(resellers.data ?? [])].sort(byPickupFirst);
  const readyTotal = list.reduce((acc, r) => acc + r.readyForPickup, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('ruta.home.title')}</h1>
      {me.data && (
        <section aria-label={t('ruta.home.summary')} className="punto-stats">
          <Link to="/ruta/mis-bolsas" className="punto-card punto-list-link" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '1.75rem', fontWeight: 700 }}>{me.data.stock}</span>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('ruta.home.stock')}</span>
          </Link>
          <Link to="/ruta/mis-bolsas" className="punto-card punto-list-link" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--accent)' }}>{me.data.inTransit}</span>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('ruta.home.inTransit')}</span>
          </Link>
        </section>
      )}

      <section aria-labelledby="ruta-resellers-title" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 id="ruta-resellers-title" style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>{t('ruta.home.resellersTitle')}</h2>
        {resellers.data && list.length > 0 && <p style={mutedText}>{t('ruta.home.readyTotal', { count: readyTotal })}</p>}
        {resellers.isLoading && <LoadingState />}
        {resellers.isError && <ErrorState message={t('ruta.home.loadError')} onRetry={() => { void resellers.refetch(); }} />}
        {resellers.data && list.length === 0 && <EmptyState message={t('ruta.home.noResellers')} />}
        {list.length > 0 && (
          <ul className="punto-list">
            {list.map(r => <ResellerCard key={r.id} r={r} canPickup={canPickup} />)}
          </ul>
        )}
      </section>
    </div>
  );
}
