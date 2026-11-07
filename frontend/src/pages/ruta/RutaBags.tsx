// =============================================================================
// Carrier app (/ruta) — Mi ruta
// =============================================================================
// The bags the carrier holds (GET /carrier-app/bags): empty ones to drop off
// (with_carrier) and sealed ones picked up and not yet handed in to the ISP
// (in_transit, with the reseller they came from). No amounts.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import { Chip, mutedText, pageTitle, sectionTitle } from '../punto/puntoUi';
import { fetchRutaBags, rutaKeys, type RutaBag } from './rutaApi';

const mono = { fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, overflowWrap: 'anywhere' } as const;

function BagList({ id, title, empty, bags, transit }: { id: string; title: string; empty: string; bags: RutaBag[]; transit: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="punto-card" aria-labelledby={id}>
      <h2 id={id} style={sectionTitle}>{title}</h2>
      {bags.length === 0 ? <p style={mutedText}>{empty}</p> : (
        <ul className="punto-list">
          {bags.map(b => (
            <li key={b.serial} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={mono}>{b.serial}</div>
                {transit && b.resellerName && <div style={mutedText}>{t('ruta.bags.from', { name: b.resellerName })}</div>}
              </div>
              {transit ? <Chip tone="info">{t('ruta.status.in_transit')}</Chip> : <Chip>{t('ruta.status.with_carrier')}</Chip>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RutaBags() {
  const { t } = useTranslation();
  const bags = useQuery({ queryKey: rutaKeys.bags, queryFn: fetchRutaBags });
  const all = bags.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1 style={{ ...pageTitle, margin: 0 }}>{t('ruta.bags.title')}</h1>
      {bags.isLoading && <LoadingState />}
      {bags.isError && <ErrorState message={t('ruta.bags.loadError')} onRetry={() => { void bags.refetch(); }} />}
      {bags.data && (
        <>
          <BagList
            id="ruta-bags-transit"
            title={t('ruta.bags.transitTitle', { count: all.filter(b => b.status === 'in_transit').length })}
            empty={t('ruta.bags.noTransit')}
            bags={all.filter(b => b.status === 'in_transit')}
            transit
          />
          <BagList
            id="ruta-bags-stock"
            title={t('ruta.bags.stockTitle', { count: all.filter(b => b.status === 'with_carrier').length })}
            empty={t('ruta.bags.noStock')}
            bags={all.filter(b => b.status === 'with_carrier')}
            transit={false}
          />
          <p style={mutedText}>{t('ruta.bags.handIn')}</p>
        </>
      )}
    </div>
  );
}
