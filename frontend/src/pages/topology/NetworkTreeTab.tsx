// =============================================================================
// VigaBSS 5.0 — the network as a simple tree
// =============================================================================
// One tree per main NAS: what it feeds is listed under it, branch by branch.
// An ISP with several networks or origins marks several NAS routers as main
// and picks which tree to look at. Equipment not placed yet is listed below
// the trees with a "place under" choice, so nothing is hidden.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from '../crudStyles';
import { TREE_QUERY_KEY, branchIds, fetchTree, flatten, typeKey, type NodeId, type TreeNode } from './networkTree';
import { HEALTH_COLOR, HEALTH_QUERY_KEY, HEALTH_REFRESH_MS, fetchHealth, verdictText, type Verdict } from './linkHealth';
import { HealthLegend, HealthLimits, UplinkForm } from './LinkHealthPanels';
import { NetworkTreeChart } from './NetworkTreeChart';

const UNKNOWN: Verdict = { state: 'unknown', reasons: [] };
type View = 'list' | 'chart';
const VIEW_KEY = 'vigabss.networkTree.view';

/** The view chosen last time; otherwise the chart, or the list on a phone. */
function firstView(): View {
  try {
    const kept = window.localStorage.getItem(VIEW_KEY);
    if (kept === 'list' || kept === 'chart') return kept;
  } catch { /* storage is not available: fall through */ }
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches ? 'chart' : 'list';
}

