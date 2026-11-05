// =============================================================================
// Ticket AI panel: topology breadcrumb and confidence badge
// =============================================================================
// Moved out of TicketDetail.tsx, past the 1,500-line page limit
// (src/test/pageSize.test.ts), when its UI text moved into the locale files
// (FE-07).
// =============================================================================

import { useTranslation } from 'react-i18next';

export interface TopologyNode {
  id?: number;
  name?: string;
  device_id?: number;
}

export interface TopologyContext {
  cpe: TopologyNode | null;
  accessDevice: TopologyNode | null;
  backhauls: Array<{ device: TopologyNode | null; medium: string | null }>;
  coreDevice: TopologyNode | null;
  activeOutages: Array<{ id: number; device_id: number }>;
}

// ---------------------------------------------------------------------------
// Confidence badge
// ---------------------------------------------------------------------------

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  const { t } = useTranslation();
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  const color = pct >= 80 ? '#065f46' : pct >= 60 ? '#854d0e' : '#991b1b';
  const bg    = pct >= 80 ? '#d1fae5' : pct >= 60 ? '#fef9c3' : '#fee2e2';
  return (
    <span style={{
      background: bg, color,
      padding: '2px 8px', borderRadius: 10,
      fontSize: '0.72rem', fontWeight: 700,
    }}>
      {pct}{t('ui.ticketDetail.confidence')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Topology breadcrumb
// ---------------------------------------------------------------------------

export interface TopoBreadcrumbProps { topology: TopologyContext }

export function TopoBreadcrumb({ topology }: TopoBreadcrumbProps) {
  const { t } = useTranslation();
  const outagedIds = new Set(topology.activeOutages.map(o => o.device_id));

  function NodeChip({ node, role }: { node: TopologyNode | null; role: string }) {
    if (!node) return null;
    const nodeId = node.id ?? node.device_id;
    const hasOutage = nodeId !== undefined && outagedIds.has(nodeId);
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {hasOutage && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} aria-label={t('ui.ticketDetail.activeOutage')} />}
        <span style={{
          background: '#f3f4f6', color: '#374151',
          padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600,
        }}>
          {role}: {node.name ?? `#${nodeId}`}
        </span>
      </span>
    );
  }

  function MediumIcon({ medium }: { medium: string | null }) {
    if (medium === 'fiber') return <span title={t('ui.ticketDetail.fiber')}>🔵</span>;
    if (medium === 'wireless') return <span title={t('ui.ticketDetail.wireless')}>📡</span>;
    return <span>—</span>;
  }

  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}
      aria-label={t('ui.ticketDetail.topologyBreadcrumb')}
    >
      <NodeChip node={topology.cpe} role="CPE" />
      {topology.accessDevice && (
        <>
          <span style={{ color: '#9ca3af' }}>→</span>
          <NodeChip node={topology.accessDevice} role="Access" />
        </>
      )}
      {topology.backhauls.map((bh, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: '#9ca3af' }}>→</span>
          <MediumIcon medium={bh.medium} />
          <NodeChip node={bh.device} role="Backhaul" />
        </span>
      ))}
      {topology.coreDevice && (
        <>
          <span style={{ color: '#9ca3af' }}>→</span>
          <NodeChip node={topology.coreDevice} role="Core" />
        </>
      )}
    </div>
  );
}
