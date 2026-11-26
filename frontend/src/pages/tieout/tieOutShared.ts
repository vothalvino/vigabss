// Shared pieces of the money tie-out page.
import type { CSSProperties } from 'react';
import type { paths } from '@/api/schema';

export type TieOutReport = NonNullable<paths['/money-tieout']['get']['responses'][200]['content']['application/json']['data']>;
export type BankAccountRow = NonNullable<NonNullable<TieOutReport['bank']>['accounts']>[number];
export type SafeMovementRow = NonNullable<paths['/money-tieout/safe-movements']['get']['responses'][200]['content']['application/json']['data']>[number];

export const TIEOUT_KEY = ['money-tieout'] as const;

export const card: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem 1.1rem',
};
export const cardTitle: CSSProperties = { margin: '0 0 0.6rem', fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' };
export const hint: CSSProperties = { margin: '0 0 0.6rem', fontSize: '0.8rem', color: 'var(--text-muted)' };
export const input: CSSProperties = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-body)',
  color: 'var(--text-primary)', fontSize: '0.85rem', minWidth: 0,
};
export const button: CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.82rem',
};
export const primaryButton: CSSProperties = { ...button, background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--bg-card)' };
export const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 };
export const td: CSSProperties = { padding: '6px 8px', fontSize: '0.85rem', borderTop: '1px solid var(--border)', color: 'var(--text-primary)' };

export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Wait for a tie-out request; throws the server's message on a refusal. */
export async function done(request: Promise<Response>): Promise<void> {
  const res = await request;
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(parsed.error?.message || `${res.status}`);
  }
}
