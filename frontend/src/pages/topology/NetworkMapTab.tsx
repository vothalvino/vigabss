// =============================================================================
// VigaBSS 5.0 — one network on a map
// =============================================================================
// One map per main NAS. Pick a main NAS and place everything in its tree: the
// sub-NAS routers, links, OLTs, switches, battery monitors and so on. A line
// joins each piece to the equipment that feeds it (its parent in the tree).
// Equipment that is not in the tree yet is placed in the Tree tab first.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapContainer, CircleMarker, Polyline, Tooltip, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { MapTiles } from '@/components/MapTiles';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from '../crudStyles';
import { TREE_QUERY_KEY, fetchTree, flatten, typeKey, type NodeId, type TreeNode } from './networkTree';
import { HEALTH_COLOR, HEALTH_QUERY_KEY, HEALTH_REFRESH_MS, fetchHealth, verdictText, type HealthState } from './linkHealth';
import { HealthLegend } from './LinkHealthPanels';

const FALLBACK_CENTER: [number, number] = [19.4326, -99.1332];

function ClickCatcher({ enabled, onPick }: { enabled: boolean; onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click(e) { if (enabled) onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

export function NetworkMapTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canPlace = can(user, 'devices.update');
  const [chosen, setChosen] = useState<string>('');
  const [placing, setPlacing] = useState<TreeNode | null>(null);

  const { data, isLoading, isError } = useQuery({ queryKey: TREE_QUERY_KEY, queryFn: fetchTree });
  const { data: health } = useQuery({ queryKey: HEALTH_QUERY_KEY, queryFn: fetchHealth, refetchInterval: HEALTH_REFRESH_MS });
  const equipmentState = (node: TreeNode): HealthState => health?.nodes?.[String(node.id)]?.equipment.state ?? 'unknown';
  const lineState = (node: TreeNode): HealthState => health?.nodes?.[String(node.id)]?.uplink?.state ?? 'unknown';
  const placeMutation = useMutation({
    mutationFn: ({ node, lat, lng }: { node: NodeId; lat: number; lng: number }) => apiFetch('/topology/tree/position', {
      method: 'PUT', body: JSON.stringify({ node, latitude: Number(lat.toFixed(7)), longitude: Number(lng.toFixed(7)) }),
    }),
    onSuccess: () => { setPlacing(null); void qc.invalidateQueries({ queryKey: TREE_QUERY_KEY }); },
  });

  if (isLoading) return <p>{t('networkTree.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('networkTree.loadFailed')}</p>;
  if (data.trees.length === 0) return <p>{t('networkMap.noMain')}</p>;

  // With a single network there is nothing to choose.
  const main = data.trees.length === 1 ? data.trees[0] : data.trees.find(tree => String(tree.id) === chosen) ?? null;
  const members = main ? flatten([main]) : [];
  const onMap = members.filter(n => n.latitude !== null && n.longitude !== null);
  const notOnMap = members.filter(n => n.latitude === null || n.longitude === null);
  const position = new Map<NodeId, [number, number]>(onMap.map(n => [n.id, [n.latitude as number, n.longitude as number]]));
  const mainSite = main ? data.sites.find(s => s.id === main.site_id && s.latitude !== null && s.longitude !== null) : undefined;
  const points = [...position.values()];
  const start: [number, number] | null = points[0] ?? (mainSite ? [mainSite.latitude as number, mainSite.longitude as number] : null);

  return (
    <div>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t('networkMap.intro')}</p>
      {data.trees.length > 1 && (
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {t('networkMap.mainNas')}
          <select value={chosen} onChange={e => { setChosen(e.target.value); setPlacing(null); placeMutation.reset(); }} style={styles.input}>
            <option value="">{t('networkMap.choose')}</option>
            {data.trees.map(tree => <option key={String(tree.id)} value={String(tree.id)}>{tree.name}</option>)}
          </select>
        </label>
      )}

      {main && (
        <>
          <HealthLegend />
          {!start && <p>{t('networkMap.nothingPlaced', { name: main.name })}</p>}
          {placing && (
            <p style={{ padding: '8px 12px', border: '1px dashed var(--border-color, #9ca3af)', borderRadius: 8 }}>
              📍 {t('networkMap.clickToPlace', { name: placing.name })}{' '}
              <button type="button" style={{ marginLeft: 8, cursor: 'pointer' }} onClick={() => setPlacing(null)}>{t('networkTree.cancel')}</button>
            </p>
          )}
          {placeMutation.isError && <p role="alert" style={{ color: '#991b1b' }}>{(placeMutation.error as Error).message}</p>}

          <MapContainer
            key={String(main.id)}
            {...(points.length > 1 ? { bounds: points, boundsOptions: { padding: [40, 40] as [number, number] } } : { center: start ?? FALLBACK_CENTER, zoom: start ? 15 : 5 })}
            style={{ height: 520, borderRadius: 8 }}
          >
            <MapTiles />
            <ClickCatcher enabled={placing !== null} onPick={(lat, lng) => { if (placing) placeMutation.mutate({ node: placing.id, lat, lng }); }} />
            {onMap.map(node => {
              const from = node.parent_id !== null ? position.get(node.parent_id) : undefined;
              const to = position.get(node.id);
              return from && to ? <Polyline key={`line-${String(node.id)}`} positions={[from, to]} color={HEALTH_COLOR[lineState(node)]} weight={4} /> : null;
            })}
            {onMap.map(node => (
              <CircleMarker
                key={String(node.id)}
                center={position.get(node.id) as [number, number]}
                radius={placing?.id === node.id ? 11 : node.is_main ? 10 : node.kind === 'nas' ? 8 : 6}
                pathOptions={{ color: node.kind === 'nas' ? '#2563eb' : '#334155', weight: node.kind === 'nas' ? 3 : 2, fillColor: HEALTH_COLOR[equipmentState(node)], fillOpacity: 0.95 }}
                eventHandlers={canPlace ? { click: () => { placeMutation.reset(); setPlacing(node); } } : undefined}
              >
                <Tooltip>
                  {node.name} · {t(typeKey(node))}{node.site_name ? ` · ${node.site_name}` : ''}
                  {health?.nodes?.[String(node.id)] ? ` · ${verdictText(t, health!.nodes[String(node.id)].equipment)}` : ''}
                  {health?.nodes?.[String(node.id)]?.uplink ? ` · ${t('linkHealth.line')}: ${verdictText(t, health!.nodes[String(node.id)].uplink!)}` : ''}
                </Tooltip>
              </CircleMarker>
            ))}
          </MapContainer>
          {canPlace && onMap.length > 0 && <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('networkMap.moveHint')}</p>}

          {notOnMap.length > 0 && (
            <section aria-label={t('networkMap.notPlacedTitle')}>
              <h3 style={{ marginBottom: 6 }}>{t('networkMap.notPlacedTitle')}</h3>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {notOnMap.map(node => (
                  <li key={String(node.id)} style={{ padding: '4px 0' }}>
                    <strong>{node.name}</strong>
                    <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t(typeKey(node))}{node.site_name ? ` · ${node.site_name}` : ''}</span>
                    {canPlace && (
                      <button type="button" style={{ marginLeft: 10, cursor: 'pointer', fontSize: '0.78rem' }} onClick={() => { placeMutation.reset(); setPlacing(node); }}>
                        {t('networkMap.placeOnMap')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