export function NetworkTreeTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEdit = can(user, 'devices.update');
  const [network, setNetwork] = useState<string>('');
  const [moving, setMoving] = useState<NodeId | null>(null);
  const [target, setTarget] = useState<string>('');
  const [lining, setLining] = useState<NodeId | null>(null);
  const [view, setView] = useState<View>(firstView);
  const choose = (next: View) => {
    setView(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* the choice just is not kept */ }
  };

  const { data, isLoading, isError } = useQuery({ queryKey: TREE_QUERY_KEY, queryFn: fetchTree });
  // Colours are a second, slower-changing read: the tree shows without them.
  const { data: health } = useQuery({ queryKey: HEALTH_QUERY_KEY, queryFn: fetchHealth, refetchInterval: HEALTH_REFRESH_MS });
  const equipmentOf = (node: TreeNode): Verdict => health?.nodes?.[String(node.id)]?.equipment ?? UNKNOWN;
  const lineOf = (node: TreeNode): Verdict => health?.nodes?.[String(node.id)]?.uplink ?? UNKNOWN;
  const done = () => { setMoving(null); setTarget(''); void qc.invalidateQueries({ queryKey: TREE_QUERY_KEY }); };

  const parentMutation = useMutation({
    mutationFn: ({ node, parent }: { node: NodeId; parent: NodeId | null }) => apiFetch('/topology/tree/parent', {
      method: 'PUT', body: JSON.stringify({ node, parent }),
    }),
    onSuccess: done,
  });
  const mainMutation = useMutation({
    mutationFn: ({ nasId, main }: { nasId: number; main: boolean }) => apiFetch(`/topology/tree/main-nas/${nasId}`, {
      method: 'PUT', body: JSON.stringify({ main }),
    }),
    onSuccess: done,
  });
  const failure = (parentMutation.error ?? mainMutation.error) as Error | null;
  const busy = parentMutation.isPending || mainMutation.isPending;

  if (isLoading) return <p>{t('networkTree.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('networkTree.loadFailed')}</p>;

  const placed = flatten(data.trees);
  const shown = network ? data.trees.filter(tree => String(tree.id) === network) : data.trees;
  const label = (node: TreeNode) => `${node.name} (${t(typeKey(node))})`;

  function moveForm(node: TreeNode) {
    const blocked = branchIds(node);
    const options = placed.filter(p => !blocked.has(p.id));
    return (
      <form
        onSubmit={e => { e.preventDefault(); if (target) parentMutation.mutate({ node: node.id, parent: Number(target) }); }}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' }}
      >
        <select value={target} onChange={e => setTarget(e.target.value)} style={{ ...styles.input, minWidth: 220 }} aria-label={t('networkTree.placeUnder', { name: node.name })}>
          <option value="">{t('networkTree.choose')}</option>
          {options.map(o => <option key={String(o.id)} value={String(o.id)}>{label(o)}</option>)}
        </select>
        <button type="submit" disabled={!target || busy} style={{ ...styles.input, cursor: 'pointer', fontWeight: 600 }}>{t('networkTree.save')}</button>
        <button type="button" onClick={() => { setMoving(null); setTarget(''); }} style={{ ...styles.input, cursor: 'pointer' }}>{t('networkTree.cancel')}</button>
        {options.length === 0 && <span>{t('networkTree.noParents')}</span>}
      </form>
    );
  }

  function actions(node: TreeNode, inTree: boolean) {
    if (!canEdit) return null;
    const small: React.CSSProperties = { cursor: 'pointer', fontSize: '0.78rem', padding: '2px 8px' };
    return (
      <span style={{ display: 'inline-flex', gap: 6, marginLeft: 10, flexWrap: 'wrap' }}>
        {!node.is_main && (
          <button type="button" style={small} disabled={busy} onClick={() => { setMoving(node.id); setTarget(''); parentMutation.reset(); mainMutation.reset(); }}>
            {inTree ? t('networkTree.move') : t('networkTree.place')}
          </button>
        )}
        {inTree && !node.is_main && (
          <button type="button" style={small} disabled={busy} onClick={() => parentMutation.mutate({ node: node.id, parent: null })}>{t('networkTree.takeOut')}</button>
        )}
        {inTree && !node.is_main && typeof node.id === 'number' && (
          <button type="button" style={small} onClick={() => setLining(cur => (cur === node.id ? null : node.id))}>{t('linkHealth.lineButton')}</button>
        )}
        {node.kind === 'nas' && node.nas_id !== undefined && (
          <button type="button" style={small} disabled={busy} onClick={() => mainMutation.mutate({ nasId: node.nas_id as number, main: !node.is_main })}>
            {node.is_main ? t('networkTree.unmarkMain') : t('networkTree.markMain')}
          </button>
        )}
      </span>
    );
  }

  // What is wrong, in words, under the row: colour alone is not enough.
  function notes(node: TreeNode, inTree: boolean) {
    const lines: Array<{ key: string; label: string; verdict: Verdict }> = [];
    const equipment = equipmentOf(node);
    if (equipment.state === 'degraded' || equipment.state === 'off') lines.push({ key: 'e', label: t('linkHealth.equipment'), verdict: equipment });
    const line = lineOf(node);
    if (inTree && !node.is_main && (line.state === 'degraded' || line.state === 'off')) lines.push({ key: 'l', label: t('linkHealth.line'), verdict: line });
    if (lines.length === 0) return null;
    return (
      <div style={{ margin: '2px 0 0 18px', fontSize: '0.8rem' }}>
        {lines.map(item => (
          <div key={item.key} style={{ borderLeft: `3px solid ${HEALTH_COLOR[item.verdict.state]}`, paddingLeft: 6, marginTop: 2 }}>
            {item.label}: {verdictText(t, item.verdict)}
            {item.verdict.top_clients && item.verdict.top_clients.length > 0 && (
              <div>{t('linkHealth.topClients', { list: item.verdict.top_clients.map(c => `${c.name} ${c.mbps} Mbps`).join(', ') })}</div>
            )}
          </div>
        ))}
      </div>
    );
  }

  function row(node: TreeNode, inTree: boolean) {
    return (
      <>
        <span
          role="img" aria-label={t('linkHealth.equipmentIs', { state: verdictText(t, equipmentOf(node)) })} title={verdictText(t, equipmentOf(node))}
          style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 8, background: HEALTH_COLOR[equipmentOf(node).state] }}
        />
        <strong>{node.name}</strong>
        <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t(typeKey(node))}{node.make ? ` · ${node.make}` : ''}{node.site_name ? ` · ${node.site_name}` : ''}{node.ip_address ? ` · ${node.ip_address}` : ''}
        </span>
        {actions(node, inTree)}
        {notes(node, inTree)}
        {moving === node.id && moveForm(node)}
        {lining === node.id && typeof node.id === 'number' && <UplinkForm deviceId={node.id} name={node.name} onDone={() => setLining(null)} />}
      </>
    );
  }

  function branch(nodes: TreeNode[]) {
    if (nodes.length === 0) return null;
    return (
      <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 22 }}>
        {nodes.map(node => (
          <li
            key={String(node.id)}
            data-line={lineOf(node).state}
            title={`${t('linkHealth.line')}: ${verdictText(t, lineOf(node))}`}
            style={{ padding: '5px 0 5px 10px', borderLeft: `4px solid ${HEALTH_COLOR[lineOf(node).state]}`, marginBottom: 2 }}
          >
            {row(node, true)}
            {branch(node.children)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t('networkTree.intro')}</p>
      <div role="group" aria-label={t('networkTree.view')} style={{ display: 'inline-flex', gap: 6, marginBottom: 10 }}>
        {(['list', 'chart'] as const).map(option => (
          <button
            key={option} type="button" aria-pressed={view === option} onClick={() => choose(option)}
            style={{ ...styles.input, cursor: 'pointer', fontWeight: view === option ? 700 : 400 }}
          >
            {t(`networkTree.views.${option}`)}
          </button>
        ))}
      </div>
      <HealthLegend />
      <HealthLimits canEdit={can(user, 'settings.update')} />
      {failure && <p role="alert" style={{ color: '#991b1b' }}>{failure.message}</p>}

      {data.trees.length > 1 && (
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {t('networkTree.network')}
          <select value={network} onChange={e => setNetwork(e.target.value)} style={styles.input}>
            <option value="">{t('networkTree.allNetworks')}</option>
            {data.trees.map(tree => <option key={String(tree.id)} value={String(tree.id)}>{tree.name}</option>)}
          </select>
        </label>
      )}

      {data.trees.length === 0 && <p>{t('networkTree.noMain')}</p>}

      {view === 'chart' && <NetworkTreeChart trees={shown} />}
      {view === 'list' && shown.map(tree => (
        <section key={String(tree.id)} aria-label={tree.name} style={{ marginBottom: 18, padding: 12, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 8 }}>
          <div style={{ paddingBottom: 4 }}>{row(tree, true)}</div>
          {branch(tree.children)}
          {tree.children.length === 0 && <p style={{ margin: '6px 0 0 22px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('networkTree.emptyTree')}</p>}
        </section>
      ))}

      <h3 style={{ marginBottom: 6 }}>{t('networkTree.unplacedTitle', { count: data.unplaced.length })}</h3>
      {data.unplaced.length === 0
        ? <p>{t('networkTree.unplacedNone')}</p>
        : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.unplaced.map(node => (
              <li key={String(node.id)} style={{ padding: '5px 0' }}>
                {row(node, false)}
                {node.children.length > 0 && branch(node.children)}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
