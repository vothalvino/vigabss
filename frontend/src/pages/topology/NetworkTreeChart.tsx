// =============================================================================
// VigaBSS 5.0 — the network tree as a chart
// =============================================================================
// The same trees as the list, drawn as boxes joined by lines, left to right.
// A line takes the colour of its health, so a fault and everything behind it
// can be seen at a glance. Branches open and close; in a large tree only the
// branches with a problem start open. Changes are made in the list.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { typeKey, type TreeNode } from './networkTree';
import { HEALTH_COLOR, HEALTH_QUERY_KEY, HEALTH_REFRESH_MS, fetchHealth, verdictText, type HealthState, type Verdict } from './linkHealth';
import { BOX, edgePath, layout, openByDefault, type Placed } from './treeChart';

const UNKNOWN: Verdict = { state: 'unknown', reasons: [] };
const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5];
const PAD = 14;
// Lines are drawn worst last, so a fault is never painted over where lines meet.
const DRAW_ORDER: Record<HealthState, number> = { unknown: 0, good: 1, degraded: 2, off: 3 };
const wrong = (verdict: Verdict) => verdict.state === 'degraded' || verdict.state === 'off';
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const onKey = (run: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); run(); }
};

export function NetworkTreeChart({ trees }: { trees: TreeNode[] }) {
  const { t } = useTranslation();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(3);
  const { data: health } = useQuery({ queryKey: HEALTH_QUERY_KEY, queryFn: fetchHealth, refetchInterval: HEALTH_REFRESH_MS });
  const equipmentOf = (node: TreeNode): Verdict => health?.nodes?.[String(node.id)]?.equipment ?? UNKNOWN;
  const lineOf = (node: TreeNode): Verdict => health?.nodes?.[String(node.id)]?.uplink ?? UNKNOWN;
  const troubled = (node: TreeNode) => wrong(equipmentOf(node)) || wrong(lineOf(node));
  const scale = ZOOMS[zoom];
  const control: React.CSSProperties = { cursor: 'pointer', minWidth: 30, padding: '2px 8px' };

  function box(item: Placed) {
    const { node } = item;
    const id = String(node.id);
    const equipment = equipmentOf(node);
    const chosen = selected === id;
    const flip = () => setToggled(cur => ({ ...cur, [id]: !item.open }));
    const pill = item.open ? 18 : 16 + 7 * String(item.below).length;
    return (
      <g key={id} transform={`translate(${item.x} ${item.y})`}>
        <g
          role="button" tabIndex={0} aria-pressed={chosen} data-box={id} style={{ cursor: 'pointer' }}
          aria-label={`${node.name}, ${t(typeKey(node))}. ${t('linkHealth.equipmentIs', { state: verdictText(t, equipment) })}`}
          onClick={() => setSelected(chosen ? null : id)} onKeyDown={onKey(() => setSelected(chosen ? null : id))}
        >
          <title>{node.name}</title>
          <rect
            width={BOX.width} height={BOX.height} rx={8} fill="var(--bg-card)"
            stroke={chosen ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth={chosen ? 2.5 : 1}
          />
          <circle cx={15} cy={BOX.height / 2} r={6} fill={HEALTH_COLOR[equipment.state]} />
          <text x={29} y={19} fontSize={13} fontWeight={600} fill="var(--text-primary)">{short(node.name, 23)}</text>
          <text x={29} y={35} fontSize={11} fill="var(--text-secondary)">{short(t(typeKey(node)), 27)}</text>
        </g>
        {node.children.length > 0 && (
          <g
            role="button" tabIndex={0} aria-expanded={item.open} data-toggle={id} style={{ cursor: 'pointer' }}
            aria-label={t(item.open ? 'networkTree.chart.close' : 'networkTree.chart.open', { name: node.name, count: item.below })}
            onClick={flip} onKeyDown={onKey(flip)}
          >
            <rect x={BOX.width - 6} y={BOX.height / 2 - 9} width={pill} height={18} rx={9} fill="var(--bg-card)" stroke="var(--border-strong)" />
            <text x={BOX.width - 6 + pill / 2} y={BOX.height / 2 + 4} fontSize={11} fontWeight={600} textAnchor="middle" fill="var(--text-primary)">
              {item.open ? '−' : `+${item.below}`}
            </text>
          </g>
        )}
      </g>
    );
  }

  function details(item: Placed) {
    const { node } = item;
    const rows: Array<{ key: string; label: string; verdict: Verdict }> = [{ key: 'e', label: t('linkHealth.equipment'), verdict: equipmentOf(node) }];
    if (item.parent) rows.push({ key: 'l', label: t('linkHealth.line'), verdict: lineOf(node) });
    return (
      <div role="status" style={{ marginTop: 10, padding: 10, border: '1px solid var(--border-color)', borderRadius: 8, fontSize: '0.88rem' }}>
        <strong>{node.name}</strong>
        <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>
          {t(typeKey(node))}{node.make ? ` · ${node.make}` : ''}{node.site_name ? ` · ${node.site_name}` : ''}{node.ip_address ? ` · ${node.ip_address}` : ''}
        </span>
        {item.parent && <div style={{ marginTop: 4 }}>{t('networkTree.chart.fedBy', { name: item.parent.node.name })}</div>}
        {rows.map(row => (
          <div key={row.key} style={{ borderLeft: `3px solid ${HEALTH_COLOR[row.verdict.state]}`, paddingLeft: 6, marginTop: 4 }}>
            {row.label}: {verdictText(t, row.verdict)}
            {row.verdict.top_clients && row.verdict.top_clients.length > 0 && (
              <div>{t('linkHealth.topClients', { list: row.verdict.top_clients.map(c => `${c.name} ${c.mbps} Mbps`).join(', ') })}</div>
            )}
          </div>
        ))}
        <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>{t('networkTree.chart.editInList')}</div>
      </div>
    );
  }

  function chart(tree: TreeNode) {
    const opened = openByDefault(tree, troubled);
    const placed = layout(tree, node => toggled[String(node.id)] ?? opened.has(node.id));
    const width = placed.width + PAD * 2 + 40;
    const height = placed.height + PAD * 2;
    const picked = placed.items.find(item => String(item.node.id) === selected);
    return (
      <section key={String(tree.id)} aria-label={tree.name} style={{ marginBottom: 18, padding: 12, border: '1px solid var(--border-color)', borderRadius: 8 }}>
        <div style={{ overflow: 'auto', maxHeight: '70vh' }}>
          <svg
            role="group" aria-label={t('networkTree.chart.label', { name: tree.name })}
            width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}
          >
            <g transform={`translate(${PAD} ${PAD})`}>
              {placed.items.filter(item => item.parent).sort((a, b) => DRAW_ORDER[lineOf(a.node).state] - DRAW_ORDER[lineOf(b.node).state]).map(item => (
                <path
                  key={`line-${String(item.node.id)}`} d={edgePath(item)} fill="none" strokeWidth={3} strokeLinecap="round"
                  stroke={HEALTH_COLOR[lineOf(item.node).state]} data-line={lineOf(item.node).state} data-to={String(item.node.id)}
                >
                  <title>{`${t('linkHealth.line')}: ${verdictText(t, lineOf(item.node))}`}</title>
                </path>
              ))}
              {placed.items.map(box)}
            </g>
          </svg>
        </div>
        {tree.children.length === 0 && <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('networkTree.emptyTree')}</p>}
        {picked && details(picked)}
      </section>
    );
  }

  return (
    <div>
      <div role="group" aria-label={t('networkTree.chart.zoom')} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" style={control} disabled={zoom === 0} aria-label={t('networkTree.chart.zoomOut')} onClick={() => setZoom(z => Math.max(0, z - 1))}>−</button>
        <span style={{ minWidth: 44, textAlign: 'center', fontSize: '0.85rem' }}>{Math.round(scale * 100)}%</span>
        <button type="button" style={control} disabled={zoom === ZOOMS.length - 1} aria-label={t('networkTree.chart.zoomIn')} onClick={() => setZoom(z => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
        <span style={{ marginLeft: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('networkTree.chart.hint')}</span>
      </div>
      {trees.map(chart)}
    </div>
  );
}
