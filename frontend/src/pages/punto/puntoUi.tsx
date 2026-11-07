// =============================================================================
// Reseller app (/punto) — small shared pieces
// =============================================================================

import type { CSSProperties, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { fetchPuntoMe, puntoKeys } from './puntoApi';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<Tone, CSSProperties> = {
  success: { background: 'var(--success-soft)', color: 'var(--success)' },
  warning: { background: 'var(--warning-soft)', color: 'var(--warning)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  info: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  neutral: { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
};

const STATUS_TONE: Record<string, Tone> = {
  active: 'success', paid: 'success', won: 'success',
  suspended: 'warning', pending: 'warning', draft: 'neutral',
  overdue: 'danger', cancelled: 'danger', terminated: 'danger', lost: 'danger', void: 'neutral',
  expired: 'neutral', inactive: 'neutral',
  new: 'info', contacted: 'info', qualified: 'info', proposal: 'info', issued: 'info', sent: 'info',
};

/** A small rounded label. */
export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span style={{
      ...TONES[tone], display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

/** A client, contract, invoice or lead status, translated. */
export function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Chip tone={STATUS_TONE[status] ?? 'neutral'}>{t(`punto.status.${status}`, { defaultValue: status })}</Chip>;
}

/** The org currency: from /reseller-app/me, else the session's. */
export function usePuntoCurrency(): string {
  const { user } = useAuth();
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });
  return me.data?.currency || user?.organization_currency || 'MXN';
}

export const pageTitle: CSSProperties = { margin: '0 0 12px', fontSize: '1.25rem', fontWeight: 700 };
export const mutedText: CSSProperties = { color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 };
export const errorText: CSSProperties = {
  background: 'var(--danger-soft)', color: 'var(--danger)', padding: '10px 12px',
  borderRadius: 8, fontSize: '0.9rem', margin: '0 0 12px',
};
