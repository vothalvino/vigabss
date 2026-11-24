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

const STATUS_COLOR: Record<string, string> = { online: '#16a34a', offline: '#dc2626', maintenance: '#d97706' };

export function NetworkTreeTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEdit = can(user, 'devices.update');
  const [network, setNetwork] = useState<string>('');
  const [moving, setMoving] = useState<NodeId | null>(null);
  const [target, setTarget] = useState<string>('');

  const { data, isLoading, isError } = useQuery({ queryKey: TREE_QUERY_KEY, queryFn: fetchTree });
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
        {node.kind === 'nas' && node.nas_id !== undefined && (
          <button type="button" style={small} disabled={busy} onClick={() => mainMutation.mutate({ nasId: node.nas_id as number, main: !node.is_main })}>
            {node.is_main ? t('networkTree.unmarkMain') : t('networkTree.markMain')}
          </button>
        )}
      </span>
    );
  }

  function row(node: TreeNode, inTree: boolean) {
    return (
      <>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 8, background: STATUS_COLOR[node.status ?? ''] ?? '#9ca3af' }} />
        <strong>{node.name}</strong>
        <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t(typeKey(node))}{node.make ? ` · ${node.make}` : ''}{node.site_name ? ` · ${node.site_name}` : ''}{node.ip_address ? ` · ${node.ip_address}` : ''}
        </span>
        {actions(node, inTree)}
        {moving === node.id && moveForm(node)}
      </>
    );
  }

  function branch(nodes: TreeNode[]) {
    if (nodes.length === 0) return null;
    return (
      <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 22, borderLeft: '1px solid var(--border-color, #cbd5e1)' }}>
        {nodes.map(node => (
          <li key={String(node.id)} style={{ padding: '5px 0 5px 10px' }}>
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

      {shown.map(tree => (
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
