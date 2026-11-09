// =============================================================================
// Reseller app (/punto) — small shared pieces
// =============================================================================

import type { CSSProperties, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatDate } from '@/lib/dates';
import { PUNTO_MONEY_QUERIES, fetchPuntoMe, puntoKeys } from './puntoApi';

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
  completed: 'success', voided: 'neutral', open: 'info', closed: 'neutral', partial: 'warning',
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
/**
 * A collector's login (migration 011): the reseller app's cash routes
 * (reseller_app.cash) without its clients, leads and plans (reseller_app.use).
 * It collects by client number only and sees no client or prospect.
 */
export function useCollectorMode(): boolean {
  const { user } = useAuth();
  return !can(user, 'reseller_app.use') && can(user, 'reseller_app.cash');
}

export function usePuntoCurrency(): string {
  const { user } = useAuth();
  const me = useQuery({ queryKey: puntoKeys.me, queryFn: fetchPuntoMe });
  return me.data?.currency || user?.organization_currency || 'MXN';
}

/** A moment (not a calendar date) with its time, e.g. "7 nov 2026, 14:05". */
export function formatDateTime(value: string | null | undefined): string {
  return formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The local time of a moment, e.g. "14:05". */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

/** Refetch what a collection, a void or a cash-box close changes. */
export function useRefreshPuntoMoney(): () => void {
  const qc = useQueryClient();
  return () => {
    for (const queryKey of PUNTO_MONEY_QUERIES) void qc.invalidateQueries({ queryKey });
  };
}

export const pageTitle: CSSProperties = { margin: '0 0 12px', fontSize: '1.25rem', fontWeight: 700 };
export const mutedText: CSSProperties = { color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 };
export const sectionTitle: CSSProperties = { margin: '0 0 8px', fontSize: '1rem', fontWeight: 700 };
export const errorText: CSSProperties = {
  background: 'var(--danger-soft)', color: 'var(--danger)', padding: '10px 12px',
  borderRadius: 8, fontSize: '0.9rem', margin: '0 0 12px',
};
