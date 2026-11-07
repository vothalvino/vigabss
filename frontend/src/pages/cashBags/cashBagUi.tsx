// =============================================================================
// Cash bags (staff) — small shared pieces
// =============================================================================

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { toAmount } from './cashBagsApi';

const TONE: Record<string, CSSProperties> = {
  in_stock: { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
  with_carrier: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  at_reseller: { background: 'var(--bg-subtle)', color: 'var(--text-primary)' },
  ready_for_pickup: { background: 'var(--warning-soft)', color: 'var(--warning)' },
  in_transit: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  received: { background: 'var(--success-soft)', color: 'var(--success)' },
  void: { background: 'var(--bg-subtle)', color: 'var(--text-muted)' },
  lost: { background: 'var(--danger-soft)', color: 'var(--danger)' },
};

export function BagStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span style={{ ...(TONE[status] ?? TONE.in_stock), display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
      {t(`cashBags.status.${status}`, { defaultValue: status })}
    </span>
  );
}

/** "Cuadra" / "Faltan $X" / "Sobran $X" for counted − declared. */
export function VarianceText({ variance, currency }: { variance: number | string | null | undefined; currency: string }) {
  const { t } = useTranslation();
  if (variance === null || variance === undefined || variance === '') return <span>—</span>;
  const v = Math.round(toAmount(variance) * 100) / 100;
  if (v === 0) return <span style={{ color: 'var(--success)', fontWeight: 600 }}>{t('cashBags.variance.zero')}</span>;
  return v < 0
    ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{t('cashBags.variance.short', { amount: formatMoney(-v, currency) })}</span>
    : <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{t('cashBags.variance.over', { amount: formatMoney(v, currency) })}</span>;
}

const DATETIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

export function formatMoment(value: string | null | undefined): string {
  return value ? formatDate(value, DATETIME) : '—';
}

export const mono: CSSProperties = { fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, overflowWrap: 'anywhere' };

/** Split typed serials on commas, spaces and new lines; trimmed, upper case, unique. */
export function parseSerials(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
}
