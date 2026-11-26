// =============================================================================
// VigaBSS 5.0 — a contract's connection, checked hop by hop
// =============================================================================
// From the customer's equipment up to the main NAS: each piece and the line
// that feeds it, in the same colours as the network tree, with one conclusion
// in words about where a fault is. Run on demand, since it reads the whole
// network's health.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { HEALTH_COLOR, verdictText, type HealthState, type Reason, type Verdict } from '../topology/linkHealth';

interface Hop {
  role: 'customer' | 'access' | 'network';
  device_id: number | null;
  name: string | null;
  type: string;
  is_main?: boolean;
  equipment: Verdict;
  line: Verdict | null;
}
interface Finding { side: string; state: HealthState; part: 'equipment' | 'line' | 'plan'; device_id: number | null; name: string | null; reasons: Reason[]; top_clients?: Array<{ device_id: number; name: string; mbps: number }> }
export interface NetworkPath {
  technology: 'wisp' | 'ftth';
  hops: Hop[];
  saturation: { mbps: number; plan_mbps: number; pct: number; full: boolean } | null;
  findings: Finding[];
  conclusion: { side: string; state: HealthState };
  reaches_main_nas: boolean;
  gaps: string[];
  checked_at: string;
}

const card: React.CSSProperties = { border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 8, padding: 14, margin: '14px 0' };

export function ContractNetworkPath({ contractId, canKeep = false }: { contractId: number | string; canKeep?: boolean }) {
  const { t } = useTranslation();
  const [asked, setAsked] = useState(false);
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['contract-network-path', String(contractId)],
    queryFn: async () => (await apiFetch<{ data: NetworkPath }>(`/contracts/${contractId}/network-path`)).data,
    enabled: asked,
  });

  // Keeping a check stores what was measured at this moment, for a ticket or
  // a later look; a fault of ours is linked to its incident.
  const keep = useMutation({
    mutationFn: () => apiFetch<{ data: { check_id: number } }>(`/contracts/${contractId}/connection-checks`, { method: 'POST', body: JSON.stringify({}) }),
  });

  const gapText = (gap: string) => {
    const [code, id] = gap.split(':');
    const name = id ? data?.hops.find(h => String(h.device_id) === id)?.name ?? id : '';
    return t(`customerPath.gaps.${code}`, { name, defaultValue: gap });
  };

  return (
    <section style={card} aria-labelledby="contract-network-path-title">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 id="contract-network-path-title" style={{ margin: 0 }}>{t('customerPath.title')}</h3>
        <button type="button" disabled={isFetching} onClick={() => { if (asked) void refetch(); else setAsked(true); }} style={{ cursor: 'pointer' }}>
          {isFetching ? t('customerPath.checking') : data ? t('customerPath.checkAgain') : t('customerPath.check')}
        </button>
      </div>
      {!asked && <p style={{ margin: '8px 0 0', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{t('customerPath.intro')}</p>}
      {isError && <p role="alert" style={{ color: 'var(--danger)' }}>{t('customerPath.failed')}</p>}

      {data && (
        <>
          <p role="status" style={{ margin: '10px 0', padding: '8px 12px', borderLeft: `5px solid ${HEALTH_COLOR[data.conclusion.state]}`, fontWeight: 600 }}>
            {t(`customerPath.sides.${data.conclusion.side}`)}
          </p>

          {data.findings.length > 0 && (
            <ul aria-label={t('customerPath.findings')} style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: '0.88rem' }}>
              {data.findings.map((f, i) => (
                <li key={`${f.side}-${f.part}-${String(f.device_id)}-${i}`}>
                  <strong>{f.name ?? t('customerPath.customerEquipment')}</strong>
                  {' '}({t(`customerPath.parts.${f.part}`)}): {verdictText(t, { state: f.state, reasons: f.reasons })}
                  {f.top_clients && f.top_clients.length > 0 && (
                    <div>{t('linkHealth.topClients', { list: f.top_clients.map(c => `${c.name} ${c.mbps} Mbps`).join(', ') })}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <ol aria-label={t('customerPath.path')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.hops.map((hop, i) => (
              <li key={`${hop.role}-${String(hop.device_id)}-${i}`} data-equipment={hop.equipment.state} data-line={hop.line?.state ?? 'none'} style={{ padding: '4px 0' }}>
                <span
                  role="img" aria-label={t('linkHealth.equipmentIs', { state: verdictText(t, hop.equipment) })} title={verdictText(t, hop.equipment)}
                  style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8, background: HEALTH_COLOR[hop.equipment.state] }}
                />
                <strong>{hop.name ?? t('customerPath.customerEquipment')}</strong>
                <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {t(`customerPath.roles.${hop.role}`)} · {hop.is_main ? t('networkTree.types.mainNas') : t(`networkTree.types.${hop.type}`)}
                </span>
                {hop.line && (
                  <div style={{ margin: '3px 0 0 3px', paddingLeft: 12, borderLeft: `4px solid ${HEALTH_COLOR[hop.line.state]}`, fontSize: '0.8rem' }}>
                    {t(hop.role === 'customer' ? 'customerPath.lineToUs' : 'linkHealth.line')}: {verdictText(t, hop.line)}
                  </div>
                )}
              </li>
            ))}
          </ol>

          {data.saturation && (
            <p style={{ fontSize: '0.88rem', margin: '10px 0 0' }}>
              {t('customerPath.usage', { mbps: data.saturation.mbps, plan: data.saturation.plan_mbps, pct: data.saturation.pct })}
            </p>
          )}
          {canKeep && <p style={{ margin: '10px 0 0' }}>
            <button type="button" disabled={keep.isPending || keep.isSuccess} onClick={() => keep.mutate()} style={{ cursor: 'pointer' }}>
              {keep.isSuccess ? t('customerPath.kept') : t('customerPath.keep')}
            </button>
            {keep.isError && <span role="alert" style={{ color: 'var(--danger)', marginLeft: 8 }}>{(keep.error as Error).message}</span>}
          </p>}
          {data.gaps.length > 0 && (
            <div style={{ marginTop: 10, fontSize: '0.85rem' }}>
              <strong>{t('customerPath.notChecked')}</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{data.gaps.map(gap => <li key={gap}>{gapText(gap)}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
