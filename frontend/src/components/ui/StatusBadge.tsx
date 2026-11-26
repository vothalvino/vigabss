// =============================================================================
// VigaBSS UI — StatusBadge
// =============================================================================
// The status pill about fifty pages declared for themselves (FE-23): the same
// span, differing only in which statuses get which colours. A page passes its
// colour map; a status missing from it is grey.
// =============================================================================

import type { CSSProperties } from 'react';

export type StatusColors = Record<string, { bg: string; color: string }>;

const FALLBACK = { bg: 'var(--bg-subtle)', color: 'var(--text-secondary)' };

const SIZES: Record<'sm' | 'md', CSSProperties> = {
  sm: { padding: '2px 8px', fontSize: '0.72rem' },
  md: { padding: '3px 10px', fontSize: '0.78rem' },
};

export interface StatusBadgeProps {
  status: string;
  colors: StatusColors;
  /** md: the larger pill of a detail page's header */
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, colors, size = 'sm' }: StatusBadgeProps) {
  const s = colors[status] ?? FALLBACK;
  return (
    <span style={{ background: s.bg, color: s.color, ...SIZES[size], borderRadius: 12, fontWeight: 600, textTransform: 'capitalize' }}>
      {status}
    </span>
  );
}
